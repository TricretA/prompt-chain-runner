'use strict';
// The agent company. Every agent is an unattended Claude Code session with a
// role preamble; they talk to the Orchestrator (runner.js) through JSON files
// in <project>/.pcr/ — written by the agent, read and then deleted by the
// orchestrator so a stale file can never impersonate a fresh answer.
//
//   Planner   — turns a one-line brief into the whole prompt chain  .pcr/plan.json
//   Builder   — does the work for one prompt                        .pcr/report.json
//   Tester    — verifies the builder's claims                       .pcr/verdict.json
//   Debugger  — read-only root-cause analysis when fixes stall      .pcr/diagnosis.json
//   Designer  — looks at real screenshots and fixes what's ugly     .pcr/design.json
//   Security  — pre-deploy secret/vulnerability gate                .pcr/security.json
//   Deployer  — ships to GitHub Pages / Vercel / Netlify            .pcr/deploy.json

const fs = require('fs');
const path = require('path');
const { runClaudeCode } = require('./claude');
const { truncate, busySleep } = require('./util');

const PCR_DIR = '.pcr';
const FILES = {
  plan: path.join(PCR_DIR, 'plan.json'),
  report: path.join(PCR_DIR, 'report.json'),
  verdict: path.join(PCR_DIR, 'verdict.json'),
  diagnosis: path.join(PCR_DIR, 'diagnosis.json'),
  design: path.join(PCR_DIR, 'design.json'),
  security: path.join(PCR_DIR, 'security.json'),
  deploy: path.join(PCR_DIR, 'deploy.json'),
};

const rel = (kind) => FILES[kind].replace(/\\/g, '/');

// The one sentence both the initial builder prompt and every fix prompt use,
// so a fresh fix session always knows the exact report schema.
const REPORT_INSTRUCTION = `write ${rel('report')} (create the .pcr folder if needed) containing exactly one JSON object:
  {"summary": "<what you did>", "files_changed": ["..."], "how_to_verify": "<the quickest way for the tester to confirm this works>"}`;

function ensurePcrDir(projectPath) {
  fs.mkdirSync(path.join(projectPath, PCR_DIR), { recursive: true });
}

// The anti-forgery invariant: the previous answer file is GONE before the next
// agent runs. OneDrive/AV can hold transient locks, so removal is retried; if
// the file still exists afterwards, throw — running the agent anyway would let
// a stale (or builder-forged) file impersonate a fresh answer.
function clearAgentFile(projectPath, kind) {
  const file = path.join(projectPath, FILES[kind]);
  try {
    // recursive:true makes Node honor maxRetries/retryDelay (harmless on files)
    fs.rmSync(file, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
  } catch { /* checked below */ }
  if (fs.existsSync(file)) {
    throw new Error(`Could not clear ${FILES[kind]} (transient file lock?) — refusing to run the agent against a stale answer file.`);
  }
}

function readAgentFile(projectPath, kind) {
  const file = path.join(projectPath, FILES[kind]);
  // A transient OneDrive/AV lock right after the agent's process tree exits is
  // the peak lock window — never convert a real verdict into "missing".
  for (let attempt = 0; ; attempt++) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT' || err instanceof SyntaxError || attempt >= 3) return null;
      busySleep(100 * (attempt + 1));
    }
  }
}

function contextBlock(context) {
  return context && context.trim()
    ? `\nProject context (applies to the whole build):\n${context.trim()}\n`
    : '';
}

// Agents are told exactly which tools this machine has and which accounts are
// logged in, so they never burn a turn discovering it — or invent a platform
// they cannot actually reach.
function capabilitiesBlock(capabilities) {
  return capabilities && capabilities.trim()
    ? `\nWhat this machine has, already checked for you — trust these lines and don't re-probe. Anything listed as not installed or not logged in is genuinely unavailable, so plan around it rather than trying to use it:\n${capabilities.trim()}\n`
    : '';
}

function stateBlock(projectState) {
  return projectState && projectState.trim()
    ? `\nWhat already exists in this project (built by earlier steps — build ON this, don't reinvent it):\n${projectState.trim()}\n`
    : '';
}

