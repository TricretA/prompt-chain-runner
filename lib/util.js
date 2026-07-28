'use strict';
const fs = require('fs');
const { spawnSync } = require('child_process');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Atomic-ish write: write to a temp file then rename over the target so readers
// (the dashboard) never see a half-written file. OneDrive/AV can briefly lock
// the target on Windows, so retry the rename and fall back to a direct write.
// Returns whether the data actually reached disk. Callers that loop on state
// (the backlog) must be able to tell a failed write from a successful one, or
// they will happily repeat work forever.
function atomicWriteJson(file, data) {
  const text = JSON.stringify(data, null, 2) + '\n';
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.renameSync(tmp, file);
        return true;
      } catch (err) {
        if (attempt === 2) throw err;
        busySleep(50 * (attempt + 1));
      }
    }
  } catch {
    // Last resort. Never throw out of here: a transient lock must not crash a
    // run — every caller rewrites this file again shortly.
    try {
      fs.writeFileSync(file, text, 'utf8');
      return true;
    } catch (err) {
      console.warn(`[runner] could not persist ${file}: ${err.message}`);
      return false;
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
  }
  return false;
}

function busySleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* short blocking wait, only used on rename retry */ }
}

function nowIso() {
  return new Date().toISOString();
}

function runStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Keep the tail of long output — build/test errors almost always live at the end.
function truncate(text, limit) {
  if (typeof text !== 'string') text = String(text ?? '');
  if (!limit || text.length <= limit) return text;
  const dropped = text.length - limit;
  return `[... first ${dropped} chars truncated ...]\n` + text.slice(-limit);
}

function quoteArg(arg) {
  arg = String(arg);
  if (arg === '') return '""';
  // Quote anything outside a conservative safe set — not just whitespace.
  // An unquoted & | ^ < > ( ) is a live operator under cmd.exe /d /s /c
  // (think a path through an "R&D" folder), and similar for POSIX shells.
  if (/^[A-Za-z0-9_\-.:\\/=@]+$/.test(arg)) return arg;
  if (process.platform === 'win32') {
    // cmd.exe: double quotes neutralize the operators above; embedded quotes
    // are doubled defensively. (%VAR% expansion survives quoting — keep
    // literal % out of claude_command/claude_args; prompts are safe, they
    // travel over stdin.)
    return '"' + arg.replace(/"/g, '""') + '"';
  }
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

// Build a single command line for spawn(..., { shell: true }) that survives
// spaces in paths on both Windows (cmd.exe /d /s /c) and POSIX shells.
function buildCommandLine(cmd, args) {
  return [cmd, ...args].map(quoteArg).join(' ');
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Guard against pid reuse: only treat a pid as "ours" if it still looks like a
// Node process. If we cannot tell, say no — a wrong kill (or a wrongly honored
// lock) is worse than a stale one.
//
// Memoized briefly because this is a blocking tasklist/ps spawn and the
// dashboard asks about the same pids on every 1.5s poll. Every caller already
// checks the free pidAlive() first, and pid reuse requires the pid to die, so
// a short TTL bounds the reuse window the check exists to catch.
const nodePidCache = new Map();
const PID_CACHE_TTL_MS = 10000;

function pidLooksLikeNode(pid) {
  const hit = nodePidCache.get(pid);
  if (hit && Date.now() - hit.at < PID_CACHE_TTL_MS) return hit.ok;
  let ok = false;
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/fi', `pid eq ${pid}`, '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      ok = /node/i.test(r.stdout || '');
    } else {
      const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 10000 });
      ok = /node/i.test(r.stdout || '');
    }
  } catch {
    ok = false;
  }
  if (nodePidCache.size > 256) nodePidCache.clear();
  nodePidCache.set(pid, { ok, at: Date.now() });
  return ok;
}

function slugify(name, fallback = 'project') {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || fallback;
}

function formatDuration(ms) {
  if (ms == null) return '?';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

module.exports = {
  readJson,
  atomicWriteJson,
  busySleep,
  nowIso,
  runStamp,
  truncate,
  quoteArg,
  buildCommandLine,
  slugify,
  pidAlive,
  pidLooksLikeNode,
  formatDuration,
};
