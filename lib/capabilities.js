'use strict';
// What this machine can actually do — probed, never assumed. The result is
// pasted verbatim into agent prompts, so a wrong "available" is far worse than
// a missing one: every probe fails closed and none of them may throw at the
// caller. Probing costs a few seconds of child processes, hence the cache.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildCommandLine, nowIso } = require('./util');

const PROBE_TIMEOUT_MS = 15000;

let cached = null;

// --- probe plumbing --------------------------------------------------------

// One child process, never fatal. shell:true because gh/vercel/netlify/npx are
// .cmd shims on Windows and spawnSync cannot exec those directly; the command
// line goes through the runner's own quoting so a space in PATH stays harmless.
function probe(cmd, args) {
  try {
    const res = spawnSync(buildCommandLine(cmd, args), {
      shell: true,
      encoding: 'utf8',
      windowsHide: true,
      timeout: PROBE_TIMEOUT_MS,
      // stdin closed: an unattended probe must never sit on a CLI's prompt.
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 4 * 1024 * 1024,
      // Colour codes would end up inside the account names parsed below.
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    const stdout = clean(res.stdout);
    const stderr = clean(res.stderr);
    return {
      ok: !res.error && res.status === 0,
      stdout,
      stderr,
      // gh prints auth status to stderr on some versions and stdout on others,
      // so pattern matching always runs against both streams.
      out: [stdout, stderr].filter(Boolean).join('\n'),
    };
  } catch {
    return { ok: false, stdout: '', stderr: '', out: '' };
  }
}

function clean(text) {
  // Strip SGR colour codes: they would otherwise end up inside parsed names.
  return String(text == null ? '' : text).replace(/\u001b\[[0-9;]*m/g, '').trim();
}

function firstLine(text) {
  return String(text || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
}

// "Vercel CLI 39.1.1" and a bare "2.62.0" both come back from --version across
// these CLIs; only prefix the tool name when the tool did not already say it.
function versionLabel(name, text) {
  const line = firstLine(text);
  if (!line) return name;
  return new RegExp(name, 'i').test(line) ? line : `${name} ${line}`;
}

// Prefer a real install, fall back to a locally installed copy. --no-install is
// deliberate: a probe must never trigger a package download on a metered box.
function resolveRunner(bin) {
  const direct = probe(bin, ['--version']);
  if (direct.ok) return { argv: [bin], version: firstLine(direct.out) };
  const viaNpx = probe('npx', ['--no-install', bin, '--version']);
  if (viaNpx.ok) return { argv: ['npx', '--no-install', bin], version: firstLine(viaNpx.out) };
  return null;
}

function runWith(runner, args) {
  return probe(runner.argv[0], [...runner.argv.slice(1), ...args]);
}

function unavailable(detail, alwaysAuthed) {
  return { available: false, authed: !!alwaysAuthed, account: null, detail };
}

// --- individual tools ------------------------------------------------------

function probeGithub() {
  const v = probe('gh', ['--version']);
  if (!v.ok) return unavailable('not installed (install: https://cli.github.com)');
  const version = versionLabel('gh', v.out);
  const auth = probe('gh', ['auth', 'status']);
  if (!auth.ok) return { available: true, authed: false, account: null, detail: `${version}, not logged in (run: gh auth login)` };
  const account = parseGhAccount(auth.out);
  return { available: true, authed: true, account, detail: `${version}, logged in as ${account || 'unknown account'}` };
}

// gh lists every account it remembers, but only the one flagged "Active account:
// true" is the identity a push would actually use. Older gh omits that flag
// entirely, so the first listed account is the fallback.
function parseGhAccount(text) {
  const lines = String(text || '').split(/\r?\n/);
  const seen = [];
  const header = /Logged in to \S+ account (\S+)/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(header);
    if (!m) continue;
    seen.push(m[1]);
    for (let j = i + 1; j < lines.length && !header.test(lines[j]); j++) {
      if (/Active account:\s*true/i.test(lines[j])) return m[1];
    }
  }
  return seen[0] || null;
}

function probeVercel() {
  const v = probe('vercel', ['--version']);
  if (!v.ok) return unavailable('not installed (use: npx vercel)');
  const version = versionLabel('vercel', v.out);
  const who = probe('vercel', ['whoami']);
  const account = who.ok ? parseVercelAccount(who) : null;
  if (!account) return { available: true, authed: false, account: null, detail: `${version}, not logged in (run: vercel login)` };
  return { available: true, authed: true, account, detail: `${version}, logged in as ${account}` };
}

// The CLI prints a "> Vercel CLI 39.x" banner before the answer, so the account
// is the LAST usable line. A slug never contains whitespace — anything else on
// that line is an error message, not an identity.
function parseVercelAccount(res) {
  const lines = String(res.stdout || res.out || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((l) => l && !l.startsWith('>') && !/vercel cli/i.test(l));
  const last = lines[lines.length - 1];
  return last && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(last) ? last : null;
}

function probeNetlify() {
  const runner = resolveRunner('netlify');
  if (!runner) return unavailable('not installed (use: npx netlify-cli)');
  const version = versionLabel('netlify', runner.version);
  const status = runWith(runner, ['status']);
  // `netlify status` exits 0 while plainly saying it has no session.
  if (!status.ok || /not logged in/i.test(status.out)) {
    return { available: true, authed: false, account: null, detail: `${version}, not logged in (run: netlify login)` };
  }
  const account = parseNetlifyAccount(status.out);
  return { available: true, authed: true, account, detail: `${version}, logged in as ${account || 'unknown account'}` };
}

function parseNetlifyAccount(text) {
  const name = String(text || '').match(/^\s*Name:\s*(.+)$/m);
  if (name) return name[1].trim();
  const email = String(text || '').match(/^\s*Email:\s*(\S+)/m);
  return email ? email[1].trim() : null;
}

function probeSupabase() {
  const runner = resolveRunner('supabase');
  if (!runner) return unavailable('not installed (use: npx supabase)');
  const version = versionLabel('supabase', runner.version);
  const list = runWith(runner, ['projects', 'list']);
  if (!list.ok) return { available: true, authed: false, account: null, detail: `${version}, not logged in (run: supabase login)` };
  return { available: true, authed: true, account: null, detail: `${version}, logged in` };
}

// Browsers are what make a Playwright test runnable; the CLI alone cannot drive
// anything, so the cache directory is the primary signal and the CLI the hint.
function probePlaywright() {
  const dir = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright')
    : path.join(os.homedir(), '.cache', 'ms-playwright');
  let chromium = null;
  try {
    chromium = fs.readdirSync(dir).find((e) => /^chromium/i.test(e)) || null;
  } catch { /* missing dir simply means nothing is cached */ }
  // A cached browser already answers the only question that matters, and an
  // npx round-trip costs seconds — don't pay it just to decorate the label.
  if (chromium) {
    return { available: true, authed: true, account: null, detail: `chromium cached at ${dir}` };
  }
  const cli = probe('npx', ['--no-install', 'playwright', '--version']);
  const version = cli.ok ? versionLabel('playwright', cli.out) : '';
  if (chromium) {
    return { available: true, authed: true, account: null, detail: `chromium cached at ${dir}${version ? ` (${version})` : ''}` };
  }
  if (cli.ok) {
    return { available: true, authed: true, account: null, detail: `${version}, no browsers cached in ${dir} (run: npx playwright install chromium)` };
  }
  return { available: false, authed: true, account: null, detail: `not installed, no browsers cached in ${dir}` };
}

function probeGit() {
  const v = probe('git', ['--version']);
  if (!v.ok) return unavailable('not installed', true);
  return { available: true, authed: true, account: null, detail: versionLabel('git', v.out) };
}

// --- public API ------------------------------------------------------------

// A probe that throws anyway (exotic PATH or FS error) must still yield a valid
// entry: callers embed this object in a prompt, no field is optional.
function safeProbe(fn, alwaysAuthed) {
  try {
    return fn();
  } catch (err) {
    return unavailable(`probe failed: ${err && err.message ? err.message : err}`, alwaysAuthed);
  }
}

// A full probe costs the better part of a minute (npx shims on Windows are
// slow), and every runner start plus every dashboard poll would otherwise pay
// it. Results are therefore cached in-process AND on disk with a TTL, and an
// explicit override skips probing entirely (tests, or a machine where the user
// already knows the answer).
const DEFAULT_TTL_MS = 60 * 60 * 1000;

function detectCapabilities(opts = {}) {
  if (opts.override && typeof opts.override === 'object') {
    cached = { ...opts.override, checked_at: nowIso() };
    return cached;
  }
  // The in-process memo is age-checked too, or a long-lived process (the
  // dashboard) would never notice a login that happened after it booted.
  const ttl = opts.ttlMs == null ? DEFAULT_TTL_MS : opts.ttlMs;
  if (cached && !opts.refresh && ttl > 0) {
    const age = Date.now() - Date.parse(cached.checked_at);
    if (Number.isFinite(age) && age >= 0 && age < ttl) return cached;
  }

  if (opts.cacheFile && !opts.refresh && ttl > 0) {
    try {
      const disk = JSON.parse(fs.readFileSync(opts.cacheFile, 'utf8'));
      const age = Date.now() - Date.parse(disk.checked_at);
      if (Number.isFinite(age) && age >= 0 && age < ttl) {
        cached = disk;
        return cached;
      }
    } catch { /* no usable cache — probe */ }
  }

  cached = {
    github: safeProbe(probeGithub),
    vercel: safeProbe(probeVercel),
    netlify: safeProbe(probeNetlify),
    supabase: safeProbe(probeSupabase),
    playwright: safeProbe(probePlaywright, true),
    git: safeProbe(probeGit, true),
    checked_at: nowIso(),
  };
  if (opts.cacheFile) {
    try {
      fs.mkdirSync(path.dirname(opts.cacheFile), { recursive: true });
      fs.writeFileSync(opts.cacheFile, JSON.stringify(cached, null, 2));
    } catch { /* a missing cache only costs time, never correctness */ }
  }
  return cached;
}

const CLI_LINES = [
  ['github', 'GitHub CLI', 'gh auth login'],
  ['vercel', 'Vercel CLI', 'vercel login'],
  ['netlify', 'Netlify CLI', 'netlify login'],
  ['supabase', 'Supabase CLI', 'supabase login'],
];

// Stringify a field that is supposed to be text but came from an object we did
// not necessarily build. A template literal would throw on a Symbol or on a
// hand-rolled toString, and the fallback keeps the old `value || fallback` reading.
function text(value, fallback) {
  if (!value) return fallback;
  try {
    return String(value) || fallback;
  } catch {
    return fallback;
  }
}

// Build one line, or none. Same reasoning as pickDeployTarget's wrapper: this
// string is assembled at startup and pasted into every agent prompt, so a single
// exotic entry (throwing accessor, unstringifiable field) must cost that entry's
// line and nothing more.
function capLine(build) {
  try {
    const line = build();
    return typeof line === 'string' && line ? line : null;
  } catch {
    return null;
  }
}

// Goes verbatim into agent prompts: terse, one line per probed tool, and silent
// about anything that was not probed rather than guessing at it.
function describeCapabilities(caps) {
  if (!caps || typeof caps !== 'object') return '';
  const lines = [];
  for (const [key, label, loginHint] of CLI_LINES) {
    const line = capLine(() => {
      const c = caps[key];
      if (!c || typeof c !== 'object') return null;
      if (!c.available) return `- ${label}: ${text(c.detail, 'not installed')}`;
      if (c.authed) return `- ${label}: available, logged in as ${text(c.account, 'unknown account')}`;
      return `- ${label}: available, NOT logged in (run: ${loginHint})`;
    });
    if (line) lines.push(line);
  }
  const playwright = capLine(() => (caps.playwright && typeof caps.playwright === 'object'
    ? `- Playwright browsers: ${text(caps.playwright.detail, 'unknown')}`
    : null));
  if (playwright) lines.push(playwright);
  const git = capLine(() => (caps.git && typeof caps.git === 'object'
    ? `- Git: ${caps.git.available ? text(caps.git.detail, 'available') : 'not installed'}`
    : null));
  if (git) lines.push(git);
  return lines.join('\n');
}

const TARGET_CAP = { 'github-pages': 'github', vercel: 'vercel', netlify: 'netlify' };
const AUTO_ORDER = ['vercel', 'github-pages', 'netlify'];

function pickDeployTarget(caps, preferred) {
  const usable = (target) => {
    const c = caps && caps[TARGET_CAP[target]];
    return !!(c && c.available && c.authed);
  };
  try {
    if (typeof preferred === 'string' && preferred !== 'auto' && Object.hasOwn(TARGET_CAP, preferred) && usable(preferred)) {
      return preferred;
    }
    // A preference we cannot honour falls through to the auto order instead of
    // vetoing the deploy — the caller wants somewhere to ship, not a refusal.
    return AUTO_ORDER.find(usable) || 'none';
  } catch {
    return 'none';
  }
}

module.exports = {
  detectCapabilities,
  describeCapabilities,
  pickDeployTarget,
};
