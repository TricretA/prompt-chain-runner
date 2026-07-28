#!/usr/bin/env node
'use strict';
// End-to-end tests for the orchestrator. The real Claude Code CLI is replaced
// by test/mock-claude.js, but everything else is real: real child processes,
// real shell verification commands, real git commits, real queue/state files,
// real HTTP for the dashboard API and the live check.
//
// Run: node test/run-tests.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(__dirname, '.tmp');
const MOCK = path.join(__dirname, 'mock-claude.js');
const CHECK = path.join(__dirname, 'check.js');

let passed = 0;
const failures = [];
const tests = [];

function readJson(f) { return JSON.parse(fs.readFileSync(f, 'utf8')); }

// OneDrive/AV can hold transient locks on just-written files; a plain rmSync
// then throws EBUSY/EPERM and takes the whole suite down. Retry briefly.
function rmrf(target) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return;
    } catch (err) {
      if (attempt >= 4) throw err;
      const end = Date.now() + 200 * (attempt + 1);
      while (Date.now() < end) { /* brief blocking wait */ }
    }
  }
}

function setupCase(name, { phases, calls, queueExtra = {}, config = {} }) {
  const dir = path.join(TMP, name);
  rmrf(dir);
  const project = path.join(dir, 'target');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'mock-scenario.json'), JSON.stringify({ calls }, null, 2));

  const queueFile = path.join(dir, 'queue.json');
  fs.writeFileSync(queueFile, JSON.stringify({ project_path: project, phases, ...queueExtra }, null, 2));

  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    claude_command: ['node', MOCK],
    claude_timeout_ms: 30000,
    max_retries: 2,
    verify_timeout_ms: 30000,
    verification_steps: [{ name: 'check', command: `node "${CHECK}"` }],
    tester: { enabled: false },
    deploy: { enabled: false },
    notify: { enabled: false },
    ...config,
  }, null, 2));

  return {
    dir,
    project,
    queueFile,
    configFile,
    stateFile: path.join(dir, 'state.json'),
    logsDir: path.join(dir, 'logs'),
  };
}

function runRunner(c, extraArgs = []) {
  return spawnSync('node', [
    path.join(ROOT, 'runner.js'),
    '--queue', c.queueFile,
    '--config', c.configFile,
    '--logs', c.logsDir,
    '--state', c.stateFile,
    ...extraArgs,
  ], { encoding: 'utf8', timeout: 120000 });
}

