'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function git(projectPath, args, opts = {}) {
  return execFileSync('git', ['-C', projectPath, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // `git add -A`/`status --porcelain` on a big generated project can exceed
    // Node's 1 MB default and would kill the child with ENOBUFS mid-run.
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  }).trim();
}

function normalize(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// True only if projectPath is itself the top level of a git repo — being inside
// a parent repo (e.g. target-project/ nested in the runner's own repo) does not
// count, otherwise phase commits would land in the wrong repository.
function isOwnGitRepo(projectPath) {
  try {
    const top = git(projectPath, ['rev-parse', '--show-toplevel']);
    return normalize(top) === normalize(projectPath);
  } catch {
    return false;
  }
}

function ensureGitRepo(projectPath, logger) {
  if (!isOwnGitRepo(projectPath)) {
    git(projectPath, ['init', '-b', 'main']);
    if (logger) logger.log(`Initialized new git repository in ${projectPath}`);
  }
  // A previous force-kill (dashboard Kill, Claude timeout) can strand a git
  // index.lock and every later commit would die on it. At runner startup the
  // single-instance .runner.lock guarantees no runner-spawned git is alive;
  // the age guard protects a human's genuinely concurrent git operation.
  const indexLock = path.join(projectPath, '.git', 'index.lock');
  try {
    if (Date.now() - fs.statSync(indexLock).mtimeMs > 10000) fs.rmSync(indexLock, { force: true });
  } catch { /* no lock */ }
  // Commits fail without an identity; set a repo-local fallback if none exists.
  for (const [key, value] of [
    ['user.email', 'runner@prompt-chain.local'],
    ['user.name', 'Prompt Chain Runner'],
  ]) {
    try {
      git(projectPath, ['config', key]);
    } catch {
      git(projectPath, ['config', key, value]);
    }
  }
  // An unattended run must never hang on a GPG passphrase prompt; auto-commits
  // in the target repo are unsigned (repo-local setting only).
  git(projectPath, ['config', 'commit.gpgsign', 'false']);

  // .pcr/ is the agents' message-passing mailbox — never part of the site.
  // .git/info/exclude is the mechanical guard (agents never touch .git
  // internals, unlike .gitignore which a scaffolder may overwrite); the
  // .gitignore entry is kept as well so clones of the pushed repo behave.
  try {
    const exclude = path.join(projectPath, '.git', 'info', 'exclude');
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    let ex = '';
    try { ex = fs.readFileSync(exclude, 'utf8'); } catch { /* new repo */ }
    if (!/^\.pcr\/?\s*$/m.test(ex)) {
      fs.writeFileSync(exclude, ex + (ex && !ex.endsWith('\n') ? '\n' : '') + '.pcr/\n');
    }
  } catch { /* commitPhase's git rm --cached still protects the commits */ }
  const gi = path.join(projectPath, '.gitignore');
  let current = '';
  try { current = fs.readFileSync(gi, 'utf8'); } catch { /* new repo */ }
  if (!/^\.pcr\/?\s*$/m.test(current)) {
    try { fs.writeFileSync(gi, current + (current && !current.endsWith('\n') ? '\n' : '') + '.pcr/\n'); } catch { /* ignore */ }
  }
}

function commitPhase(projectPath, phaseId, message) {
  git(projectPath, ['add', '-A']);
  // Even if a builder clobbered .gitignore and got the mailbox staged or
  // tracked, it is untracked again before every commit — mechanically.
  git(projectPath, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '.pcr']);
  const dirty = git(projectPath, ['status', '--porcelain']);
  const args = ['commit', '-m', message || `auto: ${phaseId} passed verification`];
  // A phase can legitimately produce no diff (e.g. a pure-verification phase);
  // still record it in history so the audit trail stays one-commit-per-phase.
  if (!dirty) args.push('--allow-empty');
  git(projectPath, args);
  return git(projectPath, ['rev-parse', 'HEAD']);
}

module.exports = { git, isOwnGitRepo, ensureGitRepo, commitPhase };
