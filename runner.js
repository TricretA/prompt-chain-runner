#!/usr/bin/env node
'use strict';
// Autonomous Prompt-Chain Runner — the orchestrator.
//
// Reads an ordered phase queue, sends each phase to Claude Code unattended,
// gates it behind real verification commands, auto-retries with error-driven
// fix prompts, commits passing phases to git, and halts (never skips ahead)
// when a phase gets stuck. Fully resumable: rerun and already-passed phases
// are skipped.
//
// Usage:
//   node runner.js [--queue prompts/queue.json] [--config config.json]
//                  [--logs logs] [--state state.json]
//                  [--retry-stuck] [--dry-run]
//
// Exit codes: 0 all phases passed · 1 runner error (incl. another runner
//             already active) · 2 a phase is stuck · 3 stopped via stop flag
//             or signal

const fs = require('fs');
const path = require('path');
const { readJson, runStamp, formatDuration, truncate } = require('./lib/util');
const { Logger } = require('./lib/logger');
const { writeState } = require('./lib/state');
const { loadQueue, saveQueue } = require('./lib/queue');
const { ensureGitRepo, commitPhase } = require('./lib/git');
const { verifyPhase } = require('./lib/verify');
const { runClaudeCode, killActiveClaude } = require('./lib/claude');
const { buildFixPrompt } = require('./lib/fix-prompt');

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
  console.log(`Prompt Chain Runner
  node runner.js [options]

  --queue <file>    phase queue (default prompts/queue.json)
  --config <file>   settings (default config.json)
  --logs <dir>      log directory (default logs/)
  --state <file>    live state file for the dashboard (default state.json)
  --retry-stuck     reset phases marked "stuck" back to pending and retry them
  --dry-run         validate config + queue and print the plan, execute nothing`);
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Exactly one runner per state file. Two concurrent runners would drive two
// unattended Claude Code sessions in the same working tree, cross-commit each
// other's half-finished edits, and clobber queue.json last-writer-wins.
// O_EXCL create makes the guard atomic; a lock held by a dead pid is stolen.
function acquireLock(lockFile) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      return null;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let otherPid = null;
      try { otherPid = parseInt(fs.readFileSync(lockFile, 'utf8'), 10); } catch { /* unreadable = stale */ }
      if (otherPid && pidAlive(otherPid)) return otherPid;
      try { fs.rmSync(lockFile, { force: true }); } catch { /* retry will surface it */ }
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
  const queue = loadQueue(opts.queue); // throws with a clear message on bad queues

  // Relative project paths resolve against the runner root, matching the
  // documented layout (queue lives in prompts/, project in target-project/).
  const projectPath = path.isAbsolute(queue.project_path)
    ? queue.project_path
    : path.resolve(ROOT, queue.project_path);

  if (opts.dryRun) {
    console.log('Dry run — nothing will be executed.\n');
    console.log(`Project path: ${projectPath}`);
    console.log(`Verification steps: ${(config.verification_steps || []).map((s) => s.name).join(', ') || '(none)'}`);
    console.log(`Max retries per phase: ${config.max_retries ?? 4}\n`);
    for (const p of queue.phases) {
      console.log(`  [${p.status}] ${p.id} (retries so far: ${p.retries})`);
      console.log(`      ${p.prompt.split('\n')[0].slice(0, 100)}`);
    }
    console.log('\nQueue and config are valid.');
    process.exit(0);
  }

  fs.mkdirSync(projectPath, { recursive: true });

  const lockFile = path.join(path.dirname(opts.state), '.runner.lock');
  const lockHolder = acquireLock(lockFile);
  if (lockHolder !== null) {
    console.error(`Another runner${lockHolder > 0 ? ` (pid ${lockHolder})` : ''} is already active for this queue. Refusing to start a second one.`);
    process.exit(1);
  }
  const releaseLock = () => { try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ } };
  process.on('exit', releaseLock);

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
    log_file: path.basename(logger.logFile),
    events_file: path.basename(logger.eventsFile),
    current_phase: null,
    claude_pid: null,
    attempt: 0,
    message: 'starting',
    totals,
    phases: [],
  };

  const syncState = (patch = {}) => {
    Object.assign(state, patch);
    state.phases = queue.phases.map((p) => ({
      id: p.id,
      status: p.status,
      retries: p.retries,
      commit_hash: p.commit_hash,
    }));
    writeState(opts.state, state);
  };

  const persist = () => saveQueue(opts.queue, queue);

  const finish = (status, message, exitCode) => {
    // Never leave an unattended Claude Code session editing the project after
    // the runner itself is gone.
    if (status !== 'passed_all') killActiveClaude();
    logger.section(`RUN ${status.toUpperCase()}: ${message}`);
    logger.event('run_done', { status, message });
    syncState({ status, message, current_phase: null, claude_pid: null });
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
  logger.log(`Queue:   ${opts.queue}`);
  logger.log(`Config:  ${opts.config}`);
  logger.log(`Project: ${projectPath}`);
  logger.log(`Phases:  ${queue.phases.length} total, ${queue.phases.filter((p) => p.status === 'passed').length} already passed`);
  logger.event('run_start', {
    run_id: runId,
    queue_file: opts.queue,
    project_path: projectPath,
    phases: queue.phases.map((p) => p.id),
    max_retries: maxRetries,
  });
  syncState({ message: 'run started' });
  persist();

  runPhases().catch((err) => {
    logger.log(`FATAL: ${err.stack || err.message || err}`);
    logger.event('run_error', { error: String(err.stack || err.message || err) });
    finish('error', `Runner crashed: ${err.message || err}`, 1);
  });

  // --- The main loop --------------------------------------------------------
  async function runPhases() {
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

      logger.section(`PHASE ${phase.id} (${i + 1}/${queue.phases.length})`);
      logger.block(`prompt for ${phase.id}:`, phase.prompt);
      logger.event('phase_start', { phase: phase.id, index: i, total: queue.phases.length, prompt: phase.prompt });

      phase.status = 'running';
      let currentPrompt = phase.prompt;
      let promptKind = 'initial';
      syncState({ current_phase: phase.id, attempt: phase.retries + 1, message: `running ${phase.id}` });
      persist();

      while (true) {
        const attempt = phase.retries + 1;
        logger.log(`Running ${phase.id}, attempt ${attempt}/${maxRetries + 1} (${promptKind} prompt)`);
        logger.event('attempt_start', { phase: phase.id, attempt, max_attempts: maxRetries + 1, kind: promptKind });
        syncState({ attempt, message: `${phase.id}: attempt ${attempt} — calling Claude Code` });

        // 1. Send the prompt to Claude Code.
        logger.event('claude_start', { phase: phase.id, attempt, prompt_chars: currentPrompt.length });
        const claude = await runClaudeCode({
          prompt: currentPrompt,
          cwd: projectPath,
          config,
          // Recorded so the dashboard's Kill can take the Claude tree down too.
          onSpawn: (pid) => syncState({ claude_pid: pid }),
        });
        state.claude_pid = null;
        totals.claude_calls += 1;
        totals.claude_ms += claude.durationMs;
        if (claude.parsed && typeof claude.parsed.total_cost_usd === 'number') {
          totals.cost_usd = Math.round((totals.cost_usd + claude.parsed.total_cost_usd) * 10000) / 10000;
        }

        if (claude.ok) {
          const resultText = String(claude.parsed?.result ?? '').trim();
          logger.log(`Claude Code finished in ${formatDuration(claude.durationMs)} (cost $${claude.parsed?.total_cost_usd ?? '?'}, turns ${claude.parsed?.num_turns ?? '?'})`);
          if (resultText) logger.block('Claude Code result:', truncate(resultText, 4000));
          logger.event('claude_done', {
            phase: phase.id,
            attempt,
            ok: true,
            duration_ms: claude.durationMs,
            cost_usd: claude.parsed?.total_cost_usd ?? null,
            num_turns: claude.parsed?.num_turns ?? null,
            result: truncate(resultText, 2000),
          });
        } else {
          // The CLI call itself failed (crash, timeout, not installed). There is
          // no verification output to build a fix prompt from — retry the same
          // prompt, and let max_retries bound it.
          logger.log(`Claude Code call FAILED: ${claude.error}`);
          if (claude.stderr) logger.block('Claude Code stderr:', truncate(claude.stderr, 4000));
          logger.event('claude_error', { phase: phase.id, attempt, error: claude.error, duration_ms: claude.durationMs });

          phase.retries += 1;
          if (phase.retries > maxRetries) {
            phase.status = 'stuck';
            logger.log(`${phase.id} STUCK after ${phase.retries} attempts (Claude Code kept failing). Halting run.`);
            logger.event('phase_stuck', { phase: phase.id, retries: phase.retries, reason: 'claude_call_failed' });
            persist();
            finish('stuck', `${phase.id} stuck: Claude Code call kept failing. Last error: ${claude.error}`, 2);
          }
          phase.status = 'failed_retry';
          promptKind = 'retry_same';
          syncState({ message: `${phase.id}: Claude call failed, retrying (${phase.retries}/${maxRetries})` });
          persist();
          if (stopRequested()) stopNow();
          phase.status = 'running';
          continue;
        }

        if (stopRequested()) stopNow();

        // 2. Verify with real commands — never trust "done".
        logger.log(`Verifying ${phase.id} ...`);
        logger.event('verify_start', { phase: phase.id, attempt, steps: (config.verification_steps || []).map((s) => s.name) });
        syncState({ message: `${phase.id}: attempt ${attempt} — verifying` });
        const verification = await verifyPhase(projectPath, config, logger, phase.id, stopRequested);
        if (verification.aborted) stopNow();
        const failedSteps = Object.entries(verification.results).filter(([, r]) => !r.passed).map(([n]) => n);
        logger.event('verify_result', { phase: phase.id, attempt, all_passed: verification.allPassed, failed_steps: failedSteps });

        if (verification.allPassed) {
          // 3. Commit and move on.
          phase.commit_hash = commitPhase(projectPath, phase.id);
          phase.status = 'passed';
          logger.log(`${phase.id} PASSED all verification, commit ${phase.commit_hash}`);
          logger.event('commit', { phase: phase.id, hash: phase.commit_hash });
          logger.event('phase_passed', { phase: phase.id, retries: phase.retries, hash: phase.commit_hash });
          syncState({ message: `${phase.id} passed (commit ${phase.commit_hash.slice(0, 8)})` });
          persist();
          break;
        }

        // 4. Verification failed — build a fix prompt from the exact errors.
        phase.retries += 1;
        logger.log(`${phase.id} failed verification (steps: ${failedSteps.join(', ')}). Retry ${phase.retries}/${maxRetries}.`);

        if (phase.retries > maxRetries) {
          phase.status = 'stuck';
          logger.log(`${phase.id} STUCK after ${phase.retries} attempts. Halting run — later phases likely depend on this one.`);
          logger.event('phase_stuck', { phase: phase.id, retries: phase.retries, reason: 'verification_failed', failed_steps: failedSteps });
          persist();
          finish('stuck', `${phase.id} stuck after ${phase.retries} attempts. Failed steps: ${failedSteps.join(', ')}. See the log for full output.`, 2);
        }

        phase.status = 'failed_retry';
        currentPrompt = buildFixPrompt(phase.prompt, verification.results, config);
        promptKind = 'fix';
        logger.block(`fix prompt for ${phase.id} (attempt ${phase.retries + 1}):`, truncate(currentPrompt, 6000));
        logger.event('fix_prompt', { phase: phase.id, attempt: phase.retries + 1, prompt: currentPrompt });
        syncState({ message: `${phase.id}: verification failed (${failedSteps.join(', ')}), retrying ${phase.retries}/${maxRetries}` });
        persist();
        if (stopRequested()) stopNow();
        phase.status = 'running';
      }
    }

    finish('passed_all', 'All phases complete.', 0);
  }
}

main();