function claudeCalls(c) {
  const f = path.join(c.project, 'mock-prompts.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function runEvents(c) {
  const files = fs.existsSync(c.logsDir) ? fs.readdirSync(c.logsDir).filter((f) => f.endsWith('.events.jsonl')) : [];
  return files.flatMap((f) =>
    fs.readFileSync(path.join(c.logsDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

function gitLog(c) {
  const res = spawnSync('git', ['-C', c.project, 'log', '--pretty=%H %s'], { encoding: 'utf8' });
  return (res.stdout || '').trim().split('\n').filter(Boolean);
}

function test(name, fn) { tests.push({ name, fn }); }

// ---------------------------------------------------------------- dry run
test('dry-run validates and executes nothing', () => {
  const c = setupCase('dry-run', {
    phases: [{ id: 'p1', prompt: 'build the thing', status: 'pending', retries: 0, commit_hash: null }],
    calls: [{ files: { 'app.txt': 'GOOD' } }],
  });
  const res = runRunner(c, ['--dry-run']);
  assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /Dry run/, 'prints the plan');
  assert.match(res.stdout, /p1/, 'lists phases');
  assert.strictEqual(claudeCalls(c).length, 0, 'no Claude calls in dry run');
  assert.strictEqual(readJson(c.queueFile).phases[0].status, 'pending', 'queue untouched');
  assert.ok(!fs.existsSync(c.stateFile), 'no state written');
});

// ---------------------------------------------------------------- happy path
test('happy path: two phases pass, each gets its own commit', () => {
  const c = setupCase('happy', {
    phases: [
      { id: 'p1', title: 'first', prompt: 'create app.txt saying GOOD' },
      { id: 'p2', prompt: 'update app.txt, keep it GOOD' },
    ],
    calls: [
      { files: { 'app.txt': 'GOOD v1' } },
      { files: { 'app.txt': 'GOOD v2' } },
    ],
  });
  const res = runRunner(c);
  assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}\n${res.stdout}\n${res.stderr}`);

  const queue = readJson(c.queueFile);
  assert.strictEqual(queue.phases[0].status, 'passed');
  assert.strictEqual(queue.phases[1].status, 'passed');
  assert.match(queue.phases[0].commit_hash, /^[0-9a-f]{40}$/, 'p1 commit hash recorded');
  assert.match(queue.phases[1].commit_hash, /^[0-9a-f]{40}$/, 'p2 commit hash recorded');
  assert.notStrictEqual(queue.phases[0].commit_hash, queue.phases[1].commit_hash, 'distinct commits');
  assert.strictEqual(queue.phases[0].retries, 0);

  const log = gitLog(c);
  assert.strictEqual(log.length, 2, `expected 2 commits, got:\n${log.join('\n')}`);
  assert.match(log[0], /auto: p2 passed verification/);
  assert.match(log[1], /auto: p1 passed verification/);
  assert.strictEqual(log[0].split(' ')[0], queue.phases[1].commit_hash, 'HEAD is p2 commit');

  assert.strictEqual(claudeCalls(c).length, 2, 'one builder call per phase (tester disabled)');

  const state = readJson(c.stateFile);
  assert.strictEqual(state.status, 'passed_all');
  assert.strictEqual(state.totals.claude_calls, 2);
  assert.ok(state.totals.cost_usd > 0, 'cost accumulated');
  assert.strictEqual(state.phases[0].title, 'first', 'phase titles surface in state');
  assert.ok(!fs.existsSync(path.join(c.dir, '.runner.lock')), 'lock released after the run');

  // .pcr/ is the agents' mailbox and must never be committed.
  const gitignore = fs.readFileSync(path.join(c.project, '.gitignore'), 'utf8');
  assert.match(gitignore, /\.pcr\//, '.pcr/ is gitignored');
});

// ---------------------------------------------------------------- agent preamble contract
test('builder gets the role preamble, the task, context, and the report instruction', () => {
  const c = setupCase('builder-preamble', {
    phases: [{ id: 'p1', prompt: 'make the landing page' }],
    calls: [{ files: { 'app.txt': 'GOOD' } }],
    queueExtra: { context: 'This is a bakery site.' },
  });
  const res = runRunner(c);
  assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}\n${res.stdout}\n${res.stderr}`);
  const prompt = claudeCalls(c)[0].prompt;
  assert.match(prompt, /BUILDER agent/, 'role preamble present');
  assert.match(prompt, /make the landing page/, 'original task embedded');
  assert.match(prompt, /This is a bakery site\./, 'shared project context embedded');
  assert.match(prompt, /\.pcr\/report\.json/, 'report protocol requested');
  assert.match(prompt, /step 1 of 1/, 'progress position included');
});

// ---------------------------------------------------------------- CLI contract
test('Claude Code is invoked with the exact unattended-mode flags', () => {
  const c = setupCase('cli-contract', {
    phases: [{ id: 'p1', prompt: 'anything' }],
    calls: [{ files: { 'app.txt': 'GOOD' } }],
  });
  const res = runRunner(c);
  assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}\n${res.stdout}\n${res.stderr}`);
  const argv = claudeCalls(c)[0].argv;
  const flat = argv.join(' ');
  assert.ok(argv.includes('-p'), `-p missing from: ${flat}`);
  assert.match(flat, /--output-format json/, `--output-format json missing from: ${flat}`);
  assert.ok(argv.includes('--dangerously-skip-permissions'), `--dangerously-skip-permissions missing from: ${flat}`);
});

// ---------------------------------------------------------------- single-instance lock
test('a second runner refuses to start while the lock is held by a live pid', () => {
  const c = setupCase('lock-live', {
    phases: [{ id: 'p1', prompt: 'anything' }],
    calls: [{ files: { 'app.txt': 'GOOD' } }],
  });
  fs.writeFileSync(path.join(c.dir, '.runner.lock'), String(process.pid));
  const res = runRunner(c);
  assert.strictEqual(res.status, 1, `expected exit 1, got ${res.status}\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /already active/i, 'explains why it refused');
  assert.strictEqual(claudeCalls(c).length, 0, 'no Claude calls made');
  assert.strictEqual(readJson(c.queueFile).phases[0].status ?? 'pending', 'pending', 'queue untouched');
});