// A generic runner: clear the answer file, run the session, read the answer.
async function runAgent({ projectPath, config, onSpawn, prompt, kind, timeoutMs }) {
  ensurePcrDir(projectPath);
  clearAgentFile(projectPath, kind);
  const agentConfig = timeoutMs ? { ...config, claude_timeout_ms: timeoutMs } : config;
  const res = await runClaudeCode({ prompt, cwd: projectPath, config: agentConfig, onSpawn });
  res.answer = readAgentFile(projectPath, kind);
  return res;
}

// --- Planner ---------------------------------------------------------------

function plannerPrompt({ brief, projectName, capabilities }) {
  return `You are the PLANNER agent — the architect of a fully automated build pipeline. A human gave one short brief and will not be available again. Turn it into a complete, ordered build plan that other agents will execute unattended.
${capabilitiesBlock(capabilities)}
Project name: ${projectName}
The brief:
${brief}

Think it through first:
- Decide the stack. Prefer the SIMPLEST thing that fully satisfies the brief — a static HTML/CSS/JS site beats a framework unless the brief truly needs one. Only choose a backend/database if the brief requires persistence or auth, and only pick one that the tools listed above can actually deploy.
- Decide the file layout and the visual direction (palette, typography, mood) ONCE, here, so every later step stays consistent.
- Break the work into 3-8 sequential steps. Step 1 must scaffold something that already runs. Each later step must build on the previous ones and be independently verifiable by a QA agent. Never split one feature across two steps.
- Write each step's prompt as a precise brief a competent developer could execute alone: what to build, where it goes, what "done" means. Include concrete details (section names, behaviors, states) — never vague instructions like "make it nice".

Then write ${rel('plan')} (create the .pcr folder if needed) containing exactly one JSON object:
{
  "project_name": "${projectName}",
  "stack": "<one line: the stack and why>",
  "deploy_target": "github-pages" | "vercel" | "netlify",
  "context": "<the shared brief every step needs: purpose, audience, stack, file layout, visual direction. This text is prepended to EVERY step, so make it complete but tight — under 250 words.>",
  "prompts": [
    {"title": "<short step title>", "prompt": "<the full precise brief for this step>"}
  ]
}
Output nothing else — the plan file is your entire deliverable.`;
}

function runPlanner({ projectPath, config, onSpawn, brief, projectName, capabilities }) {
  return runAgent({
    projectPath, config, onSpawn, kind: 'plan',
    prompt: plannerPrompt({ brief, projectName, capabilities }),
    timeoutMs: config.planner_timeout_ms || 15 * 60 * 1000,
  });
}

// A plan is only usable if it actually contains ordered, non-empty prompts.
function normalizePlan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const prompts = Array.isArray(raw.prompts) ? raw.prompts : [];
  const cleaned = prompts
    .map((p) => ({
      title: String(p?.title ?? '').trim(),
      prompt: String(p?.prompt ?? '').trim(),
    }))
    .filter((p) => p.prompt);
  if (!cleaned.length) return null;
  return {
    project_name: String(raw.project_name ?? '').trim() || null,
    stack: String(raw.stack ?? '').trim(),
    deploy_target: String(raw.deploy_target ?? '').trim() || 'auto',
    context: String(raw.context ?? '').trim(),
    prompts: cleaned.map((p, i) => ({ title: p.title || `Step ${i + 1}`, prompt: p.prompt })),
  };
}

// --- Builder ---------------------------------------------------------------

function builderPrompt({ phase, index, total, context, prompt, capabilities, projectState }) {
  return `You are the BUILDER agent in a fully automated pipeline. No human is watching; never ask questions — pick sensible defaults and finish the job.
${contextBlock(context)}${stateBlock(projectState)}${capabilitiesBlock(capabilities)}
Your task (${phase} — step ${index + 1} of ${total}):
${prompt}

Ground rules:
- Work only inside the current directory (the project root).
- Keep a proper .gitignore (node_modules, build output, .pcr/). Do NOT run git commit/push — the orchestrator owns git.
- A TESTER agent will verify your work right after you finish, so make sure what you claim actually runs.
- When the task is complete, ${REPORT_INSTRUCTION}`;
}

