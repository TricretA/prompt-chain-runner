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
const { loadBacklog, addProject, markStatus, summarize } = require('./lib/backlog');
const { detectCapabilities, describeCapabilities } = require('./lib/capabilities');
const { channelsConfigured } = require('./lib/remote-notify');

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
const BACKLOG_FILE = path.join(DATA_ROOT, 'prompts', 'backlog.json');
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

function lockPid() {
  try {
    const pid = parseInt(fs.readFileSync(path.join(DATA_ROOT, '.runner.lock'), 'utf8'), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

// Returns WHICH pid is the live runner, not merely that one exists — the
// watchdog has to know whether the process it can see is the same one
// state.json is describing before it declares that run wedged.
function activeRunnerPid() {
  if (spawnedRunnerPid) {
    if (pidAlive(spawnedRunnerPid) && pidLooksLikeNode(spawnedRunnerPid)) return spawnedRunnerPid;
    spawnedRunnerPid = null; // dead or recycled — self-heal
  }
  // A runner started outside the dashboard holds .runner.lock from before its
  // first state.json write — honor it for its whole lifetime.
  const held = lockPid();
  if (held && pidAlive(held) && pidLooksLikeNode(held)) return held;
  const state = readState(STATE_FILE);
  if (state && state.status === 'running' && pidAlive(state.pid) && pidLooksLikeNode(state.pid)) return state.pid;
  return null;
}

function runnerIsActive() {
  return Boolean(activeRunnerPid());
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
    '--backlog', BACKLOG_FILE,
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

// Probing every CLI takes the better part of a minute, so it never happens in
// a request path: the answer is computed once off the hot path at boot (and
// refreshed hourly) and served from this variable meanwhile.
let capabilitiesText = '';
const CAP_CACHE = path.join(DATA_ROOT, '.capabilities.json');

// Serve whatever is already on disk (even if stale) without probing anything.
function readCapabilitiesCache() {
  try {
    capabilitiesText = describeCapabilities(JSON.parse(fs.readFileSync(CAP_CACHE, 'utf8'))) || capabilitiesText;
  } catch { /* nothing cached yet */ }
}

// The probes are ~10 blocking spawnSync calls. Running them here would freeze
// the HTTP server AND the watchdog for the better part of a minute, so the
// refresh happens in a throwaway child process and we just re-read its cache.
function refreshCapabilities() {
  const cfg = safeReadJson(CONFIG_FILE) || {};
  if (cfg.capabilities?.override) {
    try { capabilitiesText = describeCapabilities(detectCapabilities({ override: cfg.capabilities.override })); } catch { /* ignore */ }
    return;
  }
  readCapabilitiesCache();
  try {
    const child = spawn(process.execPath, [
      '-e',
      `require(${JSON.stringify(path.join(ROOT, 'lib', 'capabilities.js'))})` +
      `.detectCapabilities({ refresh: true, cacheFile: ${JSON.stringify(CAP_CACHE)} })`,
    ], { cwd: ROOT, windowsHide: true, stdio: 'ignore', detached: false });
    child.on('exit', readCapabilitiesCache);
    child.on('error', () => { /* the dashboard works fine without this label */ });
  } catch { /* ignore */ }
}

// --- Watchdog --------------------------------------------------------------
// An unattended run must survive its own accidents: a runner killed by a
// reboot, an OOM, or an agent session wedged forever. The dashboard is the
// only always-on process, so it does the supervising. Restarts are capped so
// a genuinely broken queue can't become an infinite respawn loop.
const watchdogReport = { restarts: 0, last_restart: null, last_reason: null, disabled: false, disabled_until: null };
const RESTART_WINDOW_MS = 60 * 60 * 1000;
const MAX_RESTARTS_PER_WINDOW = 4;
let restartTimes = [];

function watchdogTick() {
  const cfg = safeReadJson(CONFIG_FILE) || {};
  if (cfg.watchdog?.enabled === false) return;
  // Giving up is time-bounded, not permanent: a genuinely broken queue stops
  // the respawn loop for an hour, it does not disable supervision for the life
  // of the dashboard.
  if (watchdogReport.disabled_until) {
    if (Date.now() < watchdogReport.disabled_until) return;
    watchdogReport.disabled_until = null;
    watchdogReport.disabled = false;
    restartTimes = [];
  }
  // An explicit human stop outranks auto-resume, always.
  if (fs.existsSync(STOP_FILE)) {
    watchdogReport.last_reason = 'stop flag present — watchdog standing down';
    return;
  }

  const state = readState(STATE_FILE);
  if (!state || state.status !== 'running') return; // nothing claims to be running

  const live = activeRunnerPid();
  if (live) {
    // Only judge staleness for the process state.json is actually describing.
    // A brand-new runner that has not written state yet must never be blamed
    // for the previous run's stale heartbeat — restarting on that would kill
    // its lock and leave two runners in the same tree.
    if (live !== state.pid) return;

    // A heartbeat only advances when the runner calls syncState(), and nothing
    // does that while an agent session is in flight. So the window must exceed
    // the longest agent timeout, or every long builder call looks like a hang.
    const maxAgentMs = Math.max(
      cfg.claude_timeout_ms || 3600000,
      cfg.planner_timeout_ms || 0, cfg.tester_timeout_ms || 0,
      cfg.debugger_timeout_ms || 0, cfg.design_timeout_ms || 0,
      cfg.security_timeout_ms || 0, cfg.verify_timeout_ms || 0,
    );
    const staleMs = Math.max(cfg.watchdog?.heartbeat_stale_ms ?? 45 * 60 * 1000, maxAgentMs + 10 * 60 * 1000);
    const beat = Date.parse(state.heartbeat || state.updated_at || 0);
    if (!Number.isFinite(beat) || Date.now() - beat < staleMs) return;
    restart(`no heartbeat for ${Math.round((Date.now() - beat) / 60000)} min — the run looks wedged`, state);
    return;
  }
  restart('the runner process is gone but the run was never finished (crash or reboot)', state);
}

function restart(reason, state) {
  restartTimes = restartTimes.filter((t) => Date.now() - t < RESTART_WINDOW_MS);
  if (restartTimes.length >= MAX_RESTARTS_PER_WINDOW) {
    watchdogReport.disabled = true;
    watchdogReport.disabled_until = Date.now() + RESTART_WINDOW_MS;
    watchdogReport.last_reason = `paused for an hour: ${MAX_RESTARTS_PER_WINDOW} restarts in an hour (${reason})`;
    console.error(`[watchdog] ${watchdogReport.last_reason}`);
    return;
  }
  console.error(`[watchdog] restarting the runner: ${reason}`);

  // A wedged runner still holds its pid, its Claude child, and the lock. Take
  // all three down before starting a replacement, or the new one refuses.
  if (state && pidAlive(state.pid) && pidLooksLikeNode(state.pid)) killTree(state.pid);
  if (process.platform !== 'win32' && state?.claude_pid && pidAlive(state.claude_pid)) killTree(state.claude_pid);
  try { fs.rmSync(path.join(DATA_ROOT, '.runner.lock'), { force: true }); } catch { /* ignore */ }
  spawnedRunnerPid = null;
  if (state) {
    writeState(STATE_FILE, { ...state, status: 'stopped', message: `watchdog: ${reason}`, claude_pid: null });
  }

  // Resume: passed phases are skipped, and stuck/degraded ones get one more
  // chance — the whole point is finishing without a human.
  const started = startRunner({ retryStuck: true });
  restartTimes.push(Date.now());
  watchdogReport.restarts += 1;
  watchdogReport.last_restart = new Date().toISOString();
  watchdogReport.last_reason = started.ok ? reason : `${reason} (restart failed: ${started.error})`;
}

const routes = {
  'GET /api/overview': (req, res) => {
    const state = readState(STATE_FILE);
    const cfg = safeReadJson(CONFIG_FILE) || {};
    const backlog = loadBacklog(BACKLOG_FILE);
    json(res, 200, {
      now: new Date().toISOString(),
      state,
      runner_active: runnerIsActive(),
      stop_flag: fs.existsSync(STOP_FILE),
      queue: safeReadJson(QUEUE_FILE),
      config: cfg,
      backlog,
      backlog_summary: summarize(backlog),
      capabilities: capabilitiesText,
      notify_channels: channelsConfigured(cfg.notify || {}),
      watchdog: watchdogReport,
      runs: listRuns(),
      root: ROOT,
    });
  },

  // One line in, whole project out: the queue is written with only a brief and
  // the Planner agent expands it into the prompt chain at run time.
  'POST /api/plan': async (req, res) => {
    const body = await readBody(req);
    if (runnerIsActive()) {
      return json(res, 409, { ok: false, error: 'A run is in progress — stop it or add this to the backlog instead.' });
    }
    const brief = String(body.brief ?? '').trim();
    const projectName = String(body.project_name ?? '').trim() || slugify(brief.slice(0, 40), 'my-project');
    if (!brief) return json(res, 400, { ok: false, error: 'Describe the project in one line first.' });
    const slug = slugify(projectName, 'my-project');
    const queue = {
      project_name: projectName,
      project_path: `./projects/${slug}`,
      context: '',
      brief,
      deploy: {
        enabled: body.deploy?.enabled !== false,
        target: String(body.deploy?.target ?? 'auto'),
        repo_name: String(body.deploy?.repo_name ?? '').trim() || slug,
      },
      phases: [],
    };
    fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
    atomicWriteJson(QUEUE_FILE, queue);
    try { fs.rmSync(STATE_FILE, { force: true }); } catch { /* ignore */ }
    const started = body.start === false ? { ok: true } : startRunner({});
    json(res, started.ok ? 200 : 409, { ok: started.ok, queue, error: started.error });
  },

  'GET /api/backlog': (req, res) => {
    const items = loadBacklog(BACKLOG_FILE);
    json(res, 200, { items, summary: summarize(items) });
  },

  // Queue up another project to build after the current one, unattended.
  'POST /api/backlog': async (req, res) => {
    const body = await readBody(req);
    try {
      const item = addProject(BACKLOG_FILE, {
        project_name: String(body.project_name ?? '').trim(),
        brief: body.brief ? String(body.brief).trim() : null,
        prompts: Array.isArray(body.prompts) && body.prompts.length
          ? body.prompts.map((p) => ({ title: String(p?.title ?? '').trim(), prompt: String(p?.prompt ?? '').trim() })).filter((p) => p.prompt)
          : null,
        context: String(body.context ?? '').trim(),
        deploy: {
          enabled: body.deploy?.enabled !== false,
          target: String(body.deploy?.target ?? 'auto'),
          repo_name: String(body.deploy?.repo_name ?? '').trim() || slugify(String(body.project_name ?? ''), 'project'),
        },
      });
      json(res, 200, { ok: true, item });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err.message || err) });
    }
  },

  'POST /api/backlog/remove': async (req, res) => {
    const body = await readBody(req);
    const ok = markStatus(BACKLOG_FILE, String(body.id ?? ''), 'done', { result: { message: 'removed from the backlog by hand' } });
    json(res, ok ? 200 : 404, { ok });
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
    // its behalf. But only if the lock isn't held by a DIFFERENT, live runner:
    // state.json can be stale while a fresh runner is still booting, and
    // deleting its lock would destroy the single-instance guard.
    const held = lockPid();
    if (!held || killed.includes(held) || !pidAlive(held) || !pidLooksLikeNode(held)) {
      try { fs.rmSync(path.join(DATA_ROOT, '.runner.lock'), { force: true }); } catch { /* ignore */ }
      spawnedRunnerPid = null;
    }
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
  // First tick shortly after boot so a run orphaned by a reboot resumes on its
  // own; the interval covers hangs during a long unattended night.
  setTimeout(() => { try { watchdogTick(); } catch { /* never let the watchdog kill the dashboard */ } }, 5000);
  setInterval(() => { try { watchdogTick(); } catch { /* ignore */ } }, 60000).unref();
  setImmediate(refreshCapabilities);
  setInterval(refreshCapabilities, 60 * 60 * 1000).unref();
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