test('a lock held by a dead pid is stolen and the run proceeds', () => {
  const c = setupCase('lock-stale', {
    phases: [{ id: 'p1', prompt: 'anything' }],
    calls: [{ files: { 'app.txt': 'GOOD' } }],
  });
  const dead = spawnSync('node', ['-e', ''], { encoding: 'utf8' }); // exits immediately
  fs.writeFileSync(path.join(c.dir, '.runner.lock'), String(dead.pid ?? 999999));
  const res = runRunner(c);
  assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}\n${res.stdout}\n${res.stderr}`);
  assert.strictEqual(readJson(c.queueFile).phases[0].status, 'passed');
});

// ---------------------------------------------------------------- stop between verify steps
test('a stop requested mid-verification skips the remaining steps and never commits', () => {
  const c = setupCase('stop-mid-verify', {
    phases: [{ id: 'p1', prompt: 'anything' }],
    calls: [{ files: { 'app.txt': 'GOOD' } }],
    config: {
      verification_steps: [
        { name: 'check', command: `node "${CHECK}"` },
        { name: 'drop-stop', command: `node "${path.join(__dirname, 'write-stop.js')}"` },
        { name: 'never-runs', command: `node "${CHECK}"` },
      ],
    },
  });
  const res = runRunner(c);
  assert.strictEqual(res.status, 3, `expected exit 3 (stopped), got ${res.status}\n${res.stdout}\n${res.stderr}`);
  assert.strictEqual(readJson(c.stateFile).status, 'stopped');
  assert.ok(!(res.stdout + res.stderr).includes('verify [never-runs]'), 'third step was never run');
  assert.notStrictEqual(readJson(c.queueFile).phases[0].status, 'passed', 'phase not marked passed');
  assert.strictEqual(gitLog(c).length, 0, 'nothing committed');
});

// ---------------------------------------------------------------- retry loop
test('failed verification triggers a fix prompt built from the real errors', () => {
  const c = setupCase('retry', {
    phases: [{ id: 'p1', prompt: 'create app.txt saying GOOD' }],
    calls: [
      { files: { 'app.txt': 'BAD attempt' } },
      { files: { 'app.txt': 'GOOD after fix' } },
    ],
  });
  const res = runRunner(c);
  assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}\n${res.stdout}\n${res.stderr}`);

  const queue = readJson(c.queueFile);
  assert.strictEqual(queue.phases[0].status, 'passed');
  assert.strictEqual(queue.phases[0].retries, 1, 'exactly one retry consumed');

  const calls = claudeCalls(c);
  assert.strictEqual(calls.length, 2);
  assert.match(calls[0].prompt, /create app\.txt saying GOOD/, 'first call carries the original prompt');
  assert.match(calls[1].prompt, /failed verification/, 'second call is a fix prompt');
  assert.match(calls[1].prompt, /automated check "check" failed/, 'fix prompt names the failed step');
  assert.match(calls[1].prompt, /does not contain GOOD/, 'fix prompt embeds the real error output');
  assert.match(calls[1].prompt, /create app\.txt saying GOOD/, 'fix prompt restates the original task');

  assert.strictEqual(gitLog(c).length, 1, 'only the passing attempt is committed');
});