async function runBuilder({ projectPath, config, onSpawn, phase, index, total, context, prompt, capabilities, projectState }) {
  const res = await runAgent({
    projectPath, config, onSpawn, kind: 'report',
    prompt: builderPrompt({ phase, index, total, context, prompt, capabilities, projectState }),
  });
  res.report = res.answer;
  return res;
}

// A fix round reuses the builder role with the failure evidence inlined.
async function runBuilderFix({ projectPath, config, onSpawn, fixPrompt }) {
  const res = await runAgent({ projectPath, config, onSpawn, kind: 'report', prompt: fixPrompt });
  res.report = res.answer;
  return res;
}

// --- Tester ----------------------------------------------------------------

function testerPrompt({ phase, context, prompt, report, builderResult, autoSummary, capabilities, regression }) {
  const reportText = report
    ? JSON.stringify(report, null, 2)
    : `(builder wrote no report file; its final message was)\n${truncate(builderResult || '(empty)', 3000)}`;
  const regressionBlock = regression && regression.length
    ? `\nAlso re-check these acceptance criteria from EARLIER steps — later work must not have broken them:\n${regression.map((r, i) => `  ${i + 1}. ${r}`).join('\n')}\nIf any of them is now broken, that IS a failure of this step.\n`
    : '';
  return `You are the TESTER (QA) agent in a fully automated pipeline. The BUILDER agent claims it finished a task. Verify that claim quickly and skeptically — trust nothing you have not seen run.
${contextBlock(context)}${capabilitiesBlock(capabilities)}
The task the builder was given (${phase}):
${prompt}

The builder's report:
${reportText}

Automated checks the orchestrator already ran (exit codes only, they passed):
${autoSummary}
${regressionBlock}
Do this, fast:
1. Inspect what actually changed in the project.
2. Run the quickest checks that prove or disprove the claim (start the app and curl it, drive it in a real browser, run a focused test — whatever fits this project). Time-box yourself; this is a smoke test, not an audit.
3. Judge this task's scope plus any earlier criteria listed above. Missing features from FUTURE steps are not failures.

Hard rules:
- Do NOT fix or change any project file. Read and run only. The orchestrator compares the working tree before and after you, and a modified tree voids your verdict.
- Put every artifact you produce (screenshots, logs, scratch scripts) inside .pcr/ — that folder is excluded from the comparison. Files you leave anywhere else count as modifying the project.
- Your one and only write: ${rel('verdict')} containing exactly one JSON object:
  {"pass": true|false, "summary": "<one line>", "failures": [{"what": "...", "evidence": "<exact error/output you saw>", "suggested_fix": "..."}], "criteria": ["<short, checkable statements of what now works — these are re-tested after every later step>"]}
- "criteria" must be concrete and re-testable (e.g. "clicking a gallery image opens the lightbox and Escape closes it"), 1-4 items, only for things you personally verified.
- An empty or missing verdict file counts as FAIL, so always write it.`;
}

async function runTester({ projectPath, config, onSpawn, phase, context, prompt, report, builderResult, autoSummary, capabilities, regression }) {
  const res = await runAgent({
    projectPath, config, onSpawn, kind: 'verdict',
    prompt: testerPrompt({ phase, context, prompt, report, builderResult, autoSummary, capabilities, regression }),
    timeoutMs: config.tester_timeout_ms || Math.min(config.claude_timeout_ms || 3600000, 20 * 60 * 1000),
  });
  res.verdict = normalizeVerdict(res.answer, res);
  return res;
}

