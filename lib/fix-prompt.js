'use strict';
const { truncate } = require('./util');
const { REPORT_INSTRUCTION } = require('./agents');

// Turns real failure evidence — failed auto-check output and/or the Tester
// agent's verdict — into the next BUILDER prompt for the same phase. Only
// failures are included, each capped so one noisy step can't drown the rest.
function evidenceSections(autoResults = {}, verdict = null, perStepLimit = 8000) {
  const sections = [];
  for (const [name, r] of Object.entries(autoResults)) {
    if (r.passed) continue;
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
  return sections;
}

// strategy is set by the orchestrator's escalation ladder:
//   'fix'           ordinary retry with the evidence
//   'lessons'       + what fixed this class of failure on previous runs
//   'diagnosis'     + the Debugger agent's root-cause analysis
//   'fresh_start'   the tree was reverted to the last good commit; start over
//                   from the original task and take a DIFFERENT approach
function buildFixPrompt({
  originalPrompt, autoResults = {}, verdict = null, config = {},
  strategy = 'fix', lessons = '', diagnosis = null, attemptHistory = '',
}) {
  const perStepLimit = config.fix_prompt_output_limit || 8000;
  const sections = evidenceSections(autoResults, verdict, perStepLimit);
  const evidence = sections.join('\n\n') || '(no evidence captured — re-examine the task and try again)';

  if (strategy === 'fresh_start') {
    return `You are the BUILDER agent in a fully automated pipeline (no human is watching; never ask questions).

Several attempts at this task have failed, so the project has been REVERTED to the last known-good commit. The broken work is gone — you are starting this task fresh, from a clean tree.

The task:
${originalPrompt}

What was tried before and why each attempt failed — do NOT repeat these approaches:
${attemptHistory || evidence}
${lessons ? `\n${lessons}\n` : ''}
Solve it a DIFFERENT way this time. Choose the simplest, most conventional implementation that satisfies the task; if the earlier attempts were clever, be boring instead. When done, ${REPORT_INSTRUCTION}`;
  }

  const diagnosisBlock = strategy === 'diagnosis' && diagnosis
    ? `\nA DEBUGGER agent investigated the repeated failures and found the root cause. Trust this over your own first instinct — the previous attempts failed precisely because they fixed the symptom:
  root cause: ${truncate(String(diagnosis.root_cause || '(none given)'), 2000)}
  why previous fixes failed: ${truncate(String(diagnosis.why_previous_fixes_failed || '(none given)'), 1500)}
  exact change needed: ${truncate(String(diagnosis.exact_change_needed || '(none given)'), 2000)}
  files to change: ${(diagnosis.files_to_change || []).join(', ') || '(unspecified)'}\n`
    : '';

  return `You are the BUILDER agent in a fully automated pipeline (no human is watching; never ask questions). Your previous attempt at this task failed verification.
Original task: ${originalPrompt}

What failed, with the exact evidence:
${evidence}
${diagnosisBlock}${lessons ? `\n${lessons}\n` : ''}
Fix the project so all checks pass and the tester's objections are resolved. Do not change the scope of the task beyond what these errors require. When done, ${REPORT_INSTRUCTION}`;
}

// The deploy loop's evidence: what the orchestrator saw when it checked the
// deployment itself. Each retry is a fresh session with no memory, so the
// original task is restated in full alongside the evidence.
function buildDeployFixPrompt({ deployInfo, evidence, projectName, repoName, visibility, target }) {
  return `You are the DEPLOYER agent in a fully automated pipeline (no human is watching; never ask questions, never start an interactive login). Your previous deployment attempt did not result in a live site.

The original task, still yours to finish: the project in the current directory ("${projectName || repoName || 'this project'}") is complete and committed on branch main. Publish it to ${target || 'github-pages'}${repoName ? ` under the name "${repoName}"` : ''}${visibility ? ` (visibility: ${visibility})` : ''}, then write .pcr/deploy.json containing exactly one JSON object:
  {"target": "...", "repo_url": "...", "pages_url": "https://...", "live": true|false, "notes": "..."}

What you reported last time:
${deployInfo ? JSON.stringify(deployInfo, null, 2) : '(no .pcr/deploy.json was written — that alone is a failure; always write it)'}

What the orchestrator observed when it verified independently:
${evidence}

Diagnose and fix the deployment. Common causes worth ruling out first: a failed build workflow (gh run list / gh run view --log-failed), Pages not enabled or pointed at the wrong branch (gh api repos/{owner}/{repo}/pages), the wrong publish directory, or a sub-path base-URL problem where the HTML loads but every asset 404s. Then confirm the public URL serves the real working site — including its CSS and JS — and rewrite .pcr/deploy.json with the result.`;
}

// A security gate failure goes back to the builder as a repair job.
function buildSecurityFixPrompt({ security, context }) {
  const items = (security.critical || []).map((c, i) =>
    `${i + 1}. ${c.what}\n   where: ${c.where || '(unspecified)'}\n   fix: ${c.fix || '(use your judgement)'}`).join('\n');
  return `You are the BUILDER agent in a fully automated pipeline (no human is watching; never ask questions). The project is finished but a SECURITY agent blocked its release.
${context ? `\nProject context:\n${context}\n` : ''}
Critical findings that must be fixed before this can be published:
${items || security.summary || '(see summary)'}

Fix every critical finding. If a secret was committed, remove it from the working tree AND purge it from git history (git filter-branch or a fresh orphan branch), then make sure the file is gitignored and, if the secret was ever real, note in your report that it must be rotated. Change nothing else. When done, ${REPORT_INSTRUCTION}`;
}

module.exports = { buildFixPrompt, buildDeployFixPrompt, buildSecurityFixPrompt, evidenceSections };