// ---------------------------------------------------------------- multi-step failures
test('fix prompt aggregates every failed verification step', () => {
  const c = setupCase('multi-step', {
    phases: [{ id: 'p1', prompt: 'write app.txt and app2.txt, both GOOD' }],
    calls: [
      { files: { 'app.txt': 'BAD', 'app2.txt': 'ALSO BAD' } },
      { files: { 'app.txt': 'GOOD', 'app2.txt': 'GOOD too' } },
    ],
    config: {
      verification_steps: [
        { name: 'check', command: `node "${CHECK}"` },
        { name: 'check2', command: `node "${CHECK}" app2.txt` },
      ],
    },
  });
  const res = runRunner(c);
  assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}\n${res.stdout}\n${res.stderr}`);
  const calls = claudeCalls(c);
  assert.strictEqual(calls.length, 2);
  assert.match(calls[1].prompt, /automated check "check" failed/, 'first failing step in fix prompt');
  assert.match(calls[1].prompt, /automated check "check2" failed/, 'second failing step in fix prompt');
  assert.match(calls[1].prompt, /app2\.txt does not contain GOOD/, 'second step error text included');
});

// ---------------------------------------------------------------- stuck
test('exhausted retries mark the phase stuck and halt the whole run', () => {
  const c = setupCase('stuck', {
    phases: [
      { id: 'p1', prompt: 'this will never pass' },
      { id: 'p2', prompt: 'never reached' },
    ],
    calls: [{ files: { 'app.txt': 'BAD forever' } }],
  });
  const res = runRunner(c);
  assert.strictEqual(res.status, 2, `expected exit 2 (stuck), got ${res.status}\n${res.stdout}\n${res.stderr}`);

  const queue = readJson(c.queueFile);
  assert.strictEqual(queue.phases[0].status, 'stuck');
  assert.strictEqual(queue.phases[0].retries, 3, 'initial attempt + 2 retries');
  assert.strictEqual(queue.phases[1].status, 'pending', 'later phase never touched');
  assert.strictEqual(claudeCalls(c).length, 3, 'max_retries bounds Claude calls');
  assert.strictEqual(gitLog(c).length, 0, 'nothing committed');

  const state = readJson(c.stateFile);
  assert.strictEqual(state.status, 'stuck');
  assert.match(state.message, /p1/, 'state names the stuck phase');
});

// ---------------------------------------------------------------- claude call failure
test('a crashing Claude CLI is retried with the same prompt, then stuck', () => {
  const c = setupCase('claude-crash', {
    phases: [{ id: 'p1', prompt: 'the CLI will crash' }],
    calls: [{ crash: true }],
  });
  const res = runRunner(c);
  assert.strictEqual(res.status, 2, `expected exit 2, got ${res.status}\n${res.stdout}\n${res.stderr}`);
  const calls = claudeCalls(c);
  assert.strictEqual(calls.length, 3, 'initial + 2 retries');
  assert.strictEqual(calls[1].prompt, calls[0].prompt, 'no fix prompt without failure evidence');
  assert.strictEqual(readJson(c.queueFile).phases[0].status, 'stuck');
});

// ---------------------------------------------------------------- resume
test('resume: passed phases are skipped, --retry-stuck revives stuck ones', () => {
  const c = setupCase('resume', {
    phases: [
      { id: 'p1', prompt: 'phase one' },
      { id: 'p2', prompt: 'phase two' },
    ],
    calls: [
      { files: { 'app.txt': 'GOOD v1' } },
      { crash: true },
    ],
  });
  const first = runRunner(c);
  assert.strictEqual(first.status, 2, `run 1 should end stuck, got ${first.status}\n${first.stdout}\n${first.stderr}`);
  let queue = readJson(c.queueFile);
  assert.strictEqual(queue.phases[0].status, 'passed');
  assert.strictEqual(queue.phases[1].status, 'stuck');
  const callsAfterFirst = claudeCalls(c).length;
  assert.strictEqual(callsAfterFirst, 4, 'p1 once + p2 three times');

  // Repair the "CLI" and resume.
  fs.writeFileSync(path.join(c.project, 'mock-scenario.json'),
    JSON.stringify({ calls: [{ files: { 'app.txt': 'GOOD v2' } }] }, null, 2));
  const second = runRunner(c, ['--retry-stuck']);
  assert.strictEqual(second.status, 0, `run 2 should pass, got ${second.status}\n${second.stdout}\n${second.stderr}`);

  queue = readJson(c.queueFile);
  assert.strictEqual(queue.phases[0].status, 'passed');
  assert.strictEqual(queue.phases[1].status, 'passed');
  assert.strictEqual(claudeCalls(c).length, callsAfterFirst + 1, 'run 2 called Claude only for p2');
  assert.match(second.stdout + second.stderr, /Skipping p1/, 'p1 explicitly skipped');
});

// ---------------------------------------------------------------- stop flag
test('stop flag halts the run gracefully between steps', () => {
  const c = setupCase('stop-flag', {
    phases: [
      { id: 'p1', prompt: 'phase one' },
      { id: 'p2', prompt: 'phase two' },
    ],
    // The mock drops a stop flag next to state.json while "working" on p1.
    calls: [{ files: { 'app.txt': 'GOOD', '../.stop': 'requested by test' } }],
  });
  const res = runRunner(c);
  assert.strictEqual(res.status, 3, `expected exit 3 (stopped), got ${res.status}\n${res.stdout}\n${res.stderr}`);
  assert.strictEqual(claudeCalls(c).length, 1, 'stopped before any further Claude calls');
  assert.strictEqual(readJson(c.stateFile).status, 'stopped');
  assert.strictEqual(readJson(c.queueFile).phases[1].status, 'pending', 'p2 untouched');
});

// ---------------------------------------------------------------- tester agent
test('tester agent: FAIL verdict routes evidence back to the builder, then PASS commits', () => {
  const c = setupCase('tester-flow', {
    phases: [{ id: 'p1', prompt: 'build the contact form' }],
    calls: [
      // builder attempt 1: work + report
      { files: { 'app.txt': 'GOOD', '.pcr/report.json': JSON.stringify({ summary: 'built the form', files_changed: ['app.txt'], how_to_verify: 'open app.txt' }) } },
      // tester attempt 1: rejects
      { files: { '.pcr/verdict.json': JSON.stringify({ pass: false, summary: 'submit button dead', failures: [{ what: 'submit button', evidence: 'clicking does nothing, console error X', suggested_fix: 'wire the onclick handler' }] }) } },
      // builder attempt 2 (fix)
      { files: { 'app.txt': 'GOOD fixed', '.pcr/report.json': JSON.stringify({ summary: 'wired the handler' }) } },
      // tester attempt 2: approves
      { files: { '.pcr/verdict.json': JSON.stringify({ pass: true, summary: 'form submits fine', failures: [] }) } },
    ],
    config: { tester: { enabled: true } },
  });
  const res = runRunner(c);
  assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}\n${res.stdout}\n${res.stderr}`);

  const calls = claudeCalls(c);
  assert.strictEqual(calls.length, 4, 'builder, tester, builder-fix, tester');
  assert.match(calls[1].prompt, /TESTER \(QA\) agent/, 'second call is the tester');
  assert.match(calls[1].prompt, /built the form/, 'tester sees the builder report');
  assert.match(calls[1].prompt, /build the contact form/, 'tester sees the original task');
  assert.match(calls[1].prompt, /\.pcr\/verdict\.json/, 'tester told where to write the verdict');
  assert.match(calls[2].prompt, /TESTER agent rejected/, 'fix prompt says the tester rejected it');
  assert.match(calls[2].prompt, /submit button/, 'fix prompt carries what failed');
  assert.match(calls[2].prompt, /clicking does nothing/, 'fix prompt carries the evidence');
  assert.match(calls[2].prompt, /wire the onclick handler/, 'fix prompt carries the suggested fix');

  const queue = readJson(c.queueFile);
  assert.strictEqual(queue.phases[0].status, 'passed');
  assert.strictEqual(queue.phases[0].retries, 1);
  assert.strictEqual(gitLog(c).length, 1, 'only the tester-approved attempt is committed');

  const verdicts = runEvents(c).filter((e) => e.type === 'verdict');
  assert.strictEqual(verdicts.length, 2, 'both verdicts logged');
  assert.strictEqual(verdicts[0].pass, false);
  assert.strictEqual(verdicts[1].pass, true);
});

