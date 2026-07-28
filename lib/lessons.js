'use strict';
// Cross-run memory: "this error was fixed by this change". The orchestrator
// records a lesson when a fix round finally works, and looks one up before
// writing the next fix prompt — so a failure the company already solved once
// arrives with the answer attached instead of being re-derived.
//
// Storage is JSON Lines, append-only: two runs can append concurrently without
// a lock, and a torn write only costs the last record (findLessons skips lines
// that do not parse). Nothing here throws — a memory failure must never take
// down a run that is otherwise fine.

const fs = require('fs');
const path = require('path');
const { truncate, busySleep, nowIso } = require('./util');

const FIELD_LIMIT = 1500;
const MAX_LINES = 500;
const KEEP_LINES = 400;
const SIG_LIMIT = 200;
const SIG_INPUT_LIMIT = 200000;
const MIN_SCORE = 0.35;
const BLOCK_LIMIT = 1200;

// String(value) is itself a throw site: a null-prototype object, or a hostile
// toString/Symbol.toPrimitive, raises TypeError instead of returning text. Every
// coercion below runs on caller-supplied data, so they all go through here —
// otherwise "nothing here throws" only holds for callers who pass strings.
function safeString(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return String(value);
  } catch {
    return '';
  }
}

// --- signature -------------------------------------------------------------

// Fingerprint an error blob so the SAME class of failure in a different project
// hashes to the same string. Everything project-specific (paths, ids, ports,
// clock, numbers) is traded for a placeholder; what survives is the wording of
// the failure. Rule order matters: the specific patterns must consume their
// text before the greedy ones (line:col before port, port before bare number,
// uuid before hex hash) or they cannibalise each other.
function signature(errorText) {
  let s = safeString(errorText);
  if (!s.trim()) return '';
  // The window below is filled by the FIRST distinct tokens, so text past this
  // point can never reach it anyway. Slicing keeps a multi-megabyte test log
  // from paying for twenty full passes to produce the same 200 characters.
  if (s.length > SIG_INPUT_LIMIT) s = s.slice(0, SIG_INPUT_LIMIT);

  s = s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ' ')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
    .toLowerCase();

  s = s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ' <uuid> ')
    .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:z|[+-]\d{2}:?\d{2})?/g, ' <time> ')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?(?:\s*[ap]m)?/g, ' <time> ')
    // Before the path rules, not after: a greedy path match swallows the
    // trailing :line:col on windows ("c:\a\b.js:12:5") but not on posix, and
    // that alone would fingerprint the same stack trace two different ways.
    .replace(/:\d+:\d+/g, ' <pos> ')
    .replace(/\bhttps?:\/\/\S+/g, ' <url> ')
    .replace(/\b[a-z]:[\\/][^\s'"`)\]]*/g, ' <path> ')
    .replace(/(?:file|node):\/*[^\s'"`)\]]+/g, ' <path> ')
    .replace(/\\\\[^\s'"`)\]]+/g, ' <path> ')
    // The lookbehind is load-bearing, not decoration. Without it the leading
    // [\w.@~-]* restarts at every offset inside an unbroken run of those chars,
    // each time consuming to the end of the run and backtracking a char at a
    // time to look for a separator — O(run^2). base64url's alphabet is a subset
    // of this class, so one JWT or inline sourcemap in a build log is enough:
    // 64KB took 18s, 128KB took 68s, and half a megabyte never came back.
    // Anchoring to a run boundary is free of semantic cost, because whether a
    // match exists is decided solely by the character following the run — the
    // same answer at every start position inside it.
    .replace(/(?<![\w.@~-])[\w.@~-]*(?:[\\/][\w.@~-]+)+/g, ' <path> ')
    // Anchored for the same reason as the rule above, and it bit harder here:
    // \b re-entered the token at every '.' and '-', so a run of them cost
    // O(run^2) — 100KB of "a.a.a..." took 88 seconds. Anchoring also stops a
    // leading dot or dash being left stranded outside the placeholder, so
    // ".eslintrc.js" now normalises whole instead of to ". <file>".
    .replace(/(?<![\w.-])[\w.-]+\.(?:js|jsx|ts|tsx|mjs|cjs|json|jsonl|css|scss|sass|less|html|htm|vue|svelte|py|rb|go|rs|java|php|sql|sh|ps1|bat|md|ya?ml|toml|lock|env|txt|log)\b/g, ' <file> ')
    .replace(/\b(?:line|col|column|position|offset)\s+\d+/g, ' <pos> ')
    .replace(/\bv?\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?\b/g, ' <ver> ')
    .replace(/:\d{2,5}\b/g, ' <port> ')
    .replace(/\b0x[0-9a-f]+\b/g, ' <hash> ')
    .replace(/\b[0-9a-f]{7,}\b/g, ' <hash> ')
    .replace(/\b\d+\b/g, ' <n> ')
    .replace(/\s+/g, ' ')
    .trim();

  // Stack traces repeat the same frame shape hundreds of times; dropping repeats
  // before the cut is what lets real wording reach the 200-char window.
  const seen = new Set();
  const kept = [];
  for (const tok of s.split(' ')) {
    if (!tok || seen.has(tok)) continue;
    seen.add(tok);
    kept.push(tok);
  }
  const joined = kept.join(' ');
  if (joined.length <= SIG_LIMIT) return joined;
  const cut = joined.slice(0, SIG_LIMIT);
  const edge = cut.lastIndexOf(' ');
  return (edge > 0 ? cut.slice(0, edge) : cut).trim();
}

// Placeholders appear in nearly every signature, so scoring on them would make
// unrelated failures look like twins. Same for leftover punctuation and single
// characters — noise that only inflates the overlap.
function sigTokens(sig) {
  const out = new Set();
  for (const tok of String(sig || '').split(' ')) {
    if (tok.length < 2 || !/[a-z0-9]/.test(tok) || /^<[a-z]+>$/.test(tok)) continue;
    out.add(tok);
  }
  return out;
}

// Dice coefficient — cheap, symmetric, and forgiving of one blob carrying extra
// context the other lacks (the usual shape of "same bug, noisier log").
function diceScore(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const tok of small) if (large.has(tok)) shared++;
  return (2 * shared) / (a.size + b.size);
}

// --- record ----------------------------------------------------------------

function capField(value, limit) {
  const text = safeString(value);
  return text ? truncate(text, limit) : '';
}

// OneDrive/AV hold brief exclusive locks on files they are syncing; a lesson is
// worth three quick tries before we give up on it.
function appendWithRetry(file, line) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.appendFileSync(file, line, 'utf8');
      return true;
    } catch (err) {
      if (attempt >= 2) throw err;
      busySleep(60 * (attempt + 1));
    }
  }
}

// Rewrite via tmp+rename so a reader never sees a half-trimmed file. Failure is
// swallowed by the caller: an oversized memory beats a lost one.
function rewriteWithRetry(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 2) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
        throw err;
      }
      busySleep(60 * (attempt + 1));
    }
  }
}

function trimFile(file) {
  // A full record is never under ~120 bytes (ts + signature + eight keys), so a
  // file this small cannot be over the line cap — worth a stat to skip reading
  // a couple of megabytes back on every single append.
  if (fs.statSync(file).size < MAX_LINES * 100) return;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  if (lines.length <= MAX_LINES) return;
  rewriteWithRetry(file, lines.slice(-KEEP_LINES).join('\n') + '\n');
}

// entry = { project, phase, agent, error, fix, evidence }. Returns false rather
// than throwing on any problem — the caller is mid-run and cannot act on it.
function recordLesson(file, entry) {
  try {
    if (!file || !entry || typeof entry !== 'object') return false;
    const sig = signature(entry.error);
    // A lesson nothing can ever match back is just file growth.
    if (!sig) return false;

    const record = {
      ts: nowIso(),
      signature: sig,
      project: capField(entry.project, 200),
      phase: capField(entry.phase, 120),
      agent: capField(entry.agent, 60),
      error: capField(entry.error, FIELD_LIMIT),
      fix: capField(entry.fix, FIELD_LIMIT),
      evidence: capField(entry.evidence, FIELD_LIMIT),
    };

    fs.mkdirSync(path.dirname(file), { recursive: true });
    // JSON.stringify escapes every newline, so one record is always one line.
    appendWithRetry(file, JSON.stringify(record) + '\n');
    // The append already succeeded; trimming is housekeeping and its failure
    // must not report the lesson as lost.
    try { trimFile(file); } catch { /* retry on the next record */ }
    return true;
  } catch {
    return false;
  }
}