// Whatever happened, the orchestrator always gets a well-formed verdict.
function normalizeVerdict(raw, res) {
  if (!res.ok) {
    return { pass: false, summary: `Tester agent call failed: ${res.error}`, failures: [{ what: 'tester crashed', evidence: String(res.error || ''), suggested_fix: '' }], criteria: [], source: 'tester_error' };
  }
  if (!raw || typeof raw !== 'object') {
    return { pass: false, summary: 'Tester wrote no readable verdict file — treated as FAIL.', failures: [{ what: 'missing verdict', evidence: truncate(String(res.parsed?.result ?? ''), 2000), suggested_fix: '' }], criteria: [], source: 'missing' };
  }
  return {
    pass: raw.pass === true,
    summary: typeof raw.summary === 'string' ? raw.summary : '(no summary)',
    failures: Array.isArray(raw.failures) ? raw.failures.filter((f) => f && typeof f === 'object') : [],
    criteria: Array.isArray(raw.criteria)
      ? raw.criteria.map((c) => String(c || '').trim()).filter(Boolean).slice(0, 4)
      : [],
    source: 'verdict_file',
  };
}

// --- Debugger --------------------------------------------------------------
// Reached when ordinary fix rounds stop working. It changes nothing — its whole
// job is to find the real root cause so the next builder round stops guessing.

function debuggerPrompt({ phase, context, prompt, history, capabilities }) {
  return `You are the DEBUGGER agent in a fully automated pipeline. A BUILDER agent has now failed this task several times in a row, each time fixing the symptom and missing the cause. No human is watching.
${contextBlock(context)}${capabilitiesBlock(capabilities)}
The task that keeps failing (${phase}):
${prompt}

Every attempt so far, with what failed each time:
${history}

Your job is DIAGNOSIS ONLY — you are explicitly forbidden from editing project files. Read the code, run things, add temporary instrumentation in a scratch file outside the project if you must, and find out what is ACTUALLY wrong. Ask yourself why each previous fix failed to work; if they all attacked the same layer, the cause is probably in a different one.

Write ${rel('diagnosis')} containing exactly one JSON object:
{
  "root_cause": "<the actual mechanism of the failure, specific and technical>",
  "why_previous_fixes_failed": "<what the earlier attempts misunderstood>",
  "exact_change_needed": "<precisely what to change, in which file, and why that fixes the cause rather than the symptom>",
  "files_to_change": ["..."],
  "confidence": "high" | "medium" | "low"
}`;
}

async function runDebugger({ projectPath, config, onSpawn, phase, context, prompt, history, capabilities }) {
  const res = await runAgent({
    projectPath, config, onSpawn, kind: 'diagnosis',
    prompt: debuggerPrompt({ phase, context, prompt, history, capabilities }),
    timeoutMs: config.debugger_timeout_ms || 20 * 60 * 1000,
  });
  res.diagnosis = res.answer;
  return res;
}

// --- Designer --------------------------------------------------------------
// The only agent that judges with its eyes: it screenshots the running site and
// looks at the images, because "no console errors" says nothing about ugly.

function designerPrompt({ context, capabilities, round, rounds, previousIssues }) {
  const previous = previousIssues && previousIssues.length
    ? `\nIssues you found in the previous round (confirm each one is now genuinely fixed):\n${previousIssues.map((i, n) => `  ${n + 1}. ${i}`).join('\n')}\n`
    : '';
  return `You are the DESIGN agent in a fully automated pipeline — the last line of defense against shipping something that works but looks bad. This is design review round ${round} of ${rounds}. No human is watching; never ask questions.
${contextBlock(context)}${capabilitiesBlock(capabilities)}${previous}
Do this:
1. Serve the site locally and drive it with a real browser (Playwright chromium is already cached on this machine — use it headless).
2. Screenshot every meaningful view at 3 widths: 360px (mobile), 768px (tablet), 1440px (desktop). Save them under .pcr/shots/ .
3. ACTUALLY LOOK at the screenshot images you just saved — open them with the Read tool. Do not skip this; judging the CSS source instead of the rendered pixels is the failure mode this whole role exists to prevent.
4. Judge them the way a demanding designer would:
   - layout: alignment, consistent spacing rhythm, nothing overflowing or colliding, no horizontal scrollbar at 360px
   - hierarchy: is the eye led to the right thing first; are headings/body/captions clearly differentiated
   - typography: sane line lengths (45-80 chars), line height, no orphan words in headings, no text smaller than 14px
   - color and contrast: coherent palette, WCAG AA contrast for all text, no muddy or clashing combinations
   - polish: consistent border radii, purposeful shadows, hover/focus states present, images not distorted or stretched
   - emptiness: no obviously unfinished area, placeholder lorem text, or broken image
5. FIX every issue you find, directly in the project files. Keep the existing structure and content — you are improving presentation, not rewriting the site or inventing new sections.
6. Re-screenshot after your fixes and look again to confirm each issue is actually resolved in the pixels.

Then write ${rel('design')} containing exactly one JSON object:
{
  "score_before": <1-10>,
  "score_after": <1-10>,
  "issues_found": ["<specific issue, with the view and width where you saw it>"],
  "changes_made": ["<what you changed and why>"],
  "remaining_issues": ["<anything you could not fix, or [] >"],
  "verified_in_pixels": true|false
}
Set verified_in_pixels true only if you personally viewed the after-screenshots.`;
}