test('a missing verdict file counts as a tester FAIL', () => {
  const c = setupCase('tester-missing-verdict', {
    phases: [{ id: 'p1', prompt: 'do something' }],
    calls: [
      { files: { 'app.txt': 'GOOD' } },  // builder 1 (no report — also tolerated)
      { result: 'looks fine to me' },     // tester 1 writes NO verdict file
      { files: { 'app.txt': 'GOOD 2' } }, // builder 2 (fix)
      { files: { '.pcr/verdict.json': JSON.stringify({ pass: true, summary: 'ok' }) } }, // tester 2
    ],
    config: { tester: { enabled: true } },
  });
  const res = runRunner(c);
  assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}\n${res.stdout}\n${res.stderr}`);
  const calls = claudeCalls(c);
  assert.strictEqual(calls.length, 4);
  assert.match(calls[2].prompt, /no readable verdict/, 'missing verdict is treated as an explicit failure');
  assert.strictEqual(readJson(c.queueFile).phases[0].retries, 1);
});

test('a stale verdict from the previous attempt is never reused', () => {
  const c = setupCase('tester-stale-verdict', {
    phases: [{ id: 'p1', prompt: 'task' }],
    calls: [
      { files: { 'app.txt': 'BAD', '.pcr/verdict.json': JSON.stringify({ pass: true, summary: 'FORGED by builder' }) } },
      // tester 1: writes nothing — the forged verdict must NOT count
      { result: 'hmm' },
      { files: { 'app.txt': 'GOOD' } },
      { files: { '.pcr/verdict.json': JSON.stringify({ pass: true, summary: 'real pass' }) } },
    ],
    config: { tester: { enabled: true }, verification_steps: [] },
  });
  const res = runRunner(c);
  assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}\n${res.stdout}\n${res.stderr}`);
  const queue = readJson(c.queueFile);
  assert.strictEqual(queue.phases[0].retries, 1, 'the forged verdict round still failed');
  const verdicts = runEvents(c).filter((e) => e.type === 'verdict');
  assert.strictEqual(verdicts[0].pass, false, 'builder-planted verdict was cleared before the tester ran');
  assert.match(verdicts[0].summary, /no readable verdict/);
});

// ---------------------------------------------------------------- deploy
test('deploy: deployer report is recorded and the run completes (trust mode)', () => {
  const c = setupCase('deploy-trust', {
    phases: [{ id: 'p1', prompt: 'build it' }],
    calls: [
      { files: { 'app.txt': 'GOOD' } },
      { files: { '.pcr/deploy.json': JSON.stringify({ repo_url: 'https://github.com/x/site', pages_url: 'https://x.github.io/site/', live: true, notes: 'pages via actions' }) } },
    ],
    config: { deploy: { enabled: true, verify_live: false } },
  });
  const res = runRunner(c);
  assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}\n${res.stdout}\n${res.stderr}`);

  const calls = claudeCalls(c);
  assert.strictEqual(calls.length, 2, 'builder + deployer');
  assert.match(calls[1].prompt, /DEPLOYER agent/, 'deployer role preamble');
  assert.match(calls[1].prompt, /GitHub Pages/, 'deployer told to use Pages');
  assert.match(calls[1].prompt, /\.pcr\/deploy\.json/, 'deploy protocol requested');

  const state = readJson(c.stateFile);
  assert.strictEqual(state.status, 'passed_all');
  assert.strictEqual(state.deploy.status, 'live');
  assert.strictEqual(state.deploy.pages_url, 'https://x.github.io/site/');
  assert.strictEqual(state.deploy.repo_url, 'https://github.com/x/site');

  const events = runEvents(c);
  assert.ok(events.some((e) => e.type === 'deploy_done'), 'deploy_done event logged');
  assert.ok(events.some((e) => e.type === 'notification'), 'completion notification logged (channel console in tests)');
});

test('deploy: a report that never turns live gets fix prompts, then the run is stuck', () => {
  const c = setupCase('deploy-not-live', {
    phases: [{ id: 'p1', prompt: 'build it' }],
    calls: [
      { files: { 'app.txt': 'GOOD' } },
      { files: { '.pcr/deploy.json': JSON.stringify({ repo_url: 'https://github.com/x/site', pages_url: 'https://x.github.io/site/', live: false, notes: 'workflow failing' }) } },
    ],
    config: { deploy: { enabled: true, verify_live: false }, max_retries: 1 },
  });
  const res = runRunner(c);
  assert.strictEqual(res.status, 2, `expected exit 2 (stuck), got ${res.status}\n${res.stdout}\n${res.stderr}`);
  const calls = claudeCalls(c);
  assert.strictEqual(calls.length, 3, 'builder + deployer + deployer fix');
  assert.match(calls[2].prompt, /DEPLOYER agent/, 'fix goes back to the deployer');
  assert.match(calls[2].prompt, /"live" is not true/, 'fix prompt states the observed problem');
  const state = readJson(c.stateFile);
  assert.strictEqual(state.status, 'stuck');
  assert.strictEqual(state.deploy.status, 'failed');
});

test('deploy: the orchestrator independently rejects an unreachable pages_url', () => {
  const c = setupCase('deploy-dead-url', {
    phases: [{ id: 'p1', prompt: 'build it' }],
    calls: [
      { files: { 'app.txt': 'GOOD' } },
      // 127.0.0.1:9 (discard) — connection refused, instantly
      { files: { '.pcr/deploy.json': JSON.stringify({ repo_url: 'https://github.com/x/site', pages_url: 'http://127.0.0.1:9/', live: true }) } },
    ],
    config: { deploy: { enabled: true, verify_live: true, live_timeout_ms: 1500 }, max_retries: 0 },
  });
  const res = runRunner(c);
  assert.strictEqual(res.status, 2, `expected exit 2 (stuck), got ${res.status}\n${res.stdout}\n${res.stderr}`);
  const events = runEvents(c);
  const check = events.find((e) => e.type === 'live_check_result');
  assert.ok(check, 'live check ran');
  assert.strictEqual(check.live, false, 'claimed-live URL was rejected by the orchestrator');
  assert.strictEqual(readJson(c.stateFile).deploy.status, 'failed');
});

test('unit: waitUntilLive succeeds against a real local server', async () => {
  const { waitUntilLive } = require('../lib/live-check');
  const server = http.createServer((req, res) => { res.writeHead(200); res.end('hello site'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const r = await waitUntilLive(url, { timeoutMs: 5000, intervalMs: 100 });
    assert.strictEqual(r.live, true, `expected live, got: ${r.evidence}`);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------- review regressions
test('the .pcr mailbox never reaches a commit, even if the builder clobbers .gitignore', () => {
  const c = setupCase('pcr-guard', {
    phases: [{ id: 'p1', prompt: 'scaffold with a generator that overwrites .gitignore' }],
    calls: [{ files: { 'app.txt': 'GOOD', '.gitignore': 'node_modules\n', '.pcr/report.json': '{"summary":"scaffolded"}' } }],
  });
  const res = runRunner(c);
  assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}\n${res.stdout}\n${res.stderr}`);
  const ls = spawnSync('git', ['-C', c.project, 'ls-files'], { encoding: 'utf8' }).stdout || '';
  assert.ok(!/\.pcr\//.test(ls), `agent mailbox leaked into the commit:\n${ls}`);
  assert.match(ls, /app\.txt/, 'real files still committed');
});

