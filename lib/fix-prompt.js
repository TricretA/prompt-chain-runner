'use strict';
const { truncate } = require('./util');

// Turns real verification failures into the next prompt for the same phase.
// Only failed steps are included, each capped so one noisy step can't drown
// out the others.
function buildFixPrompt(originalPrompt, verificationResults, config = {}) {
  const perStepLimit = config.fix_prompt_output_limit || 8000;
  const failures = Object.entries(verificationResults)
    .filter(([, r]) => !r.passed)
    .map(([name, r]) => {
      const exit = r.exit_code === null || r.exit_code === undefined ? 'killed/timeout' : `exit code ${r.exit_code}`;
      return `--- ${name} failed (${exit}) ---\n${truncate(r.output || '(no output captured)', perStepLimit)}`;
    })
    .join('\n\n');

  return `The previous step for this task failed verification.
Original task: ${originalPrompt}

The following checks failed with these exact errors:
${failures}

Fix the code so all checks pass. Do not change the original scope of the task beyond what's needed to fix these errors.`;
}

module.exports = { buildFixPrompt };
