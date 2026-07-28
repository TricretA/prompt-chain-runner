#!/usr/bin/env node
'use strict';
// The ORCHESTRATOR — the main agent of a small autonomous company.
//
// Give it a one-line brief (or a written prompt chain) and it runs the whole
// company hands-free:
//
//   Planner   turns the brief into an ordered prompt chain
//   Builder   builds each prompt; auto-detected checks gate it on exit codes
//   Tester    verifies the claims in a real browser and files a verdict
//   Debugger  when fixes stall, diagnoses the root cause (read-only)
//   revert    when even that stalls, rolls back to the last good commit and
//             makes the builder try a genuinely different approach
//   Designer  looks at real screenshots and fixes what is ugly
//   Security  blocks publication on secrets or critical exposure
//   Deployer  ships to GitHub Pages / Vercel / Netlify — and the orchestrator
//             independently proves the live URL serves a working site, assets
//             included, before anyone is told it is done.
//
// It then pulls the next project off the backlog and does it again. The human
// hears from it once: when everything is live (or when only they can unblock).
//
// Usage:
//   node runner.js [--queue prompts/queue.json] [--config config.json]
//                  [--logs logs] [--state state.json] [--backlog prompts/backlog.json]
//                  [--retry-stuck] [--dry-run]
//
// Exit codes: 0 finished (possibly with degraded phases) · 1 runner error ·
//             2 halted, needs a human · 3 stopped

const fs = require('fs');
const path = require('path');
const { readJson, runStamp, formatDuration, truncate, slugify, pidAlive, pidLooksLikeNode } = require('./lib/util');
const { Logger } = require('./lib/logger');
const { writeState } = require('./lib/state');
const { loadQueue, saveQueue } = require('./lib/queue');
const { ensureGitRepo, commitPhase, treeHash, headCommit, revertTo } = require('./lib/git');
const { verifyPhase } = require('./lib/verify');
const { detectChecks, describeChecks } = require('./lib/autocheck');
const { killActiveClaude } = require('./lib/claude');
const {
  runPlanner, runBuilder, runBuilderFix, runTester, runDebugger,
  runDesigner, runSecurity, runDeployer, normalizePlan,
} = require('./lib/agents');
const { buildFixPrompt, buildDeployFixPrompt, buildSecurityFixPrompt, evidenceSections } = require('./lib/fix-prompt');
const { waitUntilLive } = require('./lib/live-check');
const { notify } = require('./lib/notify');
const { detectCapabilities, describeCapabilities, pickDeployTarget } = require('./lib/capabilities');
const { sendRemote } = require('./lib/remote-notify');
const { recordLesson, findLessons, formatLessons } = require('./lib/lessons');
const { loadBacklog, readBacklog, nextPending, markStatus } = require('./lib/backlog');

const ROOT = __dirname;

