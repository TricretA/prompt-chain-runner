'use strict';
// Auto-detected verification steps — nobody configures verification by hand.
// Looks at what the target project actually is and derives the deterministic
// checks to run after every builder attempt. The Tester agent runs on top of
// these; they exist because exit codes are free and never hallucinate.

const fs = require('fs');
const path = require('path');

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Returns [{ name, command }] for this project as it exists right now.
// Re-detected before every verification pass, because phase 1 usually creates
// the package.json that later phases must be checked against.
function detectChecks(projectPath) {
  const steps = [];
  const pkg = readJsonSafe(path.join(projectPath, 'package.json'));

  if (pkg) {
    steps.push({ name: 'install', command: 'npm install --no-audit --no-fund' });
    const scripts = pkg.scripts || {};
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (scripts.typecheck) steps.push({ name: 'typecheck', command: 'npm run typecheck' });
    else if (fs.existsSync(path.join(projectPath, 'tsconfig.json')) && deps.typescript) {
      steps.push({ name: 'typecheck', command: 'npx --no-install tsc --noEmit' });
    }
    if (scripts.lint) steps.push({ name: 'lint', command: 'npm run lint' });
    if (scripts.build) steps.push({ name: 'build', command: 'npm run build' });
    // CI=true (set by the step runner) makes vitest/jest/CRA run once and exit.
    if (scripts.test && !/no test specified/i.test(String(scripts.test))) {
      steps.push({ name: 'test', command: 'npm test' });
    }
  }
  return steps;
}

function describeChecks(steps) {
  return steps.length ? steps.map((s) => s.name).join(', ') : 'none detected';
}

module.exports = { detectChecks, describeChecks };
