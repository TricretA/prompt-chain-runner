#!/usr/bin/env node
'use strict';
// The ORCHESTRATOR — the main agent of a small autonomous company.
//
// For every imported prompt it: sends the BUILDER agent to do the work, runs
// auto-detected checks (exit codes never lie), sends the TESTER agent to
// verify the builder's claims, routes failures back to the builder as fix
// prompts, and commits every passing phase to git. When all prompts pass, the
// DEPLOYER agent pushes the project to GitHub Pages and the orchestrator
// independently polls the public URL until the site is actually live — only
// then is the human notified. No human input from start to finish.
//
// Usage:
//   node runner.js [--queue prompts/queue.json] [--config config.json]
//                  [--logs logs] [--state state.json]
//                  [--retry-stuck] [--dry-run]
//
// Exit codes: 0 all phases passed (and deployed, if enabled) · 1 runner error
//             (incl. another runner already active) · 2 a phase or the deploy
//             is stuck · 3 stopped via stop flag or signal

const fs = require('fs');
const path = require('path');
const { readJson, runStamp, formatDuration, truncate, slugify, pidAlive, pidLooksLikeNode } = require('./lib/util');
const { Logger } = require('./lib/logger');
const { writeState } = require('./lib/state');
const { loadQueue, saveQueue } = require('./lib/queue');
const { ensureGitRepo, commitPhase } = require('./lib/git');
const { verifyPhase } = require('./lib/verify');
const { detectChecks, describeChecks } = require('./lib/autocheck');
const { killActiveClaude } = require('./lib/claude');
const { runBuilder, runBuilderFix, runTester, runDeployer } = require('./lib/agents');
const { buildFixPrompt, buildDeployFixPrompt } = require('./lib/fix-prompt');
const { waitUntilLive } = require('./lib/live-check');
const { notify } = require('./lib/notify');

const ROOT = __dirname;

