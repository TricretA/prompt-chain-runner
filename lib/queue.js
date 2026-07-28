'use strict';
const { readJson, atomicWriteJson } = require('./util');

const VALID_STATUSES = ['pending', 'running', 'passed', 'failed_retry', 'stuck'];

function loadQueue(queueFile) {
  let queue;
  try {
    queue = readJson(queueFile);
  } catch (err) {
    throw new Error(`Could not read queue file ${queueFile}: ${err.message}`);
  }
  if (!queue || typeof queue !== 'object' || Array.isArray(queue)) {
    throw new Error(`Queue file ${queueFile} must contain a JSON object.`);
  }
  if (typeof queue.project_path !== 'string' || !queue.project_path.trim()) {
    throw new Error('queue.project_path must be a non-empty string.');
  }
  if (!Array.isArray(queue.phases) || queue.phases.length === 0) {
    throw new Error('queue.phases must be a non-empty array of phases.');
  }
  const seen = new Set();
  for (const phase of queue.phases) {
    if (!phase || typeof phase !== 'object') throw new Error('Every entry in queue.phases must be an object.');
    if (typeof phase.id !== 'string' || !phase.id.trim()) throw new Error('Every phase needs a non-empty string "id".');
    if (seen.has(phase.id)) throw new Error(`Duplicate phase id "${phase.id}".`);
    seen.add(phase.id);
    if (typeof phase.prompt !== 'string' || !phase.prompt.trim()) {
      throw new Error(`Phase "${phase.id}" needs a non-empty string "prompt".`);
    }
    if (phase.status === undefined || phase.status === null) phase.status = 'pending';
    if (!VALID_STATUSES.includes(phase.status)) {
      throw new Error(`Phase "${phase.id}" has invalid status "${phase.status}". Valid: ${VALID_STATUSES.join(', ')}`);
    }
    if (typeof phase.retries !== 'number' || phase.retries < 0) phase.retries = 0;
    if (phase.commit_hash === undefined) phase.commit_hash = null;
  }
  return queue;
}

function saveQueue(queueFile, queue) {
  atomicWriteJson(queueFile, queue);
}

module.exports = { loadQueue, saveQueue, VALID_STATUSES };
