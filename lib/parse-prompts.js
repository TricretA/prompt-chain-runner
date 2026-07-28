'use strict';
// Turns a markdown or plain-text file into an ordered prompt queue.
//
// Splitting strategy, first one that yields 2+ prompts wins:
//   1. Markdown headings — the shallowest heading level that occurs 2+ times
//      becomes the prompt boundary (so "# Project" + "## Prompt 1/2/3" splits
//      on ##, not on the lone #).
//   2. Horizontal rules (--- / *** / ___) as separators.
//   3. Numbered markers at line start: "Prompt 1:", "Step 2.", "Phase 3)",
//      "Task 4 -", or bare "1." / "2)".
//   4. Otherwise the whole file is a single prompt.
//
// Text before the first boundary becomes the shared project "context": it is
// prepended (by the runner) to every builder prompt, because that is where
// authors put the overall brief.

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const NUMBER_RE = /^\s*(?:(?:prompt|step|phase|task|part)\s*)?(\d{1,3})\s*[:.)\-]\s+/i;

function normalizeNewlines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

function titleFrom(text, fallback) {
  const first = text.split('\n').map((l) => l.trim()).find(Boolean) || '';
  const clean = first.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim();
  if (clean && clean.length <= 80) return clean;
  if (clean) return clean.slice(0, 77) + '...';
  return fallback;
}

function makePrompt(index, title, body) {
  return {
    id: `prompt-${index + 1}`,
    title: title || `Prompt ${index + 1}`,
    prompt: body.trim(),
  };
}

function splitByHeadings(lines) {
  // Ignore headings inside fenced code blocks.
  const headings = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = lines[i].match(HEADING_RE);
    if (m) headings.push({ line: i, level: m[1].length, title: m[2].trim() });
  }
  if (!headings.length) return null;

  const counts = new Map();
  for (const h of headings) counts.set(h.level, (counts.get(h.level) || 0) + 1);
  let splitLevel = null;
  for (const level of [...counts.keys()].sort((a, b) => a - b)) {
    if (counts.get(level) >= 2) { splitLevel = level; break; }
  }
  if (splitLevel === null) return null;

  const boundaries = headings.filter((h) => h.level === splitLevel);
  const preamble = lines.slice(0, boundaries[0].line).join('\n').trim();
  const prompts = boundaries.map((b, i) => {
    const end = i + 1 < boundaries.length ? boundaries[i + 1].line : lines.length;
    const body = lines.slice(b.line + 1, end).join('\n');
    return makePrompt(i, titleFrom(b.title, null), body);
  });
  return { preamble, prompts, strategy: 'headings' };
}

function splitBySeparators(lines) {
  const segments = [];
  let current = [];
  let inFence = false;
  let sawSeparator = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && HR_RE.test(line)) {
      sawSeparator = true;
      segments.push(current.join('\n'));
      current = [];
    } else {
      current.push(line);
    }
  }
  segments.push(current.join('\n'));
  const nonEmpty = segments.map((s) => s.trim()).filter(Boolean);
  if (!sawSeparator || nonEmpty.length < 2) return null;
  return {
    preamble: '',
    prompts: nonEmpty.map((body, i) => makePrompt(i, titleFrom(body, null), body)),
    strategy: 'separators',
  };
}

function splitByNumbers(lines) {
  const marks = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = lines[i].match(NUMBER_RE);
    if (m) marks.push({ line: i, n: parseInt(m[1], 10) });
  }
  // Require an ascending 1,2,3... shape so an indented sub-list inside a
  // single prompt does not get shredded into fake prompts.
  if (marks.length < 2 || marks[0].n !== 1) return null;
  for (let i = 1; i < marks.length; i++) {
    if (marks[i].n !== marks[i - 1].n + 1) return null;
  }
  const preamble = lines.slice(0, marks[0].line).join('\n').trim();
  const prompts = marks.map((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].line : lines.length;
    const body = lines.slice(mark.line, end).join('\n').replace(NUMBER_RE, '');
    return makePrompt(i, titleFrom(body, null), body);
  });
  return { preamble, prompts, strategy: 'numbered' };
}

// Returns { preamble, prompts: [{id, title, prompt}], strategy }.
// Throws if the file is effectively empty.
function parsePrompts(content) {
  const text = normalizeNewlines(content).trim();
  if (!text) throw new Error('The file is empty — nothing to import.');
  const lines = text.split('\n');

  const result = splitByHeadings(lines) || splitBySeparators(lines) || splitByNumbers(lines) || {
    preamble: '',
    prompts: [makePrompt(0, titleFrom(text, 'Prompt 1'), text)],
    strategy: 'single',
  };

  result.prompts = result.prompts.filter((p) => p.prompt.length > 0);
  if (!result.prompts.length) {
    throw new Error('No prompts found — every section came out empty.');
  }
  // Reindex after dropping empties so ids stay prompt-1..n.
  result.prompts = result.prompts.map((p, i) => ({ ...p, id: `prompt-${i + 1}`, title: p.title || `Prompt ${i + 1}` }));
  return result;
}

module.exports = { parsePrompts };
