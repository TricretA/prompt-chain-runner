'use strict';
const { atomicWriteJson, readJson, nowIso } = require('./util');

// state.json is the dashboard's live view of the current/last run.
// The runner rewrites it after every meaningful step.
function writeState(stateFile, state) {
  atomicWriteJson(stateFile, { ...state, updated_at: nowIso() });
}

function readState(stateFile) {
  try {
    return readJson(stateFile);
  } catch {
    return null;
  }
}

module.exports = { writeState, readState };
