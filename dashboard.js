#!/usr/bin/env node
'use strict';
// Live dashboard for the Prompt Chain Runner. Zero dependencies — plain Node
// http. Serves the UI, exposes run state / queue / logs as JSON, and can
// start/stop/kill the runner process.
//
// Usage: node dashboard.js [--port 4747] [--open]
// Binds to 127.0.0.1 only, and additionally rejects requests whose Host or
// Origin is not local (DNS-rebinding / cross-site request protection) — this
// is a local control panel, never expose it.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readJson, atomicWriteJson, slugify, pidAlive, pidLooksLikeNode } = require('./lib/util');
const { readState, writeState } = require('./lib/state');
const { killTree } = require('./lib/claude');
const { parsePrompts } = require('./lib/parse-prompts');

function parseArgs(argv) {
  const opts = { port: null, open: false, root: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') opts.port = parseInt(argv[++i], 10);
    else if (argv[i] === '--open') opts.open = true;
    else if (argv[i] === '--root') opts.root = path.resolve(argv[++i]); // data root override (tests)
  }
  return opts;
}

const ROOT = __dirname;
const DATA_ROOT = parseArgs(process.argv.slice(2)).root || ROOT;
const LOGS_DIR = path.join(DATA_ROOT, 'logs');
const STATE_FILE = path.join(DATA_ROOT, 'state.json');
const QUEUE_FILE = path.join(DATA_ROOT, 'prompts', 'queue.json');
const CONFIG_FILE = path.join(DATA_ROOT, 'config.json');
const STOP_FILE = path.join(DATA_ROOT, '.stop');
const INDEX_FILE = path.join(ROOT, 'public', 'index.html');
const MAX_TAIL_CHUNK = 512 * 1024;

function safeReadJson(file) {
  try { return readJson(file); } catch { return null; }
}

const opts = parseArgs(process.argv.slice(2));
const config = safeReadJson(CONFIG_FILE) || {};
const port = opts.port || config.dashboard_port || 4747;

function listRuns() {
  let entries = [];
  try { entries = fs.readdirSync(LOGS_DIR); } catch { return []; }
  const runs = new Map();
  for (const name of entries) {
    const m = name.match(/^(run-[\dT-]+)\.(log|events\.jsonl)$/);
    if (!m) continue;
    const [, runId, kind] = m;
    if (!runs.has(runId)) runs.set(runId, { run_id: runId, log: null, events: null, mtime: 0 });
    const info = runs.get(runId);
    try {
      const stat = fs.statSync(path.join(LOGS_DIR, name));
      info.mtime = Math.max(info.mtime, stat.mtimeMs);
      if (kind === 'log') info.log = name;
      else info.events = name;
    } catch { /* file vanished */ }
  }
  return [...runs.values()].sort((a, b) => b.mtime - a.mtime);
}

// Only files that live directly in logs/ with expected extensions are servable.
function resolveLogFile(name) {
  if (typeof name !== 'string' || !name) return null;
  if (name !== path.basename(name)) return null; // no separators / traversal
  if (!/^[\w.-]+\.(log|jsonl)$/.test(name)) return null;
  const abs = path.join(LOGS_DIR, name);
  if (!abs.startsWith(LOGS_DIR + path.sep)) return null;
  return abs;
}

// A UTF-8 continuation byte is 10xxxxxx. If the chunk ends mid-character,
// hold those bytes back and let the next poll deliver the whole character —
// otherwise the client renders U+FFFD and the byte offset drifts.
function trimIncompleteUtf8(buf, length) {
  if (length === 0) return 0;
  let back = 0;
  while (back < 3 && length - 1 - back >= 0 && (buf[length - 1 - back] & 0xc0) === 0x80) back++;
  const leadIndex = length - 1 - back;
  if (leadIndex < 0) return length; // degenerate: all continuation bytes, emit as-is
  const lead = buf[leadIndex];
  let expected = 1;
  if ((lead & 0xf8) === 0xf0) expected = 4;
  else if ((lead & 0xf0) === 0xe0) expected = 3;
  else if ((lead & 0xe0) === 0xc0) expected = 2;
  const have = back + 1;
  if (expected > have && leadIndex > 0) return leadIndex;
  return length;
}