async function runDesigner({ projectPath, config, onSpawn, context, capabilities, round, rounds, previousIssues }) {
  const res = await runAgent({
    projectPath, config, onSpawn, kind: 'design',
    prompt: designerPrompt({ context, capabilities, round, rounds, previousIssues }),
    timeoutMs: config.design_timeout_ms || 30 * 60 * 1000,
  });
  res.design = res.answer;
  return res;
}

// --- Security --------------------------------------------------------------

function securityPrompt({ context, capabilities, target }) {
  return `You are the SECURITY agent in a fully automated pipeline. The project in the current directory is finished and about to be published PUBLICLY (${target}). You are the last check before it goes out. No human is watching.
${contextBlock(context)}${capabilitiesBlock(capabilities)}
Audit for things that must never ship. Be concrete and fast — this is a release gate, not a full penetration test:
1. Secrets: API keys, tokens, passwords, private keys, .env files, service-account JSON — in the working tree AND in git history (check "git log -p" for anything added then deleted, since deleting a secret from a file does not remove it from history).
2. Accidental exposure: internal URLs, personal data, database credentials in client-side code, private endpoints, source maps revealing server code.
3. Obvious web vulnerabilities in code that will run in a browser: injecting untrusted input via innerHTML/eval, forms posting to third parties, dependencies with known critical advisories (npm audit if this is an npm project).
4. Deployment misconfiguration: files that should not be published (backups, .git artifacts inside the build output, admin pages, TODO/debug pages).

Do NOT change project files unless you are removing a genuine secret — that is the one repair you are allowed to make, and if you make it, say so explicitly in "changes_made".

Write ${rel('security')} containing exactly one JSON object:
{
  "pass": true|false,
  "summary": "<one line>",
  "critical": [{"what": "...", "where": "<file:line or 'git history'>", "fix": "..."}],
  "warnings": [{"what": "...", "where": "...", "fix": "..."}],
  "changes_made": ["<any secret you removed, or [] >"]
}
"pass" is false ONLY if something in "critical" would genuinely harm the owner once public. Style issues, missing security headers on a static site, and theoretical risks are warnings, not critical.`;
}

async function runSecurity({ projectPath, config, onSpawn, context, capabilities, target }) {
  const res = await runAgent({
    projectPath, config, onSpawn, kind: 'security',
    prompt: securityPrompt({ context, capabilities, target }),
    timeoutMs: config.security_timeout_ms || 15 * 60 * 1000,
  });
  res.security = res.answer;
  return res;
}

// --- Deployer --------------------------------------------------------------

