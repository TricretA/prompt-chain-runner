'use strict';
const { spawnSync } = require('child_process');
const { truncate, formatDuration } = require('./util');

// Runs every verification step as a real shell command in the target project
// and trusts nothing but exit codes. A phase passes only if every step exits 0.
function verifyPhase(projectPath, config, logger) {
  const steps = config.verification_steps || [];
  const results = {};
  let allPassed = true;

  for (const step of steps) {
    const started = Date.now();
    if (logger) logger.event('verify_step_start', { step: step.name, command: step.command });

    const proc = spawnSync(step.command, [], {
      cwd: projectPath,
      shell: true,
      windowsHide: true,
      encoding: 'utf8',
      timeout: step.timeout_ms || config.verify_timeout_ms || 10 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: 'true' },
    });

    let output = `${proc.stdout || ''}${proc.stderr || ''}`;
    if (proc.error) {
      output += `\n[runner] failed to run command: ${proc.error.message}`;
      if (proc.error.code === 'ETIMEDOUT') output += ' (step timed out)';
    }
    const passed = proc.status === 0 && !proc.error;
    const entry = {
      passed,
      exit_code: proc.status,
      duration_ms: Date.now() - started,
      output: truncate(output, config.output_capture_limit || 20000),
    };
    results[step.name] = entry;

    if (logger) {
      logger.log(`  verify [${step.name}] ${passed ? 'PASSED' : `FAILED (exit ${proc.status})`} in ${formatDuration(entry.duration_ms)}`);
      if (!passed) logger.block(`  output of failed step "${step.name}":`, entry.output);
      logger.event('verify_step', {
        step: step.name,
        command: step.command,
        passed,
        exit_code: proc.status,
        duration_ms: entry.duration_ms,
        output: passed ? '' : entry.output,
      });
    }

    if (!passed) {
      allPassed = false;
      if (config.stop_on_first_failure) break;
    }
  }

  return { allPassed, results };
}

module.exports = { verifyPhase };
