'use strict';
const { spawn } = require('child_process');
const { truncate, formatDuration } = require('./util');
const { killTree } = require('./claude');
const { detectChecks } = require('./autocheck');

const OUTPUT_MEMORY_CAP = 8 * 1024 * 1024; // keep the tail; errors live at the end

// One verification command, run to completion or killed (whole tree) on timeout.
function runStep(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, [], {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: 'true' },
    });
    let output = '';
    let timedOut = false;
    const add = (d) => {
      output += d;
      if (output.length > OUTPUT_MEMORY_CAP) output = output.slice(-OUTPUT_MEMORY_CAP);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', add);
    child.stderr.on('data', add);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        status: null,
        output: output + `\n[runner] failed to run command: ${err.message}`,
        duration_ms: Date.now() - started,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        status: timedOut ? null : code,
        output: output + (timedOut ? `\n[runner] step timed out after ${timeoutMs} ms and was killed` : ''),
        duration_ms: Date.now() - started,
      });
    });
  });
}

// Runs every verification step as a real shell command in the target project
// and trusts nothing but exit codes. A phase passes only if every step exits 0.
// Steps come from config.verification_steps when explicitly set; otherwise
// they are auto-detected from what the project actually is right now (nobody
// configures verification by hand — see lib/autocheck.js).
// shouldStop() is consulted between steps so a graceful stop never has to wait
// for the whole gate; when it fires, { aborted: true } is returned.
async function verifyPhase(projectPath, config, logger, phaseId, shouldStop) {
  const steps = Array.isArray(config.verification_steps) && config.verification_steps.length
    ? config.verification_steps
    : detectChecks(projectPath);
  const results = {};
  let allPassed = true;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (i > 0 && shouldStop && shouldStop()) {
      if (logger) logger.log(`  verify: stop requested — skipping remaining steps (${steps.slice(i).map((s) => s.name).join(', ')})`);
      return { allPassed: false, results, aborted: true };
    }

    if (logger) logger.event('verify_step_start', { phase: phaseId, step: step.name, command: step.command });
    const proc = await runStep(
      step.command,
      projectPath,
      step.timeout_ms || config.verify_timeout_ms || 10 * 60 * 1000
    );

    const passed = proc.status === 0;
    const entry = {
      passed,
      exit_code: proc.status,
      duration_ms: proc.duration_ms,
      output: truncate(proc.output, config.output_capture_limit || 20000),
    };
    results[step.name] = entry;

    if (logger) {
      logger.log(`  verify [${step.name}] ${passed ? 'PASSED' : `FAILED (exit ${proc.status})`} in ${formatDuration(entry.duration_ms)}`);
      if (!passed) logger.block(`  output of failed step "${step.name}":`, entry.output);
      logger.event('verify_step', {
        phase: phaseId,
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

  return { allPassed, results, aborted: false };
}

module.exports = { verifyPhase };