test('rerunning a fully deployed queue skips the deploy stage and never re-notifies', () => {
  const c = setupCase('deploy-rerun', {
    phases: [{ id: 'p1', prompt: 'build it' }],
    calls: [
      { files: { 'app.txt': 'GOOD' } },
      { files: { '.pcr/deploy.json': JSON.stringify({ repo_url: 'https://github.com/x/site', pages_url: 'https://x.github.io/site/', live: true }) } },
    ],
    config: { deploy: { enabled: true, verify_live: false } },
  });
  const first = runRunner(c);
  assert.strictEqual(first.status, 0, `run 1: expected exit 0, got ${first.status}\n${first.stdout}\n${first.stderr}`);
  assert.strictEqual(readJson(c.queueFile).deploy_state.status, 'live', 'deploy completion persisted in the queue');

  const second = runRunner(c);
  assert.strictEqual(second.status, 0, `run 2: expected exit 0, got ${second.status}\n${second.stdout}\n${second.stderr}`);
  assert.strictEqual(claudeCalls(c).length, 2, 'rerun made zero new agent calls');
  const state = readJson(c.stateFile);
  assert.strictEqual(state.status, 'passed_all');
  assert.strictEqual(state.deploy.status, 'live');
  assert.strictEqual(state.deploy.pages_url, 'https://x.github.io/site/');
  const events = runEvents(c);
  assert.ok(events.some((e) => e.type === 'deploy_skipped'), 'rerun logs an explicit deploy_skipped');
  assert.strictEqual(events.filter((e) => e.type === 'notification').length, 1, 'the LIVE notification fired exactly once across both runs');
});

