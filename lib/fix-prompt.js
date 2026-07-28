'use strict';
const { truncate } = require('./util');
const { REPORT_INSTRUCTION } = require('./agents');

// Turns real failure evidence — failed auto-check output and/or the Tester
// agent's verdict — into the next BUILDER prompt for the same phase. Only
// failures are included, each capped so one noisy step can't drown the rest.
function buildFixPrompt({ originalPrompt, autoResults = {}, verdict = null, config = {} }) {
  const perStepLimit = config.fix_prompt_output_limit || 8000;
  const sections = [];

  const failedSteps = Object.entries(autoResults).filter(([, r]) => !r.passed);
  for (const [name, r] of failedSteps) {
    const exit = r.exit_code === null || r.exit_code === undefined ? 'killed/timeout' : `exit code ${r.exit_code}`;
    sections.push(`--- automated check "${name}" failed (${exit}) ---\n${truncate(r.output || '(no output captured)', perStepLimit)}`);
  }

  if (verdict && verdict.pass === false) {
    const failures = (verdict.failures || []).map((f, i) => {
      const parts = [`${i + 1}. ${f.what || 'unspecified failure'}`];
      if (f.evidence) parts.push(`   evidence: ${truncate(String(f.evidence), perStepLimit)}`);
      if (f.suggested_fix) parts.push(`   suggested fix: ${truncate(String(f.suggested_fix), 1000)}`);
      return parts.join('\n');
    });
    sections.push(`--- the TESTER agent rejected the work ---\nTester summary: ${verdict.summary || '(none)'}\n${failures.join('\n') || '(no itemized failures)'}`);
  }

  return `You are the BUILDER agent in a fully automated pipeline (no human is watching; never ask questions). Your previous attempt at this task failed verification.
Original task: ${originalPrompt}

What failed, with the exact evidence:
${sections.join('\n\n') || '(no evidence captured — re-examine the task and try again)'}

Fix the project so all checks pass and the tester's objections are resolved. Do not change the scope of the task beyond what these errors require. When done, ${REPORT_INSTRUCTION}`;
}

// The deploy loop's evidence: what the orchestrator saw when it checked the
// deployment itself. Each retry is a fresh session with no memory, so the
// original task is restated in full alongside the evidence.
function buildDeployFixPrompt({ deployInfo, evidence, projectName, repoName, visibility }) {
  return `You are the DEPLOYER agent in a fully automated pipeline (no human is watching; never ask questions). Your previous deployment attempt did not result in a live site.

The original task, still yours to finish: the project in the current directory ("${projectName || repoName || 'this project'}") is complete and committed on branch main. The gh CLI is authenticated. Create/ensure the GitHub repository "${repoName || '(pick a sensible name)'}" (visibility: ${visibility || 'public'}), make it the "origin" remote, push main, and make the site live on GitHub Pages. When the public URL really serves the site, write .pcr/deploy.json containing exactly one JSON object:
  {"repo_url": "https://github.com/...", "pages_url": "https://...", "live": true|false, "notes": "..."}

What you reported last time:
${deployInfo ? JSON.stringify(deployInfo, null, 2) : '(no .pcr/deploy.json was written — that alone is a failure; always write it)'}

What the orchestrator observed when it verified independently:
${evidence}

Diagnose and fix the deployment (check "gh run list" / "gh run view --log-failed" for failed workflow runs, Pages settings via "gh api repos/{owner}/{repo}/pages", branch and publish directory). Then confirm the public URL serves the real site yourself and rewrite .pcr/deploy.json with the result.`;
}

module.exports = { buildFixPrompt, buildDeployFixPrompt };
