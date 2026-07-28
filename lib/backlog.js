'use strict';
// The overnight backlog: several projects lined up so the human can start a
// batch and walk away for a day. Distinct from lib/queue.js, which is the
// prompt queue *inside* one project — this is the list of projects themselves.
//
// Persisted as { items: [...] }. A bare top-level array is accepted on read so
// older and hand-written backlogs keep working; it is normalized on the way in
// and written back in object form.
//
// Contract: only addProject throws — it validates human input at the door,
// because a malformed entry otherwise surfaces hours into an unattended batch.
// It also throws rather than write over a backlog it could not read, since that
// would trade a day of queued projects for one new entry. Everything else is
// best-effort: a transient OneDrive/AV lock must never end a batch that still
// has work queued.

const fs = require('fs');
const crypto = require('crypto');
const { atomicWriteJson, busySleep, nowIso, runStamp, slugify } = require('./util');

const STATUSES = ['pending', 'running', 'done', 'failed'];
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function newId(taken) {
  // runStamp is only second-resolution, so two projects added in the same
  // second collide on everything but the suffix — re-roll against the ids
  // already in the file rather than trust four characters of luck.
  for (let attempt = 0; ; attempt++) {
    let suffix = '';
    for (let i = 0; i < 4; i++) suffix += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
    const id = `proj-${runStamp()}-${suffix}`;
    if (!taken.has(id) || attempt >= 10) return id;
  }
}

function normalizeDeploy(raw, projectName) {
  const d = raw && typeof raw === 'object' ? raw : {};
  return {
    // Defaults on, mirroring config.json's deploy.enabled: a batch left running
    // overnight is expected to come back with live URLs, not local folders.
    enabled: d.enabled !== false,
    // 'auto' is the sentinel the rest of the system resolves against real
    // capabilities; pinning a platform here would silently override both the
    // user's global deploy config and the Planner's own choice.
    target: typeof d.target === 'string' && d.target.trim() ? d.target.trim() : 'auto',
    repo_name: typeof d.repo_name === 'string' && d.repo_name.trim() ? d.repo_name.trim() : slugify(projectName),
  };
}

// Spread-then-override: markStatus shallow-merges caller-supplied keys into an
// item, and those must survive the next load instead of being stripped here.
function normalizeItem(raw, index) {
  const it = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const name = typeof it.project_name === 'string' ? it.project_name : '';
  return {
    ...it,
    // Hand-written entries often carry no id, but markStatus addresses items by
    // id — derive it from position so it is at least stable across loads.
    id: typeof it.id === 'string' && it.id.trim() ? it.id : `proj-item-${index + 1}`,
    project_name: name,
    brief: typeof it.brief === 'string' && it.brief.trim() ? it.brief.trim() : null,
    prompts: Array.isArray(it.prompts) && it.prompts.length ? it.prompts : null,
    context: typeof it.context === 'string' ? it.context : '',
    deploy: normalizeDeploy(it.deploy, name),
    status: STATUSES.includes(it.status) ? it.status : 'pending',
    added_at: typeof it.added_at === 'string' ? it.added_at : nowIso(),
    started_at: typeof it.started_at === 'string' ? it.started_at : null,
    finished_at: typeof it.finished_at === 'string' ? it.finished_at : null,
    result: it.result && typeof it.result === 'object' ? it.result : null,
  };
}

// Returns { ok, items }. ok:false means the file is there but we could not turn
// it into a backlog — locked, torn, or malformed. That is emphatically not the
// same as an empty backlog, and callers that would write the file back must not
// confuse the two: replacing an unreadable backlog with [] silently deletes
// every project still queued in it.
function readBacklog(file) {
  if (typeof file !== 'string' || !file) return { ok: true, items: [] };
  for (let attempt = 0; ; attempt++) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      // A missing backlog is simply an empty one. Anything else — an OneDrive/AV
      // lock, or a torn read of atomicWriteJson's non-atomic fallback path —
      // gets a short retry: giving up here reads as "batch finished" and would
      // park the runner with work still queued.
      if (err.code === 'ENOENT') return { ok: true, items: [] };
      if (attempt >= 3) return { ok: false, items: [] };
      busySleep(100 * (attempt + 1));
      continue;
    }
    // Notepad and PowerShell's Out-File write UTF-8 with a BOM and JSON.parse
    // rejects it, so a hand-written backlog — which this format explicitly
    // supports — would otherwise read as empty and then be overwritten.
    const text2 = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    // Nothing in the file is an empty backlog, not corruption: there is no
    // queued work to lose, and it is what an interrupted write leaves behind.
    if (!text2.trim()) return { ok: true, items: [] };
    let raw;
    try {
      raw = JSON.parse(text2);
    } catch {
      if (attempt >= 3) return { ok: false, items: [] };
      busySleep(100 * (attempt + 1));
      continue;
    }
    // Parsed, but shaped like neither a bare array nor { items: [...] }. Treat
    // it as unreadable rather than empty — we cannot prove there is no work in
    // there, so refusing to overwrite is the only safe reading.
    const items = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : null);
    if (!items) return { ok: false, items: [] };
    return { ok: true, items: items.map((item, i) => normalizeItem(item, i)) };
  }
}

