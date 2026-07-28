'use strict';
const fs = require('fs');
const path = require('path');
const { nowIso } = require('./util');

// Writes two files per run:
//   logs/run-<stamp>.log           human-readable transcript (single source of truth)
//   logs/run-<stamp>.events.jsonl  structured events the dashboard renders live
class Logger {
  constructor(logsDir, runId) {
    fs.mkdirSync(logsDir, { recursive: true });
    this.runId = runId;
    this.logFile = path.join(logsDir, `${runId}.log`);
    this.eventsFile = path.join(logsDir, `${runId}.events.jsonl`);
  }

  log(message) {
    const line = `[${nowIso()}] ${message}`;
    try { fs.appendFileSync(this.logFile, line + '\n', 'utf8'); } catch { /* keep running even if disk write fails */ }
    console.log(line);
  }

  section(title) {
    this.log('='.repeat(64));
    this.log(title);
    this.log('='.repeat(64));
  }

  // Verbatim block (command output, prompts) — indented so it reads as a quote.
  block(label, text) {
    const body = String(text ?? '').split(/\r?\n/).map((l) => '    ' + l).join('\n');
    try {
      fs.appendFileSync(this.logFile, `[${nowIso()}] ${label}\n${body}\n`, 'utf8');
    } catch { /* ignore */ }
  }

  event(type, data = {}) {
    try {
      fs.appendFileSync(this.eventsFile, JSON.stringify({ ts: nowIso(), type, ...data }) + '\n', 'utf8');
    } catch { /* ignore */ }
  }
}

module.exports = { Logger };
