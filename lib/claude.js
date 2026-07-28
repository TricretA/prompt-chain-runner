'use strict';
const { spawn, spawnSync } = require('child_process');
const { buildCommandLine } = require('./util');

// Kills a process and everything it spawned. With shell:true the pid is the
// shell's, so on Windows we need /T to take the real claude process down too.
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch { /* already gone */ }
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
function runClaudeCode({ prompt, cwd, config }) {
  const base = Array.isArray(config.claude_command)
    ? config.claude_command
    : [config.claude_command || 'claude'];
  const [cmd, ...preArgs] = base;
  const args = [
    ...preArgs,
    '-p',
    '--output-format', 'json',
    '--dangerously-skip-permissions',
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

    const child = spawn(commandLine, [], { cwd, shell: true, windowsHide: true });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, durationMs: Date.now() - started });
    };

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

module.exports = { runClaudeCode, parseJsonOutput, killTree };