// Best-effort by contract: an unreadable backlog reads as empty here, because
// every caller but addProject only ever reads it. addProject uses readBacklog
// directly so it can refuse to clobber.
function loadBacklog(file) {
  return readBacklog(file).items;
}

// The return value matters: the runner's project loop marks an item done and
// then asks for the next pending one, so a write that silently failed would
// hand back the same project forever.
function saveBacklog(file, items) {
  if (typeof file !== 'string' || !file || !Array.isArray(items)) return false;
  try {
    if (atomicWriteJson(file, { items }) === false) return false;
    return true;
  } catch (err) {
    // atomicWriteJson absorbs filesystem trouble itself, but it stringifies
    // before its own try/catch — a circular or BigInt field in `result` throws
    // straight through, and that must not take the batch down.
    console.warn(`[backlog] could not save ${file}: ${err.message}`);
    return false;
  }
}

function normalizePrompts(raw) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) throw new Error('addProject: "prompts" must be an array of {title, prompt} objects.');
  // An empty array means "nothing written yet" — the brief check below decides
  // whether that is acceptable.
  if (!raw.length) return null;
  return raw.map((p, i) => {
    const body = p && typeof p.prompt === 'string' ? p.prompt.trim() : '';
    if (!body) throw new Error(`addProject: prompts[${i}] needs a non-empty string "prompt".`);
    const title = p && typeof p.title === 'string' && p.title.trim() ? p.title.trim() : `Prompt ${i + 1}`;
    return { title, prompt: body };
  });
}

function addProject(file, project) {
  const p = project && typeof project === 'object' ? project : {};
  const name = typeof p.project_name === 'string' ? p.project_name.trim() : '';
  if (!name) throw new Error('addProject: project_name must be a non-empty string.');

  const brief = typeof p.brief === 'string' && p.brief.trim() ? p.brief.trim() : null;
  const prompts = normalizePrompts(p.prompts);
  if (!brief && !prompts) {
    throw new Error(`addProject: "${name}" needs either a "brief" (one line for the Planner to expand) or a non-empty "prompts" array.`);
  }

  // Read before writing, and refuse the write if the read failed: saving here
  // replaces the whole file, so a false "empty" would drop an overnight queue.
  const { ok, items } = readBacklog(file);
  if (!ok) {
    throw new Error(`addProject: could not read the existing backlog at ${file} — it is locked, or its JSON is malformed. Fix or move that file before adding "${name}"; adding now would overwrite the projects already queued in it.`);
  }

  const item = {
    id: newId(new Set(items.map((i) => i.id))),
    project_name: name,
    brief,
    prompts,
    context: typeof p.context === 'string' ? p.context.trim() : '',
    deploy: normalizeDeploy(p.deploy, name),
    status: STATUSES.includes(p.status) ? p.status : 'pending',
    added_at: nowIso(),
    started_at: null,
    finished_at: null,
    result: null,
  };
  items.push(item);
  saveBacklog(file, items);
  return item;
}

// Array order is queue order.
function nextPending(items) {
  if (!Array.isArray(items)) return null;
  return items.find((item) => item && item.status === 'pending') || null;
}

function markStatus(file, id, status, extra) {
  if (!id || !STATUSES.includes(status)) return false;
  const items = loadBacklog(file);
  const item = items.find((i) => i.id === id);
  if (!item) return false;

  if (extra && typeof extra === 'object') Object.assign(item, extra);
  // The explicit arguments win over `extra`, and the timestamps are derived
  // last so a re-queued failure ('failed' -> 'running') cannot carry its old
  // finish time and show a run that ended before it started.
  item.id = id;
  item.status = status;
  if (status === 'running') {
    item.started_at = nowIso();
    item.finished_at = null;
  }
  if (status === 'done' || status === 'failed') item.finished_at = nowIso();

  return saveBacklog(file, items);
}

function summarize(items) {
  const out = { total: 0, pending: 0, running: 0, done: 0, failed: 0 };
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    out.total++;
    const status = item && item.status;
    if (STATUSES.includes(status)) out[status]++;
  }
  return out;
}

module.exports = {
  loadBacklog,
  readBacklog,
  saveBacklog,
  addProject,
  nextPending,
  markStatus,
  summarize,
  STATUSES,
};