test('unit: live-check turns malformed URLs and redirect locations into evidence, never a crash', async () => {
  const { waitUntilLive, getOnce } = require('../lib/live-check');
  const bad = await waitUntilLive('https://user.github.io /repo', { timeoutMs: 300, intervalMs: 50 });
  assert.strictEqual(bad.live, false, 'malformed url is a failed check, not a throw');
  assert.match(bad.evidence, /invalid url/i);

  const server = http.createServer((req, res) => { res.writeHead(302, { Location: 'https://bad host/next' }); res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const g = await getOnce(`http://127.0.0.1:${server.address().port}/`);
    assert.strictEqual(g.ok, false);
    assert.match(g.detail, /redirect/i, `got: ${g.detail}`);
  } finally {
    server.close();
  }
});

test('unit: toast XML escaping strips ANSI and control characters', () => {
  const { xmlEscape } = require('../lib/notify');
  const out = xmlEscape('halt: \x1b[31merror\x1b[0m <build> "x" \x07');
  assert.ok(!out.includes('\x1b'), 'ESC removed');
  assert.ok(!out.includes('\x07'), 'BEL removed');
  assert.ok(!/\[31m/.test(out), 'whole ANSI sequence removed, not just ESC');
  assert.match(out, /&lt;build&gt;/, 'markup still escaped');
});

// ---------------------------------------------------------------- unit: fix prompt
test('fix prompt caps runaway step output and merges tester evidence', () => {
  const { buildFixPrompt } = require('../lib/fix-prompt');
  const huge = 'x'.repeat(100000) + '\nTHE REAL ERROR IS AT THE END';
  const prompt = buildFixPrompt({
    originalPrompt: 'original task',
    autoResults: {
      build: { passed: false, exit_code: 1, output: huge },
      lint: { passed: true, exit_code: 0, output: 'fine' },
    },
    verdict: { pass: false, summary: 'broken UX', failures: [{ what: 'nav', evidence: '404 on click', suggested_fix: 'fix href' }] },
    config: { fix_prompt_output_limit: 2000 },
  });
  assert.ok(prompt.length < 6000, `prompt should be capped, got ${prompt.length} chars`);
  assert.match(prompt, /THE REAL ERROR IS AT THE END/, 'keeps the tail where errors live');
  assert.match(prompt, /truncated/, 'marks the truncation');
  assert.ok(!prompt.includes('"lint"'), 'passing steps stay out of the fix prompt');
  assert.match(prompt, /broken UX/, 'tester summary included');
  assert.match(prompt, /404 on click/, 'tester evidence included');
});

// ---------------------------------------------------------------- unit: queue validation
test('queue validation rejects malformed queues', () => {
  const { loadQueue } = require('../lib/queue');
  const dir = path.join(TMP, 'queue-validation');
  fs.mkdirSync(dir, { recursive: true });
  const write = (data) => {
    const f = path.join(dir, 'q.json');
    fs.writeFileSync(f, JSON.stringify(data));
    return f;
  };
  assert.throws(() => loadQueue(write({ phases: [] })), /project_path/);
  assert.throws(() => loadQueue(write({ project_path: './x', phases: [] })), /non-empty array/);
  assert.throws(() => loadQueue(write({ project_path: './x', phases: [{ id: 'a', prompt: 'p' }, { id: 'a', prompt: 'p' }] })), /Duplicate/);
  assert.throws(() => loadQueue(write({ project_path: './x', phases: [{ id: 'a' }] })), /prompt/);
  assert.throws(() => loadQueue(write({ project_path: './x', phases: [{ id: 'a', prompt: 'p', status: 'weird' }] })), /invalid status/);
  const ok = loadQueue(write({ project_path: './x', phases: [{ id: 'a', prompt: 'p' }] }));
  assert.strictEqual(ok.phases[0].status, 'pending', 'defaults filled in');
  assert.strictEqual(ok.phases[0].retries, 0);
});

// ---------------------------------------------------------------- unit: prompt parser
test('parser: markdown headings split into ordered prompts with a shared preamble', () => {
  const { parsePrompts } = require('../lib/parse-prompts');
  const r = parsePrompts([
    'This site is for a bakery. Keep it warm and simple.',
    '',
    '## Prompt 1 — scaffold',
    'Set up the project.',
    '',
    '## Prompt 2 — landing page',
    'Build the landing page.',
    '### details',
    'hero, menu, footer.',
    '',
    '## Prompt 3 — deploy prep',
    'Add meta tags.',
  ].join('\n'));
  assert.strictEqual(r.strategy, 'headings');
  assert.strictEqual(r.prompts.length, 3, 'splits on ##, not on ###');
  assert.match(r.preamble, /bakery/, 'text before the first heading becomes shared context');
  assert.strictEqual(r.prompts[0].id, 'prompt-1');
  assert.match(r.prompts[0].title, /scaffold/);
  assert.match(r.prompts[1].prompt, /hero, menu, footer/, 'sub-headings stay inside their prompt');
});

test('parser: --- separators and numbered lists both split; sub-lists do not', () => {
  const { parsePrompts } = require('../lib/parse-prompts');

  const sep = parsePrompts('Build the header.\n---\nBuild the footer.');
  assert.strictEqual(sep.strategy, 'separators');
  assert.strictEqual(sep.prompts.length, 2);

  const num = parsePrompts('Prompt 1: set up the repo\ndetails here\nPrompt 2: build the page\nmore details');
  assert.strictEqual(num.strategy, 'numbered');
  assert.strictEqual(num.prompts.length, 2);
  assert.match(num.prompts[0].prompt, /set up the repo/);
  assert.ok(!NUMBER_MARKER_LEFT(num.prompts[1].prompt), 'marker stripped from the body');

  // A non-ascending numbered list is content, not a queue.
  const noise = parsePrompts('Do the thing.\nRequirements:\n2. must be fast\n5. must be pretty');
  assert.strictEqual(noise.strategy, 'single');
  assert.strictEqual(noise.prompts.length, 1);

  function NUMBER_MARKER_LEFT(text) { return /^\s*prompt\s*\d/i.test(text); }
});

test('parser: headings inside code fences are ignored; empty input throws', () => {
  const { parsePrompts } = require('../lib/parse-prompts');
  const r = parsePrompts([
    '# Prompt 1',
    'Add this snippet:',
    '```',
    '# not a heading',
    '## also not a heading',
    '```',
    '# Prompt 2',
    'Second task.',
  ].join('\n'));
  assert.strictEqual(r.prompts.length, 2, 'fenced pseudo-headings did not split');
  assert.match(r.prompts[0].prompt, /also not a heading/, 'fence content kept in the prompt body');
  assert.throws(() => parsePrompts('   \n  \n'), /empty/i);
});

// ---------------------------------------------------------------- unit: autocheck
test('autocheck: derives steps from what the project actually is', () => {
  const { detectChecks } = require('../lib/autocheck');
  const dir = path.join(TMP, 'autocheck');
  rmrf(dir);
  fs.mkdirSync(dir, { recursive: true });

  assert.deepStrictEqual(detectChecks(dir), [], 'empty project: no checks (the tester covers it)');

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    scripts: { build: 'x', test: 'y', lint: 'z' },
    devDependencies: { typescript: '^5' },
  }));
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
  const names = detectChecks(dir).map((s) => s.name);
  assert.deepStrictEqual(names, ['install', 'typecheck', 'lint', 'build', 'test'], `got: ${names}`);

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    scripts: { test: 'echo "Error: no test specified" && exit 1' },
  }));
  const names2 = detectChecks(dir).map((s) => s.name);
  assert.deepStrictEqual(names2, ['install'], 'placeholder npm test script is not a real check');
});