// --- lookup ----------------------------------------------------------------

function readWithRetry(file) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (err) {
      // No memory yet is the normal first-run state, not a lock to wait on.
      if (err.code === 'ENOENT' || attempt >= 2) return null;
      busySleep(60 * (attempt + 1));
    }
  }
}

// Best matches first, each with .score. [] when the file is missing, unreadable,
// or nothing clears the floor. Linear over the (capped) file, so ~500 cheap
// set comparisons at worst.
function findLessons(file, errorText, limit = 3) {
  try {
    const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 3;
    if (!file || !max) return [];
    const query = sigTokens(signature(errorText));
    if (!query.size) return [];

    const text = readWithRetry(file);
    if (!text) return [];

    const hits = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (!rec || typeof rec !== 'object' || typeof rec.signature !== 'string') continue;
      const score = diceScore(query, sigTokens(rec.signature));
      if (score >= MIN_SCORE) hits.push({ ...rec, score: Math.round(score * 1000) / 1000 });
    }

    // Equal-scoring lessons: the newest one reflects the current codebase.
    hits.sort((a, b) => b.score - a.score || String(b.ts || '').localeCompare(String(a.ts || '')));
    return hits.slice(0, max);
  } catch {
    return [];
  }
}

// --- formatting ------------------------------------------------------------

// Stored text arrives tail-truncated, so it can open with truncate()'s marker —
// strip it, or every lesson line starts by talking about truncation.
function oneLine(value, limit) {
  const text = safeString(value)
    .replace(/^\[\.\.\. first \d+ chars truncated \.\.\.\]\s*/, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '(none)';
  // ASCII ellipsis on purpose: this block is echoed to a cp1252 Windows console.
  return text.length <= limit ? text : text.slice(0, limit - 3).trimEnd() + '...';
}

// A prompt block, or '' when there is nothing to say (callers concatenate it
// blind). Hard-capped so old memories can never crowd out the live evidence.
function formatLessons(lessons) {
  if (!Array.isArray(lessons) || !lessons.length) return '';
  const header = 'Lessons from earlier runs that look related to this failure:';
  const lines = [];
  let budget = BLOCK_LIMIT - header.length;
  for (const lesson of lessons) {
    if (!lesson || typeof lesson !== 'object') continue;
    const line = `${lines.length + 1}. Error: ${oneLine(lesson.error, 160)} -> Fix that worked: ${oneLine(lesson.fix, 200)}`;
    if (line.length + 1 > budget) break;
    budget -= line.length + 1;
    lines.push(line);
  }
  return lines.length ? [header, ...lines].join('\n') : '';
}

module.exports = { signature, recordLesson, findLessons, formatLessons };
