#!/usr/bin/env node
'use strict';
// Stand-in for the Claude Code CLI used by the test suite. Speaks the same
// contract: prompt on stdin, JSON result on stdout, nonzero exit on failure.
//
// Behavior is scripted by mock-scenario.json in the working directory
// (the target project):
//   { "calls": [ { "files": { "app.txt": "GOOD" } }, { "crash": true }, ... ] }
// Call N applies calls[N] (clamped to the last entry). Every received prompt
// is appended to mock-prompts.jsonl so tests can assert on fix prompts.

const fs = require('fs');
const path = require('path');

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  const cwd = process.cwd();
  const scenario = JSON.parse(fs.readFileSync(path.join(cwd, 'mock-scenario.json'), 'utf8'));
  const stateFile = path.join(cwd, 'mock-state.json');
  const state = fs.existsSync(stateFile)
    ? JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    : { call: 0 };

  const calls = scenario.calls || [];
  const call = calls[Math.min(state.call, calls.length - 1)] || {};

  fs.appendFileSync(
    path.join(cwd, 'mock-prompts.jsonl'),
    JSON.stringify({ call: state.call, prompt, argv: process.argv.slice(2) }) + '\n'
  );
  state.call += 1;
  fs.writeFileSync(stateFile, JSON.stringify(state));

  for (const [rel, content] of Object.entries(call.files || {})) {
    const abs = path.resolve(cwd, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  if (call.crash) {
    console.error('mock claude: simulated crash');
    process.exit(1);
  }

  console.log(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: call.result || `mock done (call ${state.call - 1})`,
    total_cost_usd: 0.01,
    num_turns: 1,
    duration_ms: 5,
  }));
});
