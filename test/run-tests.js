#!/usr/bin/env node
'use strict';
// End-to-end tests for the runner. The real Claude Code CLI is replaced by
// test/mock-claude.js, but everything else is real: real child processes,
// real shell verification commands, real git commits, real queue/state files.
//
// Run: node test/run-tests.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(__dirname, '.tmp');
const MOCK = path.join(__dirname, 'mock-claude.js');
const CHECK = path.join(__dirname, 'check.js');

let passed = 0;
const failures = [];

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

function setupCase(name, { phases, calls, config = {} }) {
  const dir = path.join(TMP, name);
  rmrf(dir);
  const project = path.join(dir, 'target');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'mock-scenario.json'), JSON.stringify({ calls }, null, 2));

  const queueFile = path.join(dir, 'queue.json');
  fs.writeFileSync(queueFile, JSON.stringify({ project_path: project, phases }, null, 2));

  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    claude_command: ['node', MOCK],
    claude_timeout_ms: 30000,
    max_retries: 2,
    verify_timeout_ms: 30000,
    verification_steps: [{ name: 'check', command: `node "${CHECK}"` }],
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

function gitLog(c) {
  const res = spawnSync('git', ['-C', c.project, 'log', '--pretty=%H %s'], { encoding: 'utf8' });
  return (res.stdout || '').trim().split('\n').filter(Boolean);
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.error(`  FAIL ${name}\n     ${String(err.message || err).split('\n').join('\n     ')}`);
  }
}

console.log('prompt-chain-runner test suite\n');
rmrf(TMP);

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
      { id: 'p1', prompt: 'create app.txt saying GOOD' },
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

  assert.strictEqual(claudeCalls(c).length, 2, 'one Claude call per phase');

  const state = readJson(c.stateFile);
  assert.strictEqual(state.status, 'passed_all');
  assert.strictEqual(state.totals.claude_calls, 2);
  assert.ok(state.totals.cost_usd > 0, 'cost accumulated');
  assert.ok(!fs.existsSync(path.join(c.dir, '.runner.lock')), 'lock released after the run');
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
  // Hold the lock with this test process's own (definitely alive) pid.
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
  assert.strictEqual(calls[0].prompt, 'create app.txt saying GOOD', 'first call gets the original prompt');
  assert.match(calls[1].prompt, /failed verification/, 'second call is a fix prompt');
  assert.match(calls[1].prompt, /--- check failed/, 'fix prompt names the failed step');
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
  assert.match(calls[1].prompt, /--- check failed/, 'first failing step in fix prompt');
  assert.match(calls[1].prompt, /--- check2 failed/, 'second failing step in fix prompt');
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
  assert.strictEqual(calls[1].prompt, calls[0].prompt, 'no fix prompt without verification output');
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

// ---------------------------------------------------------------- unit: fix prompt truncation
test('fix prompt caps runaway step output', () => {
  const { buildFixPrompt } = require('../lib/fix-prompt');
  const huge = 'x'.repeat(100000) + '\nTHE REAL ERROR IS AT THE END';
  const prompt = buildFixPrompt('original task', {
    build: { passed: false, exit_code: 1, output: huge },
    lint: { passed: true, exit_code: 0, output: 'fine' },
  }, { fix_prompt_output_limit: 2000 });
  assert.ok(prompt.length < 4000, `prompt should be capped, got ${prompt.length} chars`);
  assert.match(prompt, /THE REAL ERROR IS AT THE END/, 'keeps the tail where errors live');
  assert.match(prompt, /truncated/, 'marks the truncation');
  assert.ok(!prompt.includes('--- lint'), 'passing steps stay out of the fix prompt');
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

// ---------------------------------------------------------------- summary
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
