'use strict';
const { spawn, spawnSync } = require('child_process');
const { buildCommandLine } = require('./util');

// The in-flight Claude Code child, so signal handlers can take it down instead
// of orphaning an agent that keeps editing the project after the runner dies.
let activeChild = null;

// Kills a process and everything it spawned. With shell:true the pid is the
// shell's: on Windows taskkill /T walks the tree; on POSIX our children are
// spawned detached (own process group) so the negative-pid group kill works.
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
    }
  } catch { /* already gone */ }
}

function getActiveClaudePid() {
  return activeChild ? activeChild.pid : null;
}

function killActiveClaude() {
  if (activeChild) killTree(activeChild.pid);
}

// The CLI prints one JSON object with --output-format json, but be tolerant of
// stray warnings around it: try whole-output first, then the outermost braces.
function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fall through */ }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch { /* fall through */ }
  }
  return null;
}

// The single connection to Claude Code. Non-interactive, no permission prompts,
// structured output. The prompt travels over stdin so no shell-quoting rules
// ever touch it. Rides on the machine's existing Claude Code login.
//
// model/fallbackModel are per-invocation only (the CLI does not persist
// --model between calls), which is exactly what per-role cost control needs:
// the caller (lib/agents.js) resolves which model each agent role should use
// and passes it in fresh on every call.
function runClaudeCode({ prompt, cwd, config, onSpawn, model, fallbackModel }) {
  const base = Array.isArray(config.claude_command)
    ? config.claude_command
    : [config.claude_command || 'claude'];
  const [cmd, ...preArgs] = base;
  const args = [
    ...preArgs,
    '-p',
    '--output-format', 'json',
    '--dangerously-skip-permissions',
    ...(model ? ['--model', model] : []),
    ...(fallbackModel ? ['--fallback-model', fallbackModel] : []),
    ...(config.claude_args || []),
  ];
  const commandLine = buildCommandLine(cmd, args);
  const timeoutMs = config.claude_timeout_ms || 60 * 60 * 1000;

  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(commandLine, [], {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    activeChild = child;
    if (onSpawn) { try { onSpawn(child.pid); } catch { /* ignore */ } }

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = null;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, durationMs: Date.now() - started });
    };

    // setEncoding keeps multi-byte UTF-8 sequences intact across chunk
    // boundaries; naive Buffer-per-chunk coercion would mangle them.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      finish({ ok: false, error: `Failed to launch Claude Code (${commandLine}): ${err.message}` });
    });

    child.on('close', (code) => {
      const parsed = parseJsonOutput(stdout);
      if (timedOut) {
        return finish({ ok: false, code, parsed, error: `Claude Code timed out after ${timeoutMs} ms and was killed.` });
      }
      if (code !== 0) {
        const detail = (stderr || stdout || '').trim().slice(0, 2000);
        return finish({ ok: false, code, parsed, error: `Claude Code exited with code ${code}.${detail ? `\n${detail}` : ''}` });
      }
      if (parsed && parsed.is_error) {
        return finish({ ok: false, code, parsed, error: `Claude Code reported an error: ${String(parsed.result || '').slice(0, 2000)}` });
      }
      finish({ ok: true, code, parsed });
    });

    // Child may exit before reading all of stdin; don't let EPIPE crash the runner.
    child.stdin.on('error', () => {});
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

module.exports = { runClaudeCode, parseJsonOutput, killTree, killActiveClaude, getActiveClaudePid };