// ---------------------------------------------------------------- dashboard API
test('dashboard API: import/save/queue endpoints and the security guards', async () => {
  const dir = path.join(TMP, 'dashboard');
  rmrf(dir);
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'logs', 'run-1.log'), 'hello log');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ dashboard_port: 0 }));

  const port = 41000 + Math.floor(Math.random() * 2000);
  const child = spawn('node', [path.join(ROOT, 'dashboard.js'), '--port', String(port), '--root', dir], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  const req = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port, path: p, method,
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });

  try {
    // wait for the server
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { up = (await req('GET', '/api/health')).status === 200; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.ok(up, `dashboard never came up on ${port}:\n${out}`);

    // import: parse only, nothing written
    const imp = await req('POST', '/api/prompts/import', { content: '## Prompt 1\nbuild A\n## Prompt 2\nbuild B' });
    assert.strictEqual(imp.status, 200, imp.body);
    const parsed = JSON.parse(imp.body);
    assert.strictEqual(parsed.prompts.length, 2);

    // save: queue lands in the data root, stale state from a previous run is cleared
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ status: 'passed_all', pid: 0, phases: [{ id: 'old' }] }));
    const save = await req('POST', '/api/prompts/save', {
      project_name: 'My Bakery Site',
      context: 'warm colors',
      deploy: { enabled: true, repo_name: '' },
      prompts: parsed.prompts,
    });
    assert.strictEqual(save.status, 200, save.body);
    const queue = readJson(path.join(dir, 'prompts', 'queue.json'));
    assert.strictEqual(queue.project_name, 'My Bakery Site');
    assert.strictEqual(queue.project_path, './projects/my-bakery-site');
    assert.strictEqual(queue.deploy.repo_name, 'my-bakery-site');
    assert.strictEqual(queue.phases.length, 2);
    assert.strictEqual(queue.phases[0].id, 'prompt-1');
    assert.strictEqual(queue.context, 'warm colors');
    assert.ok(!fs.existsSync(path.join(dir, 'state.json')), 'stale previous-run state cleared on save');

    const q = await req('GET', '/api/queue');
    assert.strictEqual(JSON.parse(q.body).queue.project_name, 'My Bakery Site');

    // raw log serving + traversal guard
    const raw = await req('GET', '/api/raw?file=run-1.log');
    assert.strictEqual(raw.status, 200);
    assert.strictEqual(raw.body, 'hello log');
    for (const evil of ['..%2Fconfig.json', '..\\config.json', 'x/../../config.json', 'state.json']) {
      const blocked = await req('GET', `/api/raw?file=${evil}`);
      assert.strictEqual(blocked.status, 400, `traversal not blocked for ${evil}: ${blocked.status}`);
    }

    // DNS-rebinding guard: foreign Host rejected, foreign Origin rejected on POST
    const badHost = await req('GET', '/api/overview', undefined, { Host: 'evil.example' });
    assert.strictEqual(badHost.status, 403, 'foreign Host must be rejected');
    const badOrigin = await req('POST', '/api/run/stop', {}, { Origin: 'https://evil.example' });
    assert.strictEqual(badOrigin.status, 403, 'foreign Origin must be rejected on POST');
  } finally {
    child.kill('SIGKILL');
  }
});

// ---------------------------------------------------------------- summary
console.log('prompt-chain-runner test suite\n');
rmrf(TMP);
(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  PASS ${t.name}`);
    } catch (err) {
      failures.push({ name: t.name, err });
      console.error(`  FAIL ${t.name}\n     ${String(err.stack || err.message || err).split('\n').join('\n     ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
})();