function json(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      // Prompt files can be large; 4 MB is far beyond any sane import.
      if (data.length > 4 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// The last runner this dashboard spawned. state.json only reports a run once
// the runner has booted far enough to write it, so this in-memory pid closes
// the double-start window in between. It is cleared by the child's own exit
// event; the pidLooksLikeNode check is the backstop against OS pid reuse.
let spawnedRunnerPid = null;

function runnerIsActive() {
  if (spawnedRunnerPid) {
    if (pidAlive(spawnedRunnerPid) && pidLooksLikeNode(spawnedRunnerPid)) return true;
    spawnedRunnerPid = null; // dead or recycled — self-heal
  }
  // A runner started outside the dashboard holds .runner.lock from before its
  // first state.json write — honor it for its whole lifetime.
  try {
    const lockPid = parseInt(fs.readFileSync(path.join(DATA_ROOT, '.runner.lock'), 'utf8'), 10);
    if (lockPid && pidAlive(lockPid) && pidLooksLikeNode(lockPid)) return true;
  } catch { /* no lock */ }
  const state = readState(STATE_FILE);
  return Boolean(state && state.status === 'running' && pidAlive(state.pid) && pidLooksLikeNode(state.pid));
}

function startRunner({ retryStuck = false } = {}) {
  if (runnerIsActive()) return { ok: false, error: 'A run is already in progress.' };
  try { fs.rmSync(STOP_FILE, { force: true }); } catch { /* ignore */ }
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const args = [
    path.join(ROOT, 'runner.js'),
    '--queue', QUEUE_FILE,
    '--config', CONFIG_FILE,
    '--logs', LOGS_DIR,
    '--state', STATE_FILE,
  ];
  if (retryStuck) args.push('--retry-stuck');
  // Early crashes (bad config/queue) happen before the runner opens its own
  // log file — capture the console in a spawn log so nothing is ever silent.
  const out = fs.openSync(path.join(LOGS_DIR, 'runner-console.log'), 'a');
  try {
    fs.writeSync(out, `\n===== dashboard started runner at ${new Date().toISOString()} =====\n`);
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
    child.unref();
    spawnedRunnerPid = child.pid;
    // unref() detaches the event loop, not the 'exit' event — release the
    // in-memory latch the moment the runner actually ends, so a reused OS pid
    // can never wedge the dashboard in "running".
    child.on('exit', () => { if (spawnedRunnerPid === child.pid) spawnedRunnerPid = null; });
    return { ok: true, pid: child.pid };
  } finally {
    fs.closeSync(out);
  }
}

const routes = {
  'GET /api/overview': (req, res) => {
    const state = readState(STATE_FILE);
    json(res, 200, {
      now: new Date().toISOString(),
      state,
      runner_active: runnerIsActive(),
      stop_flag: fs.existsSync(STOP_FILE),
      queue: safeReadJson(QUEUE_FILE),
      config: safeReadJson(CONFIG_FILE),
      runs: listRuns(),
      root: ROOT,
    });
  },

  'GET /api/tail': (req, res, url) => {
    const abs = resolveLogFile(url.searchParams.get('file'));
    if (!abs) return json(res, 400, { error: 'invalid file' });
    let stat;
    try { stat = fs.statSync(abs); } catch { return json(res, 404, { error: 'not found' }); }
    let offset = parseInt(url.searchParams.get('offset') || '0', 10);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;
    if (offset > stat.size) offset = 0; // file was rotated/truncated — restart
    const length = Math.min(stat.size - offset, MAX_TAIL_CHUNK);
    let data = '';
    let consumed = 0;
    if (length > 0) {
      const fd = fs.openSync(abs, 'r');
      try {
        const buf = Buffer.alloc(length);
        const read = fs.readSync(fd, buf, 0, length, offset);
        consumed = trimIncompleteUtf8(buf, read);
        data = buf.toString('utf8', 0, consumed);
      } finally {
        fs.closeSync(fd);
      }
    }
    json(res, 200, { size: stat.size, offset: offset + consumed, data });
  },

  // Parse a markdown/txt prompt file into an ordered prompt list — preview
  // only, nothing is saved until /api/prompts/save.
  'POST /api/prompts/import': async (req, res) => {
    const body = await readBody(req);
    try {
      const parsed = parsePrompts(String(body.content ?? ''));
      json(res, 200, { ok: true, ...parsed });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err.message || err) });
    }
  },

  // Persist the reviewed prompt list as the active queue.
  'POST /api/prompts/save': async (req, res) => {
    const body = await readBody(req);
    if (runnerIsActive()) {
      return json(res, 409, { ok: false, error: 'A run is in progress — stop it before replacing the queue.' });
    }
    const prompts = Array.isArray(body.prompts) ? body.prompts : [];
    const cleaned = prompts
      .map((p) => ({ title: String(p?.title ?? '').trim(), prompt: String(p?.prompt ?? '').trim() }))
      .filter((p) => p.prompt);
    if (!cleaned.length) return json(res, 400, { ok: false, error: 'No prompts to save.' });

    const projectName = String(body.project_name ?? '').trim() || 'my-site';
    const slug = slugify(projectName, 'my-site');
    const queue = {
      project_name: projectName,
      project_path: `./projects/${slug}`,
      context: String(body.context ?? '').trim(),
      deploy: {
        enabled: body.deploy?.enabled !== false,
        repo_name: String(body.deploy?.repo_name ?? '').trim() || slug,
      },
      phases: cleaned.map((p, i) => ({
        id: `prompt-${i + 1}`,
        title: p.title || `Prompt ${i + 1}`,
        prompt: p.prompt,
        status: 'pending',
        retries: 0,
        commit_hash: null,
      })),
    };
    fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
    atomicWriteJson(QUEUE_FILE, queue);
    // The previous run's state.json would otherwise keep painting the Live tab
    // with the OLD run's phases. No run is active (guarded above) — clear it;
    // run history stays available through the logs.
    try { fs.rmSync(STATE_FILE, { force: true }); } catch { /* OneDrive lock — ignore */ }
    json(res, 200, { ok: true, queue });
  },

  'GET /api/queue': (req, res) => {
    json(res, 200, { queue: safeReadJson(QUEUE_FILE) });
  },

  // Whole log file as plain text (for "open raw log" in the Logs tab).
  'GET /api/raw': (req, res, url) => {
    const abs = resolveLogFile(url.searchParams.get('file'));
    if (!abs) return json(res, 400, { error: 'invalid file' });
    let data;
    try { data = fs.readFileSync(abs); } catch { return json(res, 404, { error: 'not found' }); }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(data);
  },

  'POST /api/run/start': async (req, res) => {
    const body = await readBody(req);
    const result = startRunner({ retryStuck: Boolean(body.retryStuck) });
    json(res, result.ok ? 200 : 409, result);
  },

  'POST /api/run/stop': (req, res) => {
    // Graceful: the runner checks this flag between steps and halts cleanly.
    fs.writeFileSync(STOP_FILE, new Date().toISOString());
    json(res, 200, { ok: true, note: 'Stop flag set. The runner halts after the current Claude call or verification step finishes.' });
  },

  'POST /api/run/kill': (req, res) => {
    const state = readState(STATE_FILE);
    fs.writeFileSync(STOP_FILE, new Date().toISOString());
    const killed = [];
    if (state && state.status === 'running' && pidAlive(state.pid)) {
      if (!pidLooksLikeNode(state.pid)) {
        return json(res, 409, { ok: false, error: `pid ${state.pid} no longer looks like the runner (pid reuse?) — not killing it. The stop flag is set.` });
      }
      // On Windows the agent session is a non-detached child of the runner, so
      // taskkill /T on the runner takes the whole tree down — no need to touch
      // claude_pid, which could have been recycled by an unrelated process.
      // On POSIX the agent runs detached in its own process group and must be
      // killed separately (killTree uses the group kill there).
      if (process.platform !== 'win32' && state.claude_pid && pidAlive(state.claude_pid)) {
        killTree(state.claude_pid);
        killed.push(state.claude_pid);
      }
      killTree(state.pid);
      killed.push(state.pid);
      writeState(STATE_FILE, { ...state, status: 'stopped', message: 'Killed from the dashboard.', claude_pid: null });
    }
    // A force-killed runner never runs its exit handler — release its lock on
    // its behalf so the next Start doesn't have to steal it.
    try { fs.rmSync(path.join(DATA_ROOT, '.runner.lock'), { force: true }); } catch { /* ignore */ }
    spawnedRunnerPid = null;
    json(res, 200, killed.length
      ? { ok: true, killed }
      : { ok: true, killed: null, note: 'No live runner process found.' });
  },

  'GET /api/health': (req, res) => json(res, 200, { ok: true }),
};

