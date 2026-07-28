'use strict';
// Off-machine notification: the overnight run's only way to reach a human who
// is not at this desk. lib/notify.js can only raise a toast on the box that is
// already running the build — this one goes to the phone.
//
// Every channel is optional, all configured channels fire concurrently, and a
// channel that fails (bad token, DNS down, ntfy 500) resolves to evidence.
// Nothing in here ever throws or rejects: a notification is the last step of a
// run and must never be able to fail one.

const https = require('https');
const http = require('http');

const REQUEST_TIMEOUT_MS = 15000;
const USER_AGENT = 'prompt-chain-runner';

// Phone push has hard server-side caps; over them the API 400s and the human
// hears nothing at all. Clip well under each.
const LIMITS = { ntfy: 3500, telegram: 4000, discord: 1900, slack: 3000, header: 200 };

// --- transport -------------------------------------------------------------

// One hand-built request. Resolves { ok, status, detail } for every outcome —
// bad URL, DNS failure, timeout, HTTP error — so callers need no try/catch.
function httpRequest(rawUrl, { method = 'POST', headers = {}, body = '' } = {}) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(String(rawUrl ?? ''));
    } catch {
      return resolve({ ok: false, status: null, detail: `not a url: ${short(rawUrl)}` });
    }
    const mod = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
    if (!mod) return resolve({ ok: false, status: null, detail: `not an http(s) url: ${target.protocol}` });

    const payload = Buffer.from(String(body), 'utf8');
    let settled = false;
    let guard = null;
    const settle = (r) => {
      if (settled) return;
      settled = true;
      if (guard) clearTimeout(guard);
      resolve(r);
    };

    let req;
    try {
      // Content-Length last so a caller-supplied one can never override it — a
      // wrong length hangs the socket until the timeout instead of failing fast
      // (message bodies are UTF-8, so it must be byte length, not .length).
      req = mod.request(target, {
        method: safeMethod(method),
        timeout: REQUEST_TIMEOUT_MS,
        headers: { 'User-Agent': USER_AGENT, ...headers, 'Content-Length': payload.length },
      }, (res) => {
        const status = res.statusCode;
        let text = '';
        res.setEncoding('utf8');
        // Read the body: a 4xx from Telegram/Discord explains itself there, and
        // that string is the only debugging a human gets from a phone.
        res.on('data', (d) => { if (text.length < 1000) text += d; });
        const done = () => settle({
          ok: status >= 200 && status < 300,
          status,
          detail: `HTTP ${status}${status >= 200 && status < 300 ? '' : ` ${short(text.trim(), 300)}`}`.trim(),
        });
        res.on('end', done);
        res.on('close', done);
        res.on('error', (err) => settle({ ok: false, status, detail: `HTTP ${status} then ${err.message}` }));
      });
    } catch (err) {
      // Node validates header names/values synchronously (ERR_INVALID_CHAR on a
      // stray newline from config) — that is a config bug, not a crash.
      return settle({ ok: false, status: null, detail: `request rejected: ${err.message}` });
    }

    req.on('timeout', () => { req.destroy(); settle({ ok: false, status: null, detail: `timed out after ${REQUEST_TIMEOUT_MS}ms` }); });
    req.on('error', (err) => settle({ ok: false, status: null, detail: err.message }));

    // Belt and braces: the socket timeout does not cover every stall (a server
    // that dribbles bytes forever). unref so a pending notification can never
    // hold the runner process open after the run is done.
    guard = setTimeout(() => { try { req.destroy(); } catch { /* already gone */ } settle({ ok: false, status: null, detail: `timed out after ${REQUEST_TIMEOUT_MS}ms` }); }, REQUEST_TIMEOUT_MS + 1000);
    if (typeof guard.unref === 'function') guard.unref();

    try { req.end(payload); } catch (err) { settle({ ok: false, status: null, detail: `send failed: ${err.message}` }); }
  });
}

function postJson(url, obj, extraHeaders, method) {
  let body;
  try {
    body = JSON.stringify(obj);
  } catch (err) {
    return Promise.resolve({ ok: false, status: null, detail: `unserializable payload: ${err.message}` });
  }
  return httpRequest(url, {
    method: method || 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: body ?? '{}',
  });
}

// --- text helpers ----------------------------------------------------------

// String() is not total: it throws on a null-prototype object (no toString) and
// on any hostile toString/valueOf. Message fields come from agent code, so an
// unprintable one must degrade to '' rather than take the whole send down.
function str(v) {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  try { return String(v); } catch { return ''; }
}

// Clip the head, not the tail (util.truncate's job): a push notification is
// read top-down and the title/first line is the whole point.
function clip(s, limit) {
  s = str(s);
  return s.length <= limit ? s : s.slice(0, limit - 3) + '...';
}

// Header values must be single-line printable ASCII: ntfy rejects non-ASCII
// (emoji in a run title is the common case) and Node throws ERR_INVALID_CHAR on
// CR/LF, which is also the header-injection vector. Captured CLI output reaches
// us with ANSI escapes, so strip those first.
function asciiHeader(s, limit = LIMITS.header) {
  let out = str(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  // NFKD first so accents decompose and survive as their base letter — dropping
  // them outright turns "café" into "caf" mid-word.
  try { out = out.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); } catch { /* keep raw */ }
  return clip(out.replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim(), limit);
}

function httpUrl(value) {
  try {
    const u = new URL(str(value));
    return (u.protocol === 'https:' || u.protocol === 'http:') ? u.toString() : '';
  } catch { return ''; }
}

function safeMethod(m) {
  const v = str(m).toUpperCase();
  return /^[A-Z]{3,10}$/.test(v) ? v : 'POST';
}