// Per-platform instructions. Every path ends at the same contract: a public URL
// the orchestrator can verify itself.
const DEPLOY_TARGETS = {
  'github-pages': ({ repoName, visibility }) => `Publish to GitHub Pages using the authenticated gh CLI.
1. Create the GitHub repository "${repoName}" (visibility: ${visibility}) if it does not exist, set it as remote "origin" (replacing origin if it points elsewhere), and push main.
2. Enable Pages with the right mechanism for this project: deploy-from-branch for a plain static site, or a GitHub Actions workflow that builds and uploads the artifact when there is a build step. Commit and push whatever config that needs.
3. IMPORTANT: a project served from https://<user>.github.io/${repoName}/ lives under a sub-path. Make sure every asset, link, and router base path still resolves there (this is the single most common way a Pages deploy returns 200 for the page while every stylesheet 404s). If the framework needs a base/basePath setting, set it.
4. Wait for the deployment to finish (gh run watch / gh run list), then fetch the public URL.`,

  vercel: ({ projectName }) => `Publish to Vercel. The Vercel CLI is authenticated on this machine, and a Vercel MCP server is also connected to this session — use whichever is more reliable, the CLI is usually fastest.
1. From the project directory, deploy to production: "vercel --prod --yes" (add "--name ${projectName}" on first deploy if the CLI asks for a project name). Let the CLI auto-detect the framework; for a plain static site the repo root is the output directory.
2. If the CLI asks anything interactive, re-run with the flags that answer it — never leave a prompt hanging.
3. Capture the production URL the CLI prints (the https://*.vercel.app one).
4. Also push the source to GitHub with the gh CLI if it is authenticated, so the project has a repository too — but the Vercel URL is the live site.`,

  netlify: ({ projectName }) => `Publish to Netlify using the CLI (available via "npx netlify-cli" if not installed globally).
1. Deploy to production non-interactively: "npx netlify-cli deploy --prod --dir <output-dir> --site ${projectName}" — create the site first with "npx netlify-cli sites:create --name ${projectName}" if it does not exist. For a plain static site the output dir is the project root; for a build step, run the build first and point --dir at its output.
2. If authentication is missing, report that clearly in the deploy file instead of hanging on a browser login prompt.
3. Capture the production URL.
4. Also push the source to GitHub with the gh CLI if it is authenticated.`,
};

function deployerPrompt({ projectName, repoName, visibility, context, capabilities, target }) {
  const steps = (DEPLOY_TARGETS[target] || DEPLOY_TARGETS['github-pages'])({ projectName, repoName, visibility });
  return `You are the DEPLOYER agent in a fully automated pipeline. The project in the current directory is finished, verified, and committed on branch main. Put it live. No human is watching; never ask questions and never start an interactive login flow — if a credential is genuinely missing, say so in your report instead of hanging.
${contextBlock(context)}${capabilitiesBlock(capabilities)}
Deployment target: ${target}

${steps}

Finally, verify it yourself before reporting success: fetch the public URL and confirm it returns HTTP 200 with the real site, AND that the page's own CSS/JS assets load (a 200 on the HTML while assets 404 is a broken deploy, not a live one).

Then write ${rel('deploy')} containing exactly one JSON object:
{"target": "${target}", "repo_url": "https://github.com/... or null", "pages_url": "https://...", "live": true|false, "notes": "<what you set up / anything a human should know>"}
Set "live" to true only if you saw the URL serve the working site yourself.
Project name for titles and descriptions: ${projectName}`;
}

async function runDeployer({ projectPath, config, onSpawn, projectName, repoName, visibility, context, capabilities, target, fixPrompt }) {
  const res = await runAgent({
    projectPath, config, onSpawn, kind: 'deploy',
    prompt: fixPrompt || deployerPrompt({ projectName, repoName, visibility, context, capabilities, target }),
  });
  res.deploy = res.answer;
  return res;
}

module.exports = {
  runPlanner,
  runBuilder,
  runBuilderFix,
  runTester,
  runDebugger,
  runDesigner,
  runSecurity,
  runDeployer,
  plannerPrompt,
  builderPrompt,
  testerPrompt,
  debuggerPrompt,
  designerPrompt,
  securityPrompt,
  deployerPrompt,
  normalizePlan,
  readAgentFile,
  capabilitiesBlock,
  REPORT_INSTRUCTION,
  DEPLOY_TARGETS,
  PCR_DIR,
};