function parseArgs(argv) {
  const opts = {
    queue: path.join(ROOT, 'prompts', 'queue.json'),
    config: path.join(ROOT, 'config.json'),
    logs: path.join(ROOT, 'logs'),
    state: path.join(ROOT, 'state.json'),
    retryStuck: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--queue') opts.queue = path.resolve(argv[++i]);
    else if (a === '--config') opts.config = path.resolve(argv[++i]);
    else if (a === '--logs') opts.logs = path.resolve(argv[++i]);
    else if (a === '--state') opts.state = path.resolve(argv[++i]);
    else if (a === '--retry-stuck') opts.retryStuck = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Unknown argument: ${a}`); printHelp(); process.exit(1); }
  }
  return opts;
}

function printHelp() {
  console.log(`Prompt Chain Runner — autonomous agent orchestrator
  node runner.js [options]

  --queue <file>    prompt queue (default prompts/queue.json)
  --config <file>   settings (default config.json)
  --logs <dir>      log directory (default logs/)
  --state <file>    live state file for the dashboard (default state.json)
  --retry-stuck     reset phases marked "stuck" back to pending and retry them
  --dry-run         validate config + queue and print the plan, execute nothing`);
}

// Exactly one runner per state file. Two concurrent runners would drive two
// unattended Claude Code sessions in the same working tree, cross-commit each
// other's half-finished edits, and clobber queue.json last-writer-wins.
// O_EXCL create makes the guard atomic. A lock held by a dead pid — or by a
// recycled pid that no longer looks like a Node process — is stolen, and the
// steal itself is atomic: renameSync succeeds for exactly one stealer, so two
// near-simultaneous starters can never both delete their way past the gate.
function acquireLock(lockFile) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      return null;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let otherPid = null;
      try { otherPid = parseInt(fs.readFileSync(lockFile, 'utf8'), 10); } catch { /* unreadable = stale */ }
      if (otherPid && pidAlive(otherPid) && pidLooksLikeNode(otherPid)) return otherPid;
      const graveyard = `${lockFile}.stale-${process.pid}`;
      try {
        fs.renameSync(lockFile, graveyard); // atomic: one winner per stale lock
      } catch { /* someone else stole it first — loop and race for wx create */ }
      try { fs.rmSync(graveyard, { force: true }); } catch { /* ignore */ }
    }
  }
  return -1;
}

function main() {
  const startedAtMs = Date.now();
  const opts = parseArgs(process.argv.slice(2));

  let config;
  try {
    config = readJson(opts.config);
  } catch (err) {
    console.error(`Could not read config ${opts.config}: ${err.message}`);
    process.exit(1);
  }

  // The single-instance lock is taken BEFORE the queue is even read, so a
  // runner started outside the dashboard is visible (via the lock file) for
  // its whole lifetime, not just from its first state.json write. Dry runs
  // execute nothing and take no lock.
  let releaseLock = () => { /* no lock taken */ };
  if (!opts.dryRun) {
    const lockFile = path.join(path.dirname(opts.state), '.runner.lock');
    const lockHolder = acquireLock(lockFile);
    if (lockHolder !== null) {
      console.error(`Another runner${lockHolder > 0 ? ` (pid ${lockHolder})` : ''} is already active for this queue. Refusing to start a second one.`);
      process.exit(1);
    }
    releaseLock = () => { try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ } };
    process.on('exit', releaseLock);
  }

  let queue;
  try {
    queue = loadQueue(opts.queue); // throws with a clear message on bad queues
  } catch (err) {
    console.error(err.message);
    process.exit(1); // the exit handler releases the lock
  }

  // Relative project paths resolve against the runner root, matching the
  // documented layout (queue lives in prompts/, projects under projects/).
  const projectPath = path.isAbsolute(queue.project_path)
    ? queue.project_path
    : path.resolve(ROOT, queue.project_path);

  const projectName = queue.project_name || path.basename(projectPath);
  const context = typeof queue.context === 'string' ? queue.context : '';
  const deployCfg = {
    enabled: false,
    visibility: 'public',
    verify_live: true,
    live_timeout_ms: 15 * 60 * 1000,
    ...(config.deploy || {}),
    ...(queue.deploy || {}),
  };
  const repoName = slugify(deployCfg.repo_name || projectName, 'auto-built-site');
  const testerEnabled = config.tester?.enabled !== false;

  if (opts.dryRun) {
    console.log('Dry run — nothing will be executed.\n');
    console.log(`Project:      ${projectName}`);
    console.log(`Project path: ${projectPath}`);
    console.log(`Verification: ${Array.isArray(config.verification_steps) && config.verification_steps.length
      ? config.verification_steps.map((s) => s.name).join(', ') + ' (from config)'
      : `auto-detected (currently: ${describeChecks(detectChecks(projectPath))})`}`);
    console.log(`Tester agent: ${testerEnabled ? 'enabled' : 'disabled'}`);
    console.log(`Deploy:       ${deployCfg.enabled ? `GitHub repo "${repoName}" (${deployCfg.visibility}), live check ${deployCfg.verify_live ? 'on' : 'off'}` : 'disabled'}`);
    console.log(`Max retries per phase: ${config.max_retries ?? 4}\n`);
    for (const p of queue.phases) {
      console.log(`  [${p.status}] ${p.id}${p.title ? ` — ${p.title}` : ''} (retries so far: ${p.retries})`);
      console.log(`      ${p.prompt.split('\n')[0].slice(0, 100)}`);
    }
    console.log('\nQueue and config are valid.');
    process.exit(0);
  }

  fs.mkdirSync(projectPath, { recursive: true });

  const runId = `run-${runStamp()}`;
  const logger = new Logger(opts.logs, runId);
  const stopFile = path.join(path.dirname(opts.state), '.stop');
  // A stop flag from before this process started belongs to a previous run —
  // delete it. One written during our own startup is a live request: keep it,
  // and the first stopRequested() check will honor it.
  try {
    if (fs.statSync(stopFile).mtimeMs < startedAtMs) fs.rmSync(stopFile, { force: true });
  } catch { /* no flag */ }

  const maxRetries = config.max_retries ?? 4;
  const totals = { claude_calls: 0, cost_usd: 0, claude_ms: 0 };
  const startedAt = new Date().toISOString();

  const state = {
    run_id: runId,
    pid: process.pid,
    status: 'running',
    started_at: startedAt,
    queue_file: opts.queue,
    config_file: opts.config,
    project_path: projectPath,
    project_name: projectName,
    log_file: path.basename(logger.logFile),
    events_file: path.basename(logger.eventsFile),
    current_phase: null,
    claude_pid: null,
    attempt: 0,
    message: 'starting',
    activity: { agent: null, detail: 'starting up' },
    // A queue that already deployed successfully (queue.deploy_state) seeds
    // "live" here, so rerunning a finished queue never silently redeploys.
    deploy: (queue.deploy_state && queue.deploy_state.status === 'live' && deployCfg.enabled)
      ? {
        enabled: true,
        status: 'live',
        repo_name: repoName,
        repo_url: queue.deploy_state.repo_url || null,
        pages_url: queue.deploy_state.pages_url || null,
        retries: 0,
      }
      : {
        enabled: Boolean(deployCfg.enabled),
        status: deployCfg.enabled ? 'pending' : 'disabled',
        repo_name: deployCfg.enabled ? repoName : null,
        repo_url: null,
        pages_url: null,
        retries: 0,
      },
    totals,
    phases: [],
  };

  const syncState = (patch = {}) => {
    Object.assign(state, patch);
    state.phases = queue.phases.map((p) => ({
      id: p.id,
      title: p.title || p.id,
      status: p.status,
      retries: p.retries,
      commit_hash: p.commit_hash,
    }));
    writeState(opts.state, state);
  };

  // The dashboard's agent feed is built from these: every hand-off between
  // members of the company is one message.
  const say = (from, to, phase, kind, text) => {
    logger.event('agent_msg', { from, to, phase, kind, text: truncate(text, 2000) });
  };

  const setActivity = (agent, detail, extra = {}) => {
    syncState({ activity: { agent, detail }, message: detail, ...extra });
  };

  const persist = () => saveQueue(opts.queue, queue);

  const sendNotification = (title, message, url) => {
    // Even with the OS toast disabled the event is logged, so the dashboard
    // feed always shows the moment the human was (or would have been) called.
    const channel = config.notify?.enabled === false ? 'disabled' : notify(title, message, url);
    logger.event('notification', { title, message, url: url || null, channel });
    say('orchestrator', 'you', null, 'notify', `${title} — ${message}${url ? ` ${url}` : ''}`);
  };

  const finish = (status, message, exitCode) => {
    // Never leave an unattended Claude Code session editing the project after
    // the runner itself is gone.
    if (status !== 'passed_all') killActiveClaude();
    logger.section(`RUN ${status.toUpperCase()}: ${message}`);
    logger.event('run_done', { status, message });
    if (status === 'stuck' || status === 'error') {
      sendNotification('Build halted — needs you', message);
    }
    syncState({ status, message, current_phase: null, claude_pid: null, activity: { agent: null, detail: message } });
    persist();
    releaseLock();
    process.exit(exitCode);
  };

  const stopRequested = () => fs.existsSync(stopFile);
  const stopNow = () => {
    logger.event('stop_requested', {});
    finish('stopped', 'Stop flag detected — run halted gracefully.', 3);
  };

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      logger.log(`Received ${sig}, shutting down.`);
      finish('stopped', `Interrupted by ${sig}.`, 3);
    });
  }

  // --- Startup normalization -----------------------------------------------
  // A phase left "running" means a previous run crashed mid-phase: run it again.
  for (const phase of queue.phases) {
    if (phase.status === 'running' || phase.status === 'failed_retry') phase.status = 'pending';
    if (opts.retryStuck && phase.status === 'stuck') {
      phase.status = 'pending';
      phase.retries = 0;
      logger.log(`--retry-stuck: reset ${phase.id} to pending.`);
    }
  }

  ensureGitRepo(projectPath, logger);

  logger.section(`RUN ${runId} started`);
  logger.log(`Project: ${projectName} (${projectPath})`);
  logger.log(`Queue:   ${opts.queue}`);
  logger.log(`Config:  ${opts.config}`);
  logger.log(`Phases:  ${queue.phases.length} total, ${queue.phases.filter((p) => p.status === 'passed').length} already passed`);
  logger.log(`Tester:  ${testerEnabled ? 'enabled' : 'disabled'} · Deploy: ${deployCfg.enabled ? `github:${repoName}` : 'disabled'}`);
  logger.event('run_start', {
    run_id: runId,
    queue_file: opts.queue,
    project_path: projectPath,
    project_name: projectName,
    phases: queue.phases.map((p) => ({ id: p.id, title: p.title || p.id })),
    max_retries: maxRetries,
    tester_enabled: testerEnabled,
    deploy: state.deploy,
  });
  syncState({ message: 'run started' });
  persist();

  runAll().catch((err) => {
    logger.log(`FATAL: ${err.stack || err.message || err}`);
    logger.event('run_error', { error: String(err.stack || err.message || err) });
    finish('error', `Runner crashed: ${err.message || err}`, 1);
  });

  function trackCall(res) {
    totals.claude_calls += 1;
    totals.claude_ms += res.durationMs;
    if (res.parsed && typeof res.parsed.total_cost_usd === 'number') {
      totals.cost_usd = Math.round((totals.cost_usd + res.parsed.total_cost_usd) * 10000) / 10000;
    }
    // Clear the recorded agent pid ON DISK the moment the call resolves —
    // the dashboard's Kill must never see a pid that has already been reused.
    syncState({ claude_pid: null });
  }

  function onSpawn(pid) { syncState({ claude_pid: pid }); }

  // --- The main loop --------------------------------------------------------
  async function runAll() {
    for (let i = 0; i < queue.phases.length; i++) {
      const phase = queue.phases[i];

      if (phase.status === 'passed') {
        logger.log(`Skipping ${phase.id} — already passed (commit ${phase.commit_hash || 'n/a'}).`);
        continue;
      }
      if (phase.status === 'stuck') {
        finish('stuck', `${phase.id} is marked stuck from a previous run. Fix it or rerun with --retry-stuck.`, 2);
      }
      if (stopRequested()) stopNow();

      const label = phase.title ? `${phase.id} — ${phase.title}` : phase.id;
      logger.section(`PHASE ${label} (${i + 1}/${queue.phases.length})`);
      logger.block(`prompt for ${phase.id}:`, phase.prompt);
      logger.event('phase_start', { phase: phase.id, title: phase.title || phase.id, index: i, total: queue.phases.length, prompt: phase.prompt });

      phase.status = 'running';
      let fixPrompt = null; // null = send the original prompt
      syncState({ current_phase: phase.id, attempt: phase.retries + 1 });
      persist();

      while (true) {
        const attempt = phase.retries + 1;
        const kind = fixPrompt ? 'fix' : 'initial';
        logger.log(`Running ${phase.id}, attempt ${attempt}/${maxRetries + 1} (${kind} prompt)`);
        logger.event('attempt_start', { phase: phase.id, attempt, max_attempts: maxRetries + 1, kind });

        // 1. BUILDER does the work.
        setActivity('builder', `${phase.id}: builder working (attempt ${attempt})`, { attempt });
        say('orchestrator', 'builder', phase.id, kind === 'fix' ? 'fix' : 'inject',
          kind === 'fix' ? `Your last attempt failed — fix it. (attempt ${attempt})` : `New task: ${phase.title || phase.id}`);
        logger.event('claude_start', { phase: phase.id, agent: 'builder', attempt, kind });
        const build = fixPrompt
          ? await runBuilderFix({ projectPath, config, onSpawn, fixPrompt })
          : await runBuilder({ projectPath, config, onSpawn, phase: phase.id, index: i, total: queue.phases.length, context, prompt: phase.prompt });
        trackCall(build);

        if (!build.ok) {
          // The CLI call itself failed (crash, timeout, not installed). There
          // is no failure evidence to fix from — retry the same prompt.
          logger.log(`Builder call FAILED: ${build.error}`);
          if (build.stderr) logger.block('builder stderr:', truncate(build.stderr, 4000));
          logger.event('claude_error', { phase: phase.id, agent: 'builder', attempt, error: build.error, duration_ms: build.durationMs });
          say('builder', 'orchestrator', phase.id, 'error', `My session crashed: ${truncate(build.error, 300)}`);

          phase.retries += 1;
          if (phase.retries > maxRetries) {
            phase.status = 'stuck';
            logger.event('phase_stuck', { phase: phase.id, retries: phase.retries, reason: 'claude_call_failed' });
            persist();
            finish('stuck', `${phase.id} stuck: the builder session kept failing. Last error: ${build.error}`, 2);
          }
          phase.status = 'failed_retry';
          setActivity(null, `${phase.id}: builder crashed, retrying (${phase.retries}/${maxRetries})`);
          persist();
          if (stopRequested()) stopNow();
          phase.status = 'running';
          continue;
        }

        const resultText = String(build.parsed?.result ?? '').trim();
        const reportSummary = build.report?.summary || resultText.slice(0, 300) || '(no report)';
        logger.log(`Builder finished in ${formatDuration(build.durationMs)} (cost $${build.parsed?.total_cost_usd ?? '?'})`);
        if (resultText) logger.block('builder result:', truncate(resultText, 4000));
        logger.event('claude_done', {
          phase: phase.id,
          agent: 'builder',
          attempt,
          ok: true,
          duration_ms: build.durationMs,
          cost_usd: build.parsed?.total_cost_usd ?? null,
          num_turns: build.parsed?.num_turns ?? null,
          result: truncate(resultText, 2000),
          report: build.report || null,
        });
        say('builder', 'orchestrator', phase.id, 'report', `Done. ${truncate(reportSummary, 400)}`);

        if (stopRequested()) stopNow();

        // 2. Auto-detected checks — exit codes never hallucinate.
        setActivity(null, `${phase.id}: running automated checks`);
        logger.event('verify_start', { phase: phase.id, attempt });
        const verification = await verifyPhase(projectPath, config, logger, phase.id, stopRequested);
        if (verification.aborted) stopNow();
        const failedSteps = Object.entries(verification.results).filter(([, r]) => !r.passed).map(([n]) => n);
        const checkNames = Object.keys(verification.results);
        logger.event('verify_result', { phase: phase.id, attempt, all_passed: verification.allPassed, steps: checkNames, failed_steps: failedSteps });
        say('orchestrator', 'orchestrator', phase.id, 'checks',
          checkNames.length
            ? `Automated checks (${checkNames.join(', ')}): ${verification.allPassed ? 'all passed' : `FAILED ${failedSteps.join(', ')}`}`
            : 'No automated checks apply yet.');

        let verdict = null;
        if (verification.allPassed) {
          if (stopRequested()) stopNow();
          // 3. TESTER verifies the builder's claims.
          if (testerEnabled) {
            setActivity('tester', `${phase.id}: tester verifying the builder's work`);
            say('orchestrator', 'tester', phase.id, 'test_request', `Builder says: "${truncate(reportSummary, 200)}". Verify it.`);
            logger.event('claude_start', { phase: phase.id, agent: 'tester', attempt });
            const test = await runTester({
              projectPath, config, onSpawn,
              phase: phase.id, context, prompt: phase.prompt,
              report: build.report, builderResult: resultText,
              autoSummary: checkNames.length ? `${checkNames.join(', ')} — all exited 0` : 'none applied',
            });
            trackCall(test);
            verdict = test.verdict;
            logger.log(`Tester verdict: ${verdict.pass ? 'PASS' : 'FAIL'} — ${verdict.summary}`);
            logger.event('verdict', {
              phase: phase.id,
              attempt,
              pass: verdict.pass,
              summary: verdict.summary,
              failures: verdict.failures,
              source: verdict.source,
              duration_ms: test.durationMs,
              cost_usd: test.parsed?.total_cost_usd ?? null,
            });
            say('tester', 'orchestrator', phase.id, 'verdict',
              verdict.pass ? `PASS — ${truncate(verdict.summary, 300)}` : `FAIL — ${truncate(verdict.summary, 300)}`);
          } else {
            verdict = { pass: true, summary: 'tester disabled', failures: [] };
          }

          if (verdict.pass) {
            // 4. Commit and move on.
            phase.commit_hash = commitPhase(projectPath, phase.id);
            phase.status = 'passed';
            logger.log(`${phase.id} PASSED (auto-checks + tester), commit ${phase.commit_hash}`);
            logger.event('commit', { phase: phase.id, hash: phase.commit_hash });
            logger.event('phase_passed', { phase: phase.id, retries: phase.retries, hash: phase.commit_hash });
            say('orchestrator', 'orchestrator', phase.id, 'passed', `${phase.title || phase.id} locked in (commit ${phase.commit_hash.slice(0, 8)}). Moving on.`);
            setActivity(null, `${phase.id} passed (commit ${phase.commit_hash.slice(0, 8)})`);
            persist();
            break;
          }
        }

        // 5. Something failed — build a fix prompt from the exact evidence.
        phase.retries += 1;
        const reason = failedSteps.length ? `checks: ${failedSteps.join(', ')}` : `tester: ${verdict?.summary || 'rejected'}`;
        logger.log(`${phase.id} failed (${reason}). Retry ${phase.retries}/${maxRetries}.`);

        if (phase.retries > maxRetries) {
          phase.status = 'stuck';
          logger.event('phase_stuck', { phase: phase.id, retries: phase.retries, reason: failedSteps.length ? 'verification_failed' : 'tester_rejected', failed_steps: failedSteps });
          persist();
          finish('stuck', `${phase.id} stuck after ${phase.retries} attempts (${reason}). See the logs.`, 2);
        }

        phase.status = 'failed_retry';
        fixPrompt = buildFixPrompt({ originalPrompt: phase.prompt, autoResults: verification.results, verdict, config });
        logger.block(`fix prompt for ${phase.id} (attempt ${phase.retries + 1}):`, truncate(fixPrompt, 6000));
        logger.event('fix_prompt', { phase: phase.id, attempt: phase.retries + 1, prompt: fixPrompt });
        setActivity(null, `${phase.id} failed (${reason}) — sending fix prompt (${phase.retries}/${maxRetries})`);
        persist();
        if (stopRequested()) stopNow();
        phase.status = 'running';
      }
    }

    // --- Deploy stage --------------------------------------------------------
    if (deployCfg.enabled) {
      if (state.deploy.status === 'live' && state.deploy.pages_url) {
        // This queue already deployed in a previous run — don't redeploy or
        // re-notify, just confirm and finish.
        logger.log(`Skipping deploy — already live at ${state.deploy.pages_url}`);
        logger.event('deploy_skipped', { pages_url: state.deploy.pages_url, repo_url: state.deploy.repo_url });
        finish('passed_all', `All phases complete and the site is live: ${state.deploy.pages_url}`, 0);
      }
      await deployStage();
      sendNotification(
        `${projectName} is LIVE`,
        `All ${queue.phases.length} prompts built, tested and deployed.`,
        state.deploy.pages_url || state.deploy.repo_url
      );
      finish('passed_all', `All phases complete and the site is live: ${state.deploy.pages_url || state.deploy.repo_url}`, 0);
    } else {
      sendNotification(`${projectName} build complete`, `All ${queue.phases.length} prompts built and tested. (Deploy is disabled.)`);
      finish('passed_all', 'All phases complete.', 0);
    }
  }

  async function deployStage() {
    logger.section('DEPLOY — putting the site live on GitHub');
    logger.event('deploy_start', { repo_name: repoName, visibility: deployCfg.visibility });
    state.deploy.status = 'deploying';
    let fixPrompt = null;

    while (true) {
      if (stopRequested()) stopNow();
      const attempt = state.deploy.retries + 1;
      setActivity('deployer', `deploy: attempt ${attempt} — pushing to GitHub`, { current_phase: 'deploy' });
      say('orchestrator', 'deployer', 'deploy', fixPrompt ? 'fix' : 'inject',
        fixPrompt ? `Deployment still not live — fix it. (attempt ${attempt})` : `Project verified. Ship "${repoName}" to GitHub Pages.`);
      logger.event('claude_start', { phase: 'deploy', agent: 'deployer', attempt });

      const dep = await runDeployer({
        projectPath, config, onSpawn,
        projectName, repoName, visibility: deployCfg.visibility, context, fixPrompt,
      });
      trackCall(dep);

      const info = dep.deploy;
      logger.event('claude_done', {
        phase: 'deploy', agent: 'deployer', attempt, ok: dep.ok,
        duration_ms: dep.durationMs, cost_usd: dep.parsed?.total_cost_usd ?? null,
        result: truncate(String(dep.parsed?.result ?? ''), 2000), deploy: info || null,
      });
      say('deployer', 'orchestrator', 'deploy', 'report',
        info ? `Repo: ${info.repo_url || '?'} · URL: ${info.pages_url || '?'} · live: ${info.live}` : 'I did not write a deploy report.');

      let evidence = null;
      if (!dep.ok) {
        evidence = `The deployer session itself failed: ${dep.error}`;
      } else if (!info || !info.pages_url) {
        evidence = 'No .pcr/deploy.json with a "pages_url" was written, so there is nothing to verify.';
      } else {
        state.deploy.repo_url = info.repo_url || state.deploy.repo_url;
        state.deploy.pages_url = info.pages_url;
        syncState();
        if (deployCfg.verify_live) {
          // Trust, but verify: poll the public URL ourselves.
          setActivity('deployer', `deploy: waiting for ${info.pages_url} to come alive`);
          logger.event('live_check_start', { url: info.pages_url, timeout_ms: deployCfg.live_timeout_ms });
          const live = await waitUntilLive(info.pages_url, {
            timeoutMs: deployCfg.live_timeout_ms,
            shouldStop: stopRequested,
            onAttempt: (r) => setActivity('deployer', `deploy: ${info.pages_url} -> ${r.detail}`),
          });
          if (live.aborted) stopNow();
          logger.event('live_check_result', { url: info.pages_url, live: live.live, evidence: truncate(live.evidence, 3000) });
          if (!live.live) evidence = `Independent live check failed.\n${live.evidence}`;
        } else if (info.live !== true) {
          evidence = 'Your deploy report says "live" is not true.';
        }
      }

      if (!evidence) {
        state.deploy.status = 'live';
        // Persisted in the queue so a rerun of this finished queue knows the
        // site is already up and skips the deploy stage entirely.
        queue.deploy_state = { status: 'live', repo_url: state.deploy.repo_url, pages_url: state.deploy.pages_url };
        syncState();
        persist();
        logger.log(`DEPLOY VERIFIED LIVE: ${state.deploy.pages_url}`);
        logger.event('deploy_done', { repo_url: state.deploy.repo_url, pages_url: state.deploy.pages_url });
        say('orchestrator', 'orchestrator', 'deploy', 'passed', `Site verified live at ${state.deploy.pages_url}`);
        return;
      }

      logger.log(`Deploy attempt ${attempt} not live yet: ${truncate(evidence, 500)}`);
      state.deploy.retries += 1;
      if (state.deploy.retries > maxRetries) {
        state.deploy.status = 'failed';
        syncState();
        logger.event('deploy_stuck', { retries: state.deploy.retries, evidence: truncate(evidence, 3000) });
        finish('stuck', `Deploy stuck after ${state.deploy.retries} attempts: ${truncate(evidence, 300)}`, 2);
      }
      fixPrompt = buildDeployFixPrompt({ deployInfo: info, evidence, projectName, repoName, visibility: deployCfg.visibility });
      logger.event('fix_prompt', { phase: 'deploy', attempt: state.deploy.retries + 1, prompt: fixPrompt });
      syncState();
    }
  }
}

main();