// Everything meaningful lives on loopback names only. A malicious web page
// can make a browser send requests to 127.0.0.1 (DNS rebinding gets past the
// bind address), so validate what the browser reports.
function isLocalHost(value) {
  if (!value) return false;
  const host = String(value).toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`
    || host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

function isLocalOrigin(origin) {
  if (!origin) return true; // same-origin fetches and curl send no Origin
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(origin));
}

const server = http.createServer(async (req, res) => {
  try {
    if (!isLocalHost(req.headers.host)) return json(res, 403, { error: 'forbidden host' });
    if (req.method !== 'GET' && !isLocalOrigin(req.headers.origin)) {
      return json(res, 403, { error: 'forbidden origin' });
    }

    const url = new URL(req.url, 'http://127.0.0.1');
    const key = `${req.method} ${url.pathname}`;
    if (routes[key]) {
      await routes[key](req, res, url);
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(INDEX_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    try { json(res, 500, { error: String(err.message || err) }); } catch { /* socket gone */ }
  }
});

server.listen(port, '127.0.0.1', () => {
  const addr = `http://127.0.0.1:${port}`;
  console.log(`Prompt Chain Runner dashboard: ${addr}`);
  if (opts.open) {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', addr]]
      : process.platform === 'darwin' ? ['open', [addr]]
      : ['xdg-open', [addr]];
    try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
  }
});
server.on('error', (err) => {
  console.error(`Dashboard failed to start on port ${port}: ${err.message}`);
  process.exit(1);
});