function short(v, limit = 120) { return clip(str(v), limit); }

function nonEmpty(v) { return typeof v === 'string' ? v.trim() !== '' : typeof v === 'number' && Number.isFinite(v); }

function joinLines(parts) { return parts.filter((p) => str(p).trim() !== '').join('\n'); }

// Reading a property can itself throw (a getter on an object handed to us by
// agent code). Lose the one bad field, not the notification.
function pick(obj, key) {
  try { return obj[key]; } catch { return undefined; }
}

// Callers are agents and runner code; assume nothing about the shape. This runs
// once for all channels, so anything it throws would cancel every one of them —
// it must be total.
function normalizeMessage(message) {
  const m = message && typeof message === 'object' ? message : {};
  const level = pick(m, 'level');
  return {
    title: str(pick(m, 'title')).trim() || 'prompt-chain-runner',
    body: str(pick(m, 'body')),
    url: httpUrl(pick(m, 'url')),
    level: level === 'success' || level === 'error' ? level : 'info',
  };
}

// --- channels --------------------------------------------------------------

const NTFY_TAGS = { success: 'white_check_mark', error: 'rotating_light', info: 'information_source' };

const CHANNELS = {
  ntfy: {
    configured: (c) => nonEmpty(c.topic),
    send: (c, m) => {
      const server = str(c.server).trim().replace(/\/+$/, '') || 'https://ntfy.sh';
      // encode the topic: a stray space or slash from config would otherwise
      // rewrite the request path instead of failing visibly.
      const url = `${server}/${encodeURIComponent(str(c.topic).trim())}`;
      const headers = {
        'Content-Type': 'text/plain; charset=utf-8',
        Priority: m.level === 'error' ? '5' : '3',
        Tags: NTFY_TAGS[m.level] || NTFY_TAGS.info,
      };
      const title = asciiHeader(m.title);
      if (title) headers.Title = title;
      if (m.url) headers.Click = asciiHeader(m.url, 500);
      // ntfy 400s on an empty body — fall back to something readable.
      const body = clip(m.body.trim() || m.title || 'run update', LIMITS.ntfy);
      return httpRequest(url, { headers, body });
    },
  },

  telegram: {
    configured: (c) => nonEmpty(c.bot_token) && nonEmpty(c.chat_id),
    send: (c, m) => {
      // Bot tokens embed a ':' — percent-encoding the path segment would break
      // the URL, so only whitespace is stripped.
      const token = str(c.bot_token).trim();
      return postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: str(c.chat_id).trim(),
        text: clip(joinLines([m.title, m.body, m.url]), LIMITS.telegram),
        disable_web_page_preview: false,
      });
    },
  },

  discord: {
    configured: (c) => nonEmpty(c.webhook_url),
    send: (c, m) => postJson(str(c.webhook_url).trim(), {
      content: clip(joinLines([m.title, m.body, m.url]), LIMITS.discord),
    }),
  },

  slack: {
    configured: (c) => nonEmpty(c.webhook_url),
    send: (c, m) => postJson(str(c.webhook_url).trim(), {
      text: clip(joinLines([m.title, m.body, m.url]), LIMITS.slack),
    }),
  },

  webhook: {
    configured: (c) => nonEmpty(c.url),
    send: (c, m, raw) => {
      // Forward the caller's object untouched where possible (a custom relay may
      // read extra fields), with the four documented keys guaranteed.
      let payload;
      try {
        payload = { ...(raw && typeof raw === 'object' ? raw : {}), ...m };
      } catch { payload = m; }
      return postJson(str(c.url).trim(), payload, sanitizeHeaders(c.headers), c.method);
    },
  },
};

// Config-supplied headers reach Node's validator directly; a newline or a
// non-string value there would throw synchronously.
function sanitizeHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [k, v] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(k)) continue;
    const value = asciiHeader(v, 1000);
    if (value) out[k] = value;
  }
  return out;
}

// --- api -------------------------------------------------------------------

// Names of channels whose required fields are present. Pure field inspection —
// it answers "what is wired up", which is what the dashboard shows; it does not
// consult notify.enabled.
function channelsConfigured(notifyConfig) {
  try {
    if (!notifyConfig || typeof notifyConfig !== 'object') return [];
    return Object.keys(CHANNELS).filter((name) => {
      const c = notifyConfig[name];
      if (!c || typeof c !== 'object') return false;
      try { return CHANNELS[name].configured(c) === true; } catch { return false; }
    });
  } catch {
    return [];
  }
}

// Fires every configured channel concurrently. Resolves an array of
// { channel, ok, detail } — one entry per configured channel, always. Never
// rejects; an empty array means nothing was wired up (or notify is disabled).
async function sendRemote(notifyConfig, message) {
  try {
    if (notifyConfig && notifyConfig.enabled === false) return [];
    const names = channelsConfigured(notifyConfig);
    if (names.length === 0) return [];
    const m = normalizeMessage(message);
    return await Promise.all(names.map((name) => {
      let p;
      try {
        p = CHANNELS[name].send(notifyConfig[name], m, message);
      } catch (err) {
        return { channel: name, ok: false, detail: `send threw: ${err.message}` };
      }
      return Promise.resolve(p).then(
        (r) => ({ channel: name, ok: r ? r.ok === true : false, detail: r ? str(r.detail) : 'no result' }),
        (err) => ({ channel: name, ok: false, detail: str(err && err.message) || 'unknown error' }),
      );
    }));
  } catch (err) {
    // Unreachable in practice; the contract is "never rejects", so honor it.
    console.warn(`[runner] remote notify failed: ${err.message}`);
    return [];
  }
}

module.exports = { sendRemote, channelsConfigured };