function parseArgs(argv) {
  const opts = {
    queue: path.join(ROOT, 'prompts', 'queue.json'),
    config: path.join(ROOT, 'config.json'),
    logs: path.join(ROOT, 'logs'),
    state: path.join(ROOT, 'state.json'),
    backlog: path.join(ROOT, 'prompts', 'backlog.json'),
    retryStuck: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--queue') opts.queue = path.resolve(argv[++i]);
    else if (a === '--config') opts.config = path.resolve(argv[++i]);
    else if (a === '--logs') opts.logs = path.resolve(argv[++i]);
    else if (a === '--state') opts.state = path.resolve(argv[++i]);
    else if (a === '--backlog') opts.backlog = path.resolve(argv[++i]);
    else if (a === '--retry-stuck') opts.retryStuck = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Unknown argument: ${a}`); printHelp(); process.exit(1); }
  }
  return opts;
}

function printHelp() {
  console.log(`Prompt Chain Runner — autonomous agent company
  node runner.js [options]

  --queue <file>    the active project (default prompts/queue.json)
  --backlog <file>  queued follow-up projects (default prompts/backlog.json)
  --config <file>   settings (default config.json)
  --logs <dir>      log directory (default logs/)
  --state <file>    live state file for the dashboard (default state.json)
  --retry-stuck     reset phases marked stuck/degraded back to pending
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

// The escalation ladder. Retrying the same way five times is how a run burns
// money without converging, so each rung changes something structural.
function escalationFor(attempt, maxAttempts) {
  if (attempt <= 1) return 'initial';
  if (maxAttempts >= 4) {
    if (attempt >= maxAttempts) return 'fresh_start';
    if (attempt === maxAttempts - 1) return 'diagnosis';
    if (attempt === 3) return 'lessons';
  }
  return 'fix';
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
    queue = loadQueue(opts.queue);
  } catch (err) {
    console.error(err.message);
    process.exit(1); // the exit handler releases the lock
  }

  const maxRetries = config.max_retries ?? 5;
  const maxAttempts = maxRetries + 1;
  const onStuck = config.on_stuck === 'halt' ? 'halt' : 'continue';
  const testerEnabled = config.tester?.enabled !== false;
  // Counts are normalized once here so an explicit 0 ("never do this") is not
  // swallowed by a `|| default` further down.
  const designCfg = { enabled: true, rounds: 1, ...(config.design || {}) };
  designCfg.rounds = Number.isFinite(designCfg.rounds) ? Math.max(0, Math.trunc(designCfg.rounds)) : 1;
  const securityCfg = { enabled: true, block_deploy: true, max_fix_rounds: 2, ...(config.security || {}) };
  securityCfg.max_fix_rounds = Number.isFinite(securityCfg.max_fix_rounds) ? Math.max(0, Math.trunc(securityCfg.max_fix_rounds)) : 2;
  const budgetCfg = config.budget || {};
  const lessonsFile = path.join(ROOT, 'memory', 'lessons.jsonl');
  const lessonsEnabled = config.lessons?.enabled !== false;

  const capabilities = detectCapabilities({
    cacheFile: path.join(ROOT, '.capabilities.json'),
    ttlMs: config.capabilities?.cache_ms,
    override: config.capabilities?.override,
  });
  const capsText = describeCapabilities(capabilities);

  if (opts.dryRun) {
    const projectPath = resolveProjectPath(queue);
    console.log('Dry run — nothing will be executed.\n');
    console.log(`Project:      ${queue.project_name || path.basename(projectPath)}`);
    console.log(`Project path: ${projectPath}`);
    console.log(`Source:       ${queue.phases.length ? `${queue.phases.length} written prompts` : `a one-line brief (the Planner will expand it)`}`);
    console.log(`Verification: ${Array.isArray(config.verification_steps) && config.verification_steps.length
      ? config.verification_steps.map((s) => s.name).join(', ') + ' (from config)'
      : `auto-detected (currently: ${describeChecks(detectChecks(projectPath))})`}`);
    console.log(`Tester:       ${testerEnabled ? 'on' : 'off'} · Design: ${designCfg.enabled ? `${designCfg.rounds} round(s)` : 'off'} · Security: ${securityCfg.enabled ? 'on' : 'off'}`);
    console.log(`Deploy:       ${queue.deploy?.enabled === false ? 'off' : pickDeployTarget(capabilities, queue.deploy?.target || config.deploy?.target)}`);
    console.log(`On stuck:     ${onStuck === 'continue' ? 'keep going (hands-free)' : 'halt'} · max attempts per prompt: ${maxAttempts}`);
    console.log(`Budget:       ${budgetCfg.max_usd_per_run ? `$${budgetCfg.max_usd_per_run} per run` : 'no cap'}`);
    console.log(`Backlog:      ${loadBacklog(opts.backlog).filter((i) => i.status === 'pending').length} project(s) queued after this one\n`);
    console.log('Capabilities:');
    console.log(capsText);
    for (const p of queue.phases) {
      console.log(`  [${p.status}] ${p.id}${p.title ? ` — ${p.title}` : ''} (retries so far: ${p.retries})`);
      console.log(`      ${p.prompt.split('\n')[0].slice(0, 100)}`);
    }
    console.log('\nQueue and config are valid.');
    process.exit(0);
  }

  const runId = `run-${runStamp()}`;
  const logger = new Logger(opts.logs, runId);
  const stopFile = path.join(path.dirname(opts.state), '.stop');
  // A stop flag from before this process started belongs to a previous run —
  // delete it. One written during our own startup is a live request: keep it,
  // and the first stopRequested() check will honor it.
  try {
    if (fs.statSync(stopFile).mtimeMs < startedAtMs) fs.rmSync(stopFile, { force: true });
  } catch { /* no flag */ }

  const totals = { claude_calls: 0, cost_usd: 0, claude_ms: 0 };
  const state = {
    run_id: runId,
    pid: process.pid,
    status: 'running',
    started_at: new Date().toISOString(),
    heartbeat: new Date().toISOString(),
    queue_file: opts.queue,
    config_file: opts.config,
    backlog_file: opts.backlog,
    project_path: null,
    project_name: null,
    log_file: path.basename(logger.logFile),
    events_file: path.basename(logger.eventsFile),
    stage: 'starting',
    current_phase: null,
    claude_pid: null,
    attempt: 0,
    message: 'starting',
    activity: { agent: null, detail: 'starting up' },
    deploy: { enabled: false, status: 'disabled', repo_name: null, repo_url: null, pages_url: null, retries: 0 },
    budget: { spent_usd: 0, cap_usd: budgetCfg.max_usd_per_run || null },
    backlog: { done: 0, remaining: 0 },
    capabilities: capabilities,
    degraded: [],
    totals,
    phases: [],
  };

  const syncState = (patch = {}) => {
    Object.assign(state, patch);
    state.heartbeat = new Date().toISOString();
    state.budget.spent_usd = totals.cost_usd;
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

  const sendNotification = async (title, message, url, level = 'info') => {
    const channel = config.notify?.enabled === false ? 'disabled' : notify(title, message, url);
    let remote = [];
    try {
      remote = await sendRemote(config.notify || {}, { title, body: message, url, level });
    } catch { /* a notification must never affect a build */ }
    logger.event('notification', {
      title, message, url: url || null, channel,
      remote: remote.map((r) => `${r.channel}:${r.ok ? 'ok' : 'failed'}`),
    });
    say('orchestrator', 'you', null, 'notify', `${title} — ${message}${url ? ` ${url}` : ''}`);
  };

  const finish = async (status, message, exitCode) => {
    // Never leave an unattended Claude Code session editing a project after
    // the runner itself is gone.
    if (exitCode !== 0) killActiveClaude();
    logger.section(`RUN ${status.toUpperCase()}: ${message}`);
    logger.event('run_done', { status, message, totals });
    if (status === 'stuck' || status === 'error' || status === 'budget_exhausted') {
      await sendNotification('Build halted — needs you', message, null, 'error');
    }
    syncState({ status, message, current_phase: null, claude_pid: null, stage: 'done', activity: { agent: null, detail: message } });
    persist();
    releaseLock();
    process.exit(exitCode);
  };

  const stopRequested = () => fs.existsSync(stopFile);
  const stopNow = () => finish('stopped', 'Stop flag detected — run halted gracefully.', 3);

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      logger.log(`Received ${sig}, shutting down.`);
      void finish('stopped', `Interrupted by ${sig}.`, 3);
    });
  }

  logger.section(`RUN ${runId} started`);
  logger.log(`Capabilities:\n${capsText}`);
  logger.event('run_start', {
    run_id: runId,
    queue_file: opts.queue,
    max_retries: maxRetries,
    on_stuck: onStuck,
    tester_enabled: testerEnabled,
    design: designCfg,
    security: securityCfg,
    budget: budgetCfg,
    capabilities,
  });

  runEverything().catch(async (err) => {
    logger.log(`FATAL: ${err.stack || err.message || err}`);
    logger.event('run_error', { error: String(err.stack || err.message || err) });
    await finish('error', `Runner crashed: ${err.message || err}`, 1);
  });

  function resolveProjectPath(q) {
    return path.isAbsolute(q.project_path) ? q.project_path : path.resolve(ROOT, q.project_path);
  }

  function onSpawn(pid) { syncState({ claude_pid: pid }); }

  function trackCall(res) {
    totals.claude_calls += 1;
    totals.claude_ms += res.durationMs;
    // A session that was killed or crashed printed no parseable JSON — but it
    // was still billed. Charging it $0 would make the budget cap blind to
    // exactly the runaway it exists to stop, so unpriced time is estimated.
    if (res.parsed && typeof res.parsed.total_cost_usd === 'number') {
      totals.cost_usd = Math.round((totals.cost_usd + res.parsed.total_cost_usd) * 10000) / 10000;
    } else if (res.durationMs > 5000) {
      const rate = budgetCfg.unpriced_usd_per_hour ?? 6;
      const estimate = Math.round((rate * (res.durationMs / 3600000)) * 10000) / 10000;
      totals.cost_usd = Math.round((totals.cost_usd + estimate) * 10000) / 10000;
      logger.event('unpriced_call', { duration_ms: res.durationMs, estimated_usd: estimate, error: res.error || null });
    }
    // Clear the recorded agent pid ON DISK the moment the call resolves —
    // the dashboard's Kill must never see a pid that has already been reused.
    syncState({ claude_pid: null });
  }

  // Money is the one thing an unattended run can burn without limit, so the cap
  // is checked before every agent call, not just between phases.
  function budgetLeft() {
    // A cap of 0 means "spend nothing" — the one value a truthiness test would
    // read as "no cap at all".
    const raw = budgetCfg.max_usd_per_run;
    if (raw === null || raw === undefined) return Infinity;
    const cap = Number(raw);
    return Number.isFinite(cap) ? cap - totals.cost_usd : Infinity;
  }

  async function assertBudget(where) {
    if (budgetLeft() > 0) return;
    logger.event('budget_exhausted', { spent: totals.cost_usd, cap: budgetCfg.max_usd_per_run, where });
    await finish('budget_exhausted',
      `Budget cap of $${budgetCfg.max_usd_per_run} reached (spent $${totals.cost_usd.toFixed(2)}) at ${where}. Raise budget.max_usd_per_run to continue.`, 2);
  }

  // --- The outer loop: this project, then everything on the backlog ---------
  async function runEverything() {
    let built = 0;
    let worst = null;
    const problems = [];
    while (true) {
      const outcome = await runProject();
      built += 1;
      // The run's exit code must reflect the worst project, not the last one —
      // otherwise a failure is erased by whatever gets built after it.
      if (!worst || outcome.exitCode > worst.exitCode) worst = outcome;
      if (outcome.exitCode !== 0) problems.push(outcome.message);

      // An unreadable backlog is not an empty backlog. Ending the night early
      // and calling it success would strand every queued project silently.
      const read = readBacklog(opts.backlog);
      if (!read.ok) {
        logger.event('backlog_unreadable', { file: opts.backlog });
        await finish('stuck', `Could not read the backlog at ${opts.backlog}; ${built} project(s) built. Fix the file and start again.`, 2);
        return;
      }
      const backlogItems = read.items;
      const next = nextPending(backlogItems);
      syncState({ backlog: { done: built, remaining: backlogItems.filter((i) => i.status === 'pending').length } });
      if (!next) {
        const summary = problems.length
          ? `${worst.message}${problems.length > 1 ? ` (+${problems.length - 1} more project(s) had problems)` : ''}`
          : worst.message;
        await finish(worst.status, `${summary}${built > 1 ? ` — ${built} projects this run` : ''}`, worst.exitCode);
        return;
      }
      if (stopRequested()) stopNow();
      logger.section(`NEXT PROJECT FROM BACKLOG: ${next.project_name}`);
      say('orchestrator', 'orchestrator', null, 'backlog', `Starting the next queued project: ${next.project_name}`);
      // If this cannot be persisted, the same item would be picked forever.
      if (!markStatus(opts.backlog, next.id, 'running')) {
        logger.event('backlog_unwritable', { file: opts.backlog, id: next.id });
        await finish('stuck', `Could not update the backlog at ${opts.backlog} (read-only or locked); refusing to loop on the same project.`, 2);
        return;
      }
      queue = materializeBacklogItem(next);
      persist();
    }
  }

  // A backlog entry becomes the active queue. Briefs stay briefs — the Planner
  // stage expands them once the project directory exists.
  function materializeBacklogItem(item) {
    const slug = slugify(item.project_name, 'project');
    return {
      project_name: item.project_name,
      // An item may pin its own location; otherwise it lands beside the others.
      project_path: (typeof item.project_path === 'string' && item.project_path.trim())
        ? item.project_path
        : `./projects/${slug}`,
      context: item.context || '',
      brief: item.brief || null,
      backlog_id: item.id,
      deploy: { enabled: item.deploy?.enabled !== false, target: item.deploy?.target || 'auto', repo_name: item.deploy?.repo_name || slug },
      phases: (item.prompts || []).map((p, i) => ({
        id: `prompt-${i + 1}`,
        title: p.title || `Prompt ${i + 1}`,
        prompt: p.prompt,
        status: 'pending',
        retries: 0,
        commit_hash: null,
      })),
    };
  }

  // --- One project, start to live ------------------------------------------
  async function runProject() {
    const projectPath = resolveProjectPath(queue);
    const projectName = queue.project_name || path.basename(projectPath);
    const context = typeof queue.context === 'string' ? queue.context : '';
    fs.mkdirSync(projectPath, { recursive: true });

    const deployCfg = {
      enabled: true, visibility: 'public', verify_live: true, live_timeout_ms: 15 * 60 * 1000, target: 'auto',
      ...(config.deploy || {}),
      ...(queue.deploy || {}),
    };
    const repoName = slugify(deployCfg.repo_name || projectName, 'auto-built-site');

    syncState({
      project_path: projectPath,
      project_name: projectName,
      stage: 'starting',
      degraded: [],
      deploy: (queue.deploy_state && queue.deploy_state.status === 'live' && deployCfg.enabled)
        ? { enabled: true, status: 'live', repo_name: repoName, repo_url: queue.deploy_state.repo_url || null, pages_url: queue.deploy_state.pages_url || null, retries: 0 }
        : {
          enabled: Boolean(deployCfg.enabled),
          status: deployCfg.enabled ? 'pending' : 'disabled',
          repo_name: deployCfg.enabled ? repoName : null,
          repo_url: null, pages_url: null, retries: 0,
        },
    });

    // --- Plan ---------------------------------------------------------------
    if (!queue.phases.length) {
      if (!queue.brief || !queue.brief.trim()) {
        await finish('error', 'The queue has neither prompts nor a brief — nothing to build.', 1);
      }
      await assertBudget('planning');
      logger.section(`PLANNING: ${projectName}`);
      setActivity('planner', `planning "${projectName}" from the brief`, { stage: 'planning' });
      say('orchestrator', 'planner', null, 'inject', `New project: ${truncate(queue.brief, 300)}`);
      logger.event('claude_start', { phase: 'plan', agent: 'planner' });

      const plan = await runPlanner({ projectPath, config, onSpawn, brief: queue.brief, projectName, capabilities: capsText });
      trackCall(plan);
      const normalized = normalizePlan(plan.answer);
      logger.event('claude_done', {
        phase: 'plan', agent: 'planner', ok: plan.ok, duration_ms: plan.durationMs,
        cost_usd: plan.parsed?.total_cost_usd ?? null, plan: normalized,
      });

      if (!normalized) {
        await finish('stuck', `The Planner could not turn the brief into a build plan: ${truncate(plan.error || String(plan.parsed?.result ?? ''), 300)}`, 2);
      }
      queue.context = normalized.context || context;
      queue.phases = normalized.prompts.map((p, i) => ({
        id: `prompt-${i + 1}`, title: p.title, prompt: p.prompt,
        status: 'pending', retries: 0, commit_hash: null,
      }));
      if (normalized.deploy_target && normalized.deploy_target !== 'auto' && (!queue.deploy || queue.deploy.target === 'auto' || !queue.deploy.target)) {
        queue.deploy = { ...(queue.deploy || {}), target: normalized.deploy_target };
        deployCfg.target = normalized.deploy_target;
      }
      persist();
      syncState();
      logger.log(`Plan: ${normalized.stack || '(no stack stated)'} — ${queue.phases.length} steps`);
      say('planner', 'orchestrator', null, 'report', `Plan ready: ${normalized.stack || ''} · ${queue.phases.length} steps: ${queue.phases.map((p) => p.title).join(' → ')}`);
    }

    const projectContext = typeof queue.context === 'string' ? queue.context : context;

    // A phase left "running" means a previous run crashed mid-phase: run it again.
    for (const phase of queue.phases) {
      if (phase.status === 'running' || phase.status === 'failed_retry') phase.status = 'pending';
      if (opts.retryStuck && (phase.status === 'stuck' || phase.status === 'degraded')) {
        phase.status = 'pending';
        phase.retries = 0;
        logger.log(`--retry-stuck: reset ${phase.id} to pending.`);
      }
    }

    ensureGitRepo(projectPath, logger);
    logger.section(`BUILDING ${projectName} (${queue.phases.length} prompts)`);
    logger.event('project_start', {
      project: projectName, project_path: projectPath,
      phases: queue.phases.map((p) => ({ id: p.id, title: p.title || p.id })),
    });
    syncState({ stage: 'building' });
    persist();

    // Accumulated across phases: what exists now, and what must keep working.
    let projectState = '';
    const regression = [];
    for (const p of queue.phases) {
      if (p.status === 'passed' && p.criteria) regression.push(...p.criteria);
    }
    const degraded = [];

    // --- Build every prompt -------------------------------------------------
    for (let i = 0; i < queue.phases.length; i++) {
      const phase = queue.phases[i];

      if (phase.status === 'passed') {
        logger.log(`Skipping ${phase.id} — already passed (commit ${phase.commit_hash || 'n/a'}).`);
        if (phase.report_summary) projectState = appendState(projectState, phase, phase.report_summary);
        continue;
      }
      if (phase.status === 'degraded') { degraded.push(phase.id); continue; }
      if (phase.status === 'stuck') {
        await finish('stuck', `${phase.id} is marked stuck from a previous run. Fix it or rerun with --retry-stuck.`, 2);
      }
      if (stopRequested()) stopNow();

      const outcome = await runPhase({ phase, index: i, projectPath, projectName, context: projectContext, projectState, regression });
      if (outcome.passed) {
        projectState = appendState(projectState, phase, outcome.summary);
        if (outcome.criteria?.length) regression.push(...outcome.criteria);
      } else {
        degraded.push(phase.id);
        syncState({ degraded });
      }
    }

    // --- Design -------------------------------------------------------------
    if (designCfg.enabled && queue.phases.some((p) => p.status === 'passed')) {
      await runDesignStage({ projectPath, context: projectContext });
    }

    // --- Security -----------------------------------------------------------
    let securityBlocked = false;
    if (securityCfg.enabled && deployCfg.enabled) {
      securityBlocked = await runSecurityStage({ projectPath, context: projectContext, target: deployCfg.target });
    }

    // --- Deploy -------------------------------------------------------------
    const summaryBits = [`${queue.phases.filter((p) => p.status === 'passed').length}/${queue.phases.length} prompts built and tested`];
    if (degraded.length) summaryBits.push(`${degraded.length} could not be completed (${degraded.join(', ')})`);

    if (securityBlocked) {
      const msg = `${projectName}: security gate blocked publication. ${summaryBits.join('; ')}.`;
      await sendNotification(`${projectName} — blocked before going public`, msg, null, 'error');
      finishProjectInBacklog('failed', { message: msg });
      return { status: 'stuck', message: msg, exitCode: 2 };
    }

    if (!deployCfg.enabled) {
      const msg = `${projectName} built. ${summaryBits.join('; ')}. (Deploy is off.)`;
      await sendNotification(`${projectName} build complete`, msg, null, degraded.length ? 'error' : 'success');
      finishProjectInBacklog('done', { message: msg });
      return { status: degraded.length ? 'passed_with_issues' : 'passed_all', message: msg, exitCode: 0 };
    }

    // Only skip a redeploy when the tree that went live is still the tree we
    // have. A resume that revived a phase, or a design/security round, creates
    // new commits — publishing must happen again or we would report success
    // while the public site still serves the old build.
    const headNow = headCommit(projectPath);
    if (state.deploy.status === 'live' && state.deploy.pages_url
      && queue.deploy_state?.commit && queue.deploy_state.commit === headNow) {
      logger.log(`Skipping deploy — already live at ${state.deploy.pages_url} and nothing changed since.`);
      logger.event('deploy_skipped', { pages_url: state.deploy.pages_url, commit: headNow });
      const msg = `${projectName} was already live at ${state.deploy.pages_url}`;
      finishProjectInBacklog('done', { message: msg, pages_url: state.deploy.pages_url });
      return { status: 'passed_all', message: msg, exitCode: 0 };
    }
    if (state.deploy.status === 'live') {
      logger.log('The project has new commits since it last went live — redeploying.');
      state.deploy.status = 'pending';
      state.deploy.retries = 0;
    }

    const deployed = await runDeployStage({ projectPath, projectName, repoName, deployCfg, context: projectContext });
    if (!deployed.ok) {
      const msg = `${projectName}: could not get the site live. ${truncate(deployed.evidence || '', 200)}`;
      await sendNotification(`${projectName} — deploy failed`, msg, null, 'error');
      finishProjectInBacklog('failed', { message: msg });
      return { status: 'stuck', message: msg, exitCode: 2 };
    }

    const msg = `${summaryBits.join('; ')}. Live at ${state.deploy.pages_url}`;
    await sendNotification(
      degraded.length ? `${projectName} is LIVE (with ${degraded.length} unfinished step${degraded.length > 1 ? 's' : ''})` : `${projectName} is LIVE`,
      msg, state.deploy.pages_url, degraded.length ? 'info' : 'success'
    );
    finishProjectInBacklog('done', { message: msg, pages_url: state.deploy.pages_url, repo_url: state.deploy.repo_url });
    return {
      status: degraded.length ? 'passed_with_issues' : 'passed_all',
      message: `${projectName}: ${msg}`,
      exitCode: 0,
    };
  }

  function finishProjectInBacklog(status, result) {
    if (queue.backlog_id) markStatus(opts.backlog, queue.backlog_id, status, { result });
  }

  function appendState(projectState, phase, summary) {
    const line = `- ${phase.title || phase.id}: ${truncate(String(summary || 'done'), 300)}`;
    const next = `${projectState}\n${line}`.trim();
    return next.length > 2500 ? next.slice(-2500) : next;
  }

  // --- One prompt, through the whole escalation ladder ----------------------
  async function runPhase({ phase, index, projectPath, projectName, context, projectState, regression }) {
    const label = phase.title ? `${phase.id} — ${phase.title}` : phase.id;
    logger.section(`PHASE ${label} (${index + 1}/${queue.phases.length})`);
    logger.block(`prompt for ${phase.id}:`, phase.prompt);
    logger.event('phase_start', { phase: phase.id, title: phase.title || phase.id, index, total: queue.phases.length, prompt: phase.prompt });

    phase.status = 'running';
    const goodCommit = headCommit(projectPath); // where a fresh_start rolls back to
    const history = [];
    let lastEvidence = '';   // stays empty while only the SESSION has failed
    let lastAutoResults = {};
    let lastVerdict = null;
    let diagnosis = null;
    syncState({ current_phase: phase.id, attempt: phase.retries + 1, stage: 'building' });
    persist();

    while (true) {
      await assertBudget(`${phase.id}`);
      const attempt = phase.retries + 1;
      const strategy = escalationFor(attempt, maxAttempts);
      logger.log(`Running ${phase.id}, attempt ${attempt}/${maxAttempts} (strategy: ${strategy})`);
      logger.event('attempt_start', { phase: phase.id, attempt, max_attempts: maxAttempts, kind: strategy });

      // --- rung: read-only root-cause analysis before the next build round ---
      if (strategy === 'diagnosis' && !diagnosis) {
        setActivity('debugger', `${phase.id}: debugger hunting the root cause`);
        say('orchestrator', 'debugger', phase.id, 'inject', `${attempt - 1} fixes failed. Find the real cause — change nothing.`);
        logger.event('claude_start', { phase: phase.id, agent: 'debugger', attempt });
        const dbg = await runDebugger({
          projectPath, config, onSpawn, phase: phase.id, context, prompt: phase.prompt,
          history: history.join('\n\n') || lastEvidence, capabilities: capsText,
        });
        trackCall(dbg);
        diagnosis = dbg.diagnosis;
        logger.event('diagnosis', { phase: phase.id, attempt, diagnosis: diagnosis || null, ok: dbg.ok, duration_ms: dbg.durationMs, cost_usd: dbg.parsed?.total_cost_usd ?? null });
        say('debugger', 'orchestrator', phase.id, diagnosis ? 'report' : 'error',
          diagnosis ? `Root cause: ${truncate(String(diagnosis.root_cause || ''), 400)}` : 'I could not produce a diagnosis.');
      }

      // --- rung: throw the broken work away and start this prompt over -------
      let reverted = false;
      if (strategy === 'fresh_start' && goodCommit) {
        reverted = revertTo(projectPath, goodCommit);
        logger.log(`fresh start: ${reverted ? `reverted to ${goodCommit.slice(0, 8)}` : 'revert failed, continuing on the current tree'}`);
        logger.event('revert', { phase: phase.id, attempt, commit: goodCommit, ok: reverted });
        if (reverted) say('orchestrator', 'builder', phase.id, 'revert', `Rolled back to the last good commit. Start over and take a different approach.`);
      }

      let lessonsText = '';
      if (lessonsEnabled && (strategy === 'lessons' || strategy === 'fresh_start') && lastEvidence) {
        lessonsText = formatLessons(findLessons(lessonsFile, lastEvidence, 3));
        if (lessonsText) logger.event('lessons_used', { phase: phase.id, attempt });
      }

      // 1. BUILDER does the work.
      setActivity('builder', `${phase.id}: builder working (attempt ${attempt}${strategy === 'initial' ? '' : `, ${strategy}`})`, { attempt });
      say('orchestrator', 'builder', phase.id, strategy === 'initial' ? 'inject' : 'fix',
        strategy === 'initial' ? `New task: ${phase.title || phase.id}` : `Attempt ${attempt} — ${strategy.replace('_', ' ')}.`);
      logger.event('claude_start', { phase: phase.id, agent: 'builder', attempt, kind: strategy });

      // With no failure evidence yet (the session itself kept dying), a "fix"
      // prompt would carry nothing to fix — resend the real task instead.
      const build = (strategy === 'initial' || !lastEvidence)
        ? await runBuilder({
          projectPath, config, onSpawn, phase: phase.id, index, total: queue.phases.length,
          context, prompt: phase.prompt, capabilities: capsText, projectState,
        })
        : await runBuilderFix({
          projectPath, config, onSpawn,
          fixPrompt: buildFixPrompt({
            originalPrompt: phase.prompt, autoResults: lastAutoResults, verdict: lastVerdict, config,
            strategy, lessons: lessonsText, diagnosis, attemptHistory: history.join('\n\n'), reverted,
          }),
        });
      trackCall(build);

      if (!build.ok) {
        logger.log(`Builder call FAILED: ${build.error}`);
        if (build.stderr) logger.block('builder stderr:', truncate(build.stderr, 4000));
        logger.event('claude_error', { phase: phase.id, agent: 'builder', attempt, error: build.error, duration_ms: build.durationMs });
        say('builder', 'orchestrator', phase.id, 'error', `My session failed: ${truncate(build.error, 300)}`);
        history.push(`attempt ${attempt} (${strategy}): the builder session itself failed — ${truncate(build.error, 300)}`);
        const done = await consumeAttempt(phase, `the builder session kept failing (${truncate(build.error, 150)})`);
        if (done) return { passed: false };
        continue;
      }

      const resultText = String(build.parsed?.result ?? '').trim();
      const reportSummary = build.report?.summary || resultText.slice(0, 300) || '(no report)';
      logger.log(`Builder finished in ${formatDuration(build.durationMs)} (cost $${build.parsed?.total_cost_usd ?? '?'})`);
      if (resultText) logger.block('builder result:', truncate(resultText, 4000));
      logger.event('claude_done', {
        phase: phase.id, agent: 'builder', attempt, ok: true,
        duration_ms: build.durationMs, cost_usd: build.parsed?.total_cost_usd ?? null,
        num_turns: build.parsed?.num_turns ?? null, result: truncate(resultText, 2000), report: build.report || null,
      });
      say('builder', 'orchestrator', phase.id, 'report', `Done. ${truncate(reportSummary, 400)}`);

      if (stopRequested()) stopNow();

      // 2. Auto-detected checks — exit codes never hallucinate.
      setActivity(null, `${phase.id}: running automated checks`);
      logger.event('verify_start', { phase: phase.id, attempt });
      const verification = await verifyPhase(projectPath, config, logger, phase.id, stopRequested);
      if (verification.aborted) stopNow();
      lastAutoResults = verification.results;
      const failedSteps = Object.entries(verification.results).filter(([, r]) => !r.passed).map(([n]) => n);
      const checkNames = Object.keys(verification.results);
      logger.event('verify_result', { phase: phase.id, attempt, all_passed: verification.allPassed, steps: checkNames, failed_steps: failedSteps });
      say('orchestrator', 'orchestrator', phase.id, 'checks',
        checkNames.length
          ? `Automated checks (${checkNames.join(', ')}): ${verification.allPassed ? 'all passed' : `FAILED ${failedSteps.join(', ')}`}`
          : 'No automated checks apply to this project yet.');

      lastVerdict = null;
      if (verification.allPassed) {
        if (stopRequested()) stopNow();
        // 3. TESTER verifies the builder's claims — and the earlier ones.
        if (testerEnabled) {
          await assertBudget(`${phase.id} tester`);
          const before = treeHash(projectPath);
          setActivity('tester', `${phase.id}: tester verifying the work`);
          say('orchestrator', 'tester', phase.id, 'test_request',
            `Builder says: "${truncate(reportSummary, 200)}". Verify it${regression.length ? `, plus ${regression.length} earlier criteria` : ''}.`);
          logger.event('claude_start', { phase: phase.id, agent: 'tester', attempt });
          const test = await runTester({
            projectPath, config, onSpawn, phase: phase.id, context, prompt: phase.prompt,
            report: build.report, builderResult: resultText,
            autoSummary: checkNames.length ? `${checkNames.join(', ')} — all exited 0` : 'none applied',
            capabilities: capsText, regression: regression.slice(-8),
          });
          trackCall(test);
          lastVerdict = test.verdict;

          // The tester was told to judge, not repair. If the tree moved, its
          // PASS is not trustworthy — it may have fixed what it was grading.
          const after = treeHash(projectPath);
          if (before && after && before !== after && lastVerdict.pass) {
            lastVerdict = {
              ...lastVerdict, pass: false,
              summary: `Tester modified the project while judging it — verdict void. (${lastVerdict.summary})`,
              failures: [...(lastVerdict.failures || []), {
                what: 'The QA agent changed project files instead of only testing them, so its PASS cannot be trusted.',
                evidence: `working tree fingerprint changed during the tester run (${before.slice(0, 8)} -> ${after.slice(0, 8)})`,
                suggested_fix: 'Review what changed, make the behavior correct in the source yourself, and leave the tree exactly as you found it.',
              }],
            };
            logger.event('tester_modified_tree', { phase: phase.id, attempt, before, after });
          }

          logger.log(`Tester verdict: ${lastVerdict.pass ? 'PASS' : 'FAIL'} — ${lastVerdict.summary}`);
          logger.event('verdict', {
            phase: phase.id, attempt, pass: lastVerdict.pass, summary: lastVerdict.summary,
            failures: lastVerdict.failures, criteria: lastVerdict.criteria, source: lastVerdict.source,
            duration_ms: test.durationMs, cost_usd: test.parsed?.total_cost_usd ?? null,
          });
          say('tester', 'orchestrator', phase.id, 'verdict',
            lastVerdict.pass ? `PASS — ${truncate(lastVerdict.summary, 300)}` : `FAIL — ${truncate(lastVerdict.summary, 300)}`);
        } else {
          lastVerdict = { pass: true, summary: 'tester disabled', failures: [], criteria: [] };
        }

        if (lastVerdict.pass) {
          phase.commit_hash = commitPhase(projectPath, phase.id);
          phase.status = 'passed';
          phase.report_summary = truncate(reportSummary, 300);
          phase.criteria = lastVerdict.criteria || [];
          logger.log(`${phase.id} PASSED, commit ${phase.commit_hash}`);
          logger.event('commit', { phase: phase.id, hash: phase.commit_hash });
          logger.event('phase_passed', { phase: phase.id, retries: phase.retries, hash: phase.commit_hash, criteria: phase.criteria });
          say('orchestrator', 'orchestrator', phase.id, 'passed', `${phase.title || phase.id} locked in (commit ${phase.commit_hash.slice(0, 8)}). Moving on.`);
          setActivity(null, `${phase.id} passed (commit ${phase.commit_hash.slice(0, 8)})`);
          persist();

          // What just worked, remembered for future runs of any project.
          if (lessonsEnabled && phase.retries > 0 && lastEvidence) {
            recordLesson(lessonsFile, {
              project: projectName, phase: phase.id, agent: 'builder',
              error: lastEvidence, fix: reportSummary, evidence: truncate(history.join('\n'), 1200),
            });
          }
          return { passed: true, summary: reportSummary, criteria: phase.criteria };
        }
      }

      // 4. Failed — record the evidence and climb the ladder.
      const reason = failedSteps.length ? `checks: ${failedSteps.join(', ')}` : `tester: ${lastVerdict?.summary || 'rejected'}`;
      lastEvidence = evidenceSections(lastAutoResults, lastVerdict, 4000).join('\n\n') || reason;
      history.push(`attempt ${attempt} (${strategy}) failed — ${truncate(reason, 400)}`);
      logger.log(`${phase.id} failed (${reason}).`);
      const done = await consumeAttempt(phase, reason);
      if (done) return { passed: false };
    }
  }


  // Shared retry accounting. Returns true when the phase is finished (degraded
  // or the run halted) and the caller should stop looping.
  async function consumeAttempt(phase, reason) {
    phase.retries += 1;
    if (phase.retries >= maxAttempts) {
      if (onStuck === 'halt') {
        phase.status = 'stuck';
        logger.event('phase_stuck', { phase: phase.id, retries: phase.retries, reason });
        persist();
        await finish('stuck', `${phase.id} stuck after ${phase.retries} attempts (${reason}).`, 2);
        return true;
      }
      // Hands-free: record the failure honestly and keep building the rest.
      phase.status = 'degraded';
      logger.log(`${phase.id} DEGRADED after ${phase.retries} attempts (${reason}). Continuing with the remaining prompts.`);
      logger.event('phase_degraded', { phase: phase.id, retries: phase.retries, reason });
      say('orchestrator', 'orchestrator', phase.id, 'degraded',
        `Could not complete ${phase.title || phase.id} after ${phase.retries} attempts (${truncate(reason, 200)}). Moving on — this will be in the final report.`);
      persist();
      return true;
    }
    phase.status = 'failed_retry';
    setActivity(null, `${phase.id} failed (${truncate(reason, 120)}) — retrying ${phase.retries}/${maxRetries}`);
    persist();
    if (stopRequested()) stopNow();
    phase.status = 'running';
    return false;
  }

  // --- Design --------------------------------------------------------------
  async function runDesignStage({ projectPath, context }) {
    let previousIssues = [];
    for (let round = 1; round <= (designCfg.rounds || 1); round++) {
      if (stopRequested()) stopNow();
      await assertBudget('design');
      logger.section(`DESIGN REVIEW round ${round}/${designCfg.rounds}`);
      setActivity('designer', `design review round ${round} — looking at real screenshots`, { stage: 'design', current_phase: 'design' });
      say('orchestrator', 'designer', 'design', 'inject', `Look at the built site and fix what looks bad (round ${round}).`);
      logger.event('claude_start', { phase: 'design', agent: 'designer', attempt: round });

      const des = await runDesigner({ projectPath, config, onSpawn, context, capabilities: capsText, round, rounds: designCfg.rounds || 1, previousIssues });
      trackCall(des);
      const d = des.design;
      logger.event('design_result', {
        round, ok: des.ok, design: d || null,
        duration_ms: des.durationMs, cost_usd: des.parsed?.total_cost_usd ?? null,
      });

      if (!d) {
        say('designer', 'orchestrator', 'design', 'error', 'I could not complete the design review.');
        logger.log('Design round produced no report — continuing.');
        break;
      }
      say('designer', 'orchestrator', 'design', 'report',
        `Design ${d.score_before ?? '?'}→${d.score_after ?? '?'}/10. Fixed ${(d.changes_made || []).length} thing(s)${(d.remaining_issues || []).length ? `, ${(d.remaining_issues || []).length} left` : ''}.`);
      previousIssues = d.remaining_issues || [];

      // The designer edited real files — re-gate them and keep the commit
      // history one-change-per-commit.
      const verification = await verifyPhase(projectPath, config, logger, 'design', stopRequested);
      if (verification.aborted) stopNow();
      if (!verification.allPassed) {
        const failed = Object.entries(verification.results).filter(([, r]) => !r.passed).map(([n]) => n);
        logger.log(`Design round ${round} broke automated checks (${failed.join(', ')}) — reverting the design changes.`);
        logger.event('design_reverted', { round, failed_steps: failed });
        revertTo(projectPath, headCommit(projectPath));
        say('orchestrator', 'orchestrator', 'design', 'revert', `Design changes broke ${failed.join(', ')} — rolled them back.`);
        break;
      }
      const hash = commitPhase(projectPath, 'design', `auto: design review round ${round}`);
      logger.event('commit', { phase: 'design', hash, round });
      if (!previousIssues.length) break; // nothing left worth another round
    }
  }

  // --- Security ------------------------------------------------------------
  // Returns true when publication must be blocked.
  async function runSecurityStage({ projectPath, context, target }) {
    // Whatever the agent returns, the orchestrator handles a list.
    const asFindings = (v) => (Array.isArray(v) ? v : v == null ? [] : [v])
      .map((c) => (c && typeof c === 'object' ? c : { what: String(c) }));

    for (let round = 1; round <= securityCfg.max_fix_rounds + 1; round++) {
      if (stopRequested()) stopNow();
      await assertBudget('security');
      logger.section(`SECURITY GATE (round ${round})`);
      setActivity('security', 'security gate — checking before anything goes public', { stage: 'security', current_phase: 'security' });
      say('orchestrator', 'security', 'security', 'inject', 'Last check before this goes public.');
      logger.event('claude_start', { phase: 'security', agent: 'security', attempt: round });

      const sec = await runSecurity({ projectPath, config, onSpawn, context, capabilities: capsText, target });
      trackCall(sec);
      const s = sec.security;
      logger.event('security_result', {
        round, ok: sec.ok, security: s || null,
        duration_ms: sec.durationMs, cost_usd: sec.parsed?.total_cost_usd ?? null,
      });

      if (!s) {
        // No report is not a licence to publish blind, but it is also not
        // evidence of a leak — warn loudly and continue.
        say('security', 'orchestrator', 'security', 'error', 'I could not complete the audit — no report written.');
        logger.log('Security agent wrote no report; continuing to deploy with a warning.');
        return false;
      }

      const critical = asFindings(s.critical);
      // An explicit boolean is required, exactly as the tester's verdict is:
      // "false", 1, "no" or a missing field must never read as permission to
      // publish, and a stated failure outranks an empty findings list.
      const passed = s.pass === true && !critical.length;
      say('security', 'orchestrator', 'security', passed ? 'verdict' : 'error',
        `${passed ? 'PASS' : 'BLOCKED'} — ${truncate(s.summary || '', 300)}${critical.length ? ` (${critical.length} critical)` : ''}`);

      // The security agent may edit files (removing a secret is its one allowed
      // repair) — re-gate those edits the same way the designer's are.
      if (asFindings(s.changes_made).length) {
        const before = headCommit(projectPath);
        const v = await verifyPhase(projectPath, config, logger, 'security', stopRequested);
        if (v.aborted) stopNow();
        if (v.allPassed) {
          commitPhase(projectPath, 'security', 'auto: security agent removed a secret');
        } else {
          const failed = Object.entries(v.results).filter(([, r]) => !r.passed).map(([n]) => n);
          logger.event('security_reverted', { round, failed_steps: failed });
          revertTo(projectPath, before);
          say('orchestrator', 'orchestrator', 'security', 'revert', `The security agent's edits broke ${failed.join(', ')} — rolled them back.`);
        }
      }

      if (passed) return false;
      if (round > securityCfg.max_fix_rounds) break;
      if (!securityCfg.block_deploy) return false;

      // Send it back to a builder to repair, then audit again.
      await assertBudget('security fix');
      const blockedBy = critical.length ? `${critical.length} critical finding(s)` : truncate(s.summary || 'a stated failure', 120);
      setActivity('builder', `security: builder fixing ${blockedBy}`);
      say('orchestrator', 'builder', 'security', 'fix', `Security blocked release: ${truncate(critical.map((c) => c.what).join('; ') || s.summary || '', 300)}`);
      const fix = await runBuilderFix({ projectPath, config, onSpawn, fixPrompt: buildSecurityFixPrompt({ security: { ...s, critical }, context }) });
      trackCall(fix);
      logger.event('claude_done', { phase: 'security', agent: 'builder', attempt: round, ok: fix.ok, duration_ms: fix.durationMs, cost_usd: fix.parsed?.total_cost_usd ?? null, report: fix.report || null });
      const verification = await verifyPhase(projectPath, config, logger, 'security', stopRequested);
      if (verification.aborted) stopNow();
      if (verification.allPassed) commitPhase(projectPath, 'security', 'auto: security fixes');
    }
    logger.event('security_blocked', {});
    return securityCfg.block_deploy !== false;
  }

  // --- Deploy --------------------------------------------------------------
  async function runDeployStage({ projectPath, projectName, repoName, deployCfg, context }) {
    const target = pickDeployTarget(capabilities, deployCfg.target);
    if (target === 'none') {
      const evidence = 'No deployment platform is available and authenticated on this machine (checked GitHub, Vercel, Netlify).';
      logger.event('deploy_unavailable', { evidence });
      state.deploy.status = 'failed';
      syncState();
      return { ok: false, evidence };
    }

    logger.section(`DEPLOY — ${projectName} to ${target}`);
    logger.event('deploy_start', { repo_name: repoName, visibility: deployCfg.visibility, target });
    state.deploy.status = 'deploying';
    state.deploy.target = target;
    syncState({ stage: 'deploy', current_phase: 'deploy' });
    let fixPrompt = null;

    while (true) {
      if (stopRequested()) stopNow();
      await assertBudget('deploy');
      const attempt = state.deploy.retries + 1;
      setActivity('deployer', `deploy: attempt ${attempt} — publishing to ${target}`);
      say('orchestrator', 'deployer', 'deploy', fixPrompt ? 'fix' : 'inject',
        fixPrompt ? `Still not live — fix it (attempt ${attempt}).` : `Project verified. Ship "${repoName}" to ${target}.`);
      logger.event('claude_start', { phase: 'deploy', agent: 'deployer', attempt });

      const dep = await runDeployer({
        projectPath, config, onSpawn, projectName, repoName,
        visibility: deployCfg.visibility, context, capabilities: capsText, target, fixPrompt,
      });
      trackCall(dep);

      const info = dep.deploy;
      logger.event('claude_done', {
        phase: 'deploy', agent: 'deployer', attempt, ok: dep.ok,
        duration_ms: dep.durationMs, cost_usd: dep.parsed?.total_cost_usd ?? null,
        result: truncate(String(dep.parsed?.result ?? ''), 2000), deploy: info || null,
      });
      say('deployer', 'orchestrator', 'deploy', 'report',
        info ? `${info.target || target}: ${info.pages_url || '?'} (live: ${info.live})` : 'I did not write a deploy report.');

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
          setActivity('deployer', `deploy: verifying ${info.pages_url} really serves the site`);
          logger.event('live_check_start', { url: info.pages_url, timeout_ms: deployCfg.live_timeout_ms });
          const live = await waitUntilLive(info.pages_url, {
            timeoutMs: deployCfg.live_timeout_ms,
            shouldStop: stopRequested,
            onAttempt: (r) => setActivity('deployer', `deploy: ${info.pages_url} -> ${r.detail}`),
          });
          if (live.aborted) stopNow();
          logger.event('live_check_result', { url: info.pages_url, live: live.live, evidence: truncate(live.evidence, 4000) });
          if (!live.live) evidence = `Independent live check failed.\n${live.evidence}`;
        } else if (info.live !== true) {
          evidence = 'Your deploy report says "live" is not true.';
        }
      }

      if (!evidence) {
        state.deploy.status = 'live';
        // The commit identity is what makes the skip-on-rerun safe.
        queue.deploy_state = {
          status: 'live',
          repo_url: state.deploy.repo_url,
          pages_url: state.deploy.pages_url,
          commit: headCommit(projectPath),
        };
        syncState();
        persist();
        logger.log(`DEPLOY VERIFIED LIVE: ${state.deploy.pages_url}`);
        logger.event('deploy_done', { repo_url: state.deploy.repo_url, pages_url: state.deploy.pages_url, target });
        say('orchestrator', 'orchestrator', 'deploy', 'passed', `Site verified live (assets included) at ${state.deploy.pages_url}`);
        return { ok: true };
      }

      logger.log(`Deploy attempt ${attempt} not live: ${truncate(evidence, 500)}`);
      state.deploy.retries += 1;
      if (state.deploy.retries >= maxAttempts) {
        state.deploy.status = 'failed';
        syncState();
        logger.event('deploy_stuck', { retries: state.deploy.retries, evidence: truncate(evidence, 3000) });
        return { ok: false, evidence };
      }
      fixPrompt = buildDeployFixPrompt({
        deployInfo: info, evidence, projectName, repoName, visibility: deployCfg.visibility, target,
      });
      logger.event('fix_prompt', { phase: 'deploy', attempt: state.deploy.retries + 1, prompt: fixPrompt });
      syncState();
    }
  }
}

main();
