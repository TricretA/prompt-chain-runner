#!/usr/bin/env node
'use strict';
// Live dashboard for the Prompt Chain Runner. Zero dependencies — plain Node
// http. Serves the UI, exposes run state / queue / logs as JSON, and can
// start/stop/kill the runner process.
//
// Usage: node dashboard.js [--port 4747] [--open]
// Binds to 127.0.0.1 only — this is a local control panel, never expose it.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readJson } = require('./lib/util');
const { readState, writeState } = require('./lib/state');
const { killTree } = require('./lib/claude');

const ROOT = __dirname;
const LOGS_DIR = path.join(ROOT, 'logs');
const STATE_FILE = path.join(ROOT, 'state.json');
const QUEUE_FILE = path.join(ROOT, 'prompts', 'queue.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const STOP_FILE = path.join(ROOT, '.stop');
const INDEX_FILE = path.join(ROOT, 'public', 'index.html');
const MAX_TAIL_CHUNK = 512 * 1024;

function parseArgs(argv) {
  const opts = { port: null, open: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') opts.port = parseInt(argv[++i], 10);
    else if (argv[i] === '--open') opts.open = true;
  }
  return opts;
}

function safeReadJson(file) {
  try { return readJson(file); } catch { return null; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

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

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function runnerIsActive() {
  const state = readState(STATE_FILE);
  return Boolean(state && state.status === 'running' && pidAlive(state.pid));
}

function startRunner({ retryStuck = false } = {}) {
  if (runnerIsActive()) return { ok: false, error: 'A run is already in progress.' };
  try { fs.rmSync(STOP_FILE, { force: true }); } catch { /* ignore */ }
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const args = [path.join(ROOT, 'runner.js')];
  if (retryStuck) args.push('--retry-stuck');
  // Early crashes (bad config/queue) happen before the runner opens its own
  // log file — capture the console in a spawn log so nothing is ever silent.
  const out = fs.openSync(path.join(LOGS_DIR, 'runner-console.log'), 'a');
  fs.writeSync(out, `\n===== dashboard started runner at ${new Date().toISOString()} =====\n`);
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(out);
  return { ok: true, pid: child.pid };
}

const routes = {
  'GET /api/overview': (req, res) => {
    const state = readState(STATE_FILE);
    json(res, 200, {
      now: new Date().toISOString(),
      state,
      runner_active: Boolean(state && state.status === 'running' && pidAlive(state.pid)),
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
    if (length > 0) {
      const fd = fs.openSync(abs, 'r');
      try {
        const buf = Buffer.alloc(length);
        const read = fs.readSync(fd, buf, 0, length, offset);
        data = buf.toString('utf8', 0, read);
      } finally {
        fs.closeSync(fd);
      }
    }
    json(res, 200, { size: stat.size, offset: offset + Buffer.byteLength(data), data });
  },

  'POST /api/run/start': async (req, res) => {
    const body = await readBody(req);
    const result = startRunner({ retryStuck: Boolean(body.retryStuck) });
    json(res, result.ok ? 200 : 409, result);
  },

  'POST /api/run/stop': (req, res) => {
    // Graceful: the runner checks this flag between steps and halts cleanly.
    fs.writeFileSync(STOP_FILE, new Date().toISOString());
    json(res, 200, { ok: true, note: 'Stop flag set. The runner halts after the current Claude call / verify step finishes.' });
  },

  'POST /api/run/kill': (req, res) => {
    const state = readState(STATE_FILE);
    fs.writeFileSync(STOP_FILE, new Date().toISOString());
    if (state && pidAlive(state.pid)) {
      killTree(state.pid);
      if (state.status === 'running') {
        writeState(STATE_FILE, { ...state, status: 'stopped', message: 'Killed from the dashboard.' });
      }
      return json(res, 200, { ok: true, killed: state.pid });
    }
    json(res, 200, { ok: true, killed: null, note: 'No live runner process found.' });
  },

  'GET /api/health': (req, res) => json(res, 200, { ok: true }),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const key = `${req.method} ${url.pathname}`;

  try {
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
    json(res, 500, { error: String(err.message || err) });
  }
});

const opts = parseArgs(process.argv.slice(2));
const config = safeReadJson(CONFIG_FILE) || {};
const port = opts.port || config.dashboard_port || 4747;

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
