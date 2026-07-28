'use strict';
// The agent company. Every agent is an unattended Claude Code session with a
// role preamble; they talk to the Orchestrator (runner.js) through JSON files
// in <project>/.pcr/ — written by the agent, read and then deleted by the
// orchestrator so a stale file can never impersonate a fresh answer.
//
//   Builder  — does the work for one prompt, reports in  .pcr/report.json
//   Tester   — verifies the builder's claims, verdict in  .pcr/verdict.json
//   Deployer — puts the finished site on GitHub, result in .pcr/deploy.json

const fs = require('fs');
const path = require('path');
const { runClaudeCode } = require('./claude');
const { truncate, busySleep } = require('./util');

const PCR_DIR = '.pcr';
const FILES = {
  report: path.join(PCR_DIR, 'report.json'),
  verdict: path.join(PCR_DIR, 'verdict.json'),
  deploy: path.join(PCR_DIR, 'deploy.json'),
};

// The one sentence both the initial builder prompt and every fix prompt use,
// so a fresh fix session always knows the exact report schema.
const REPORT_INSTRUCTION = `write ${FILES.report.replace(/\\/g, '/')} (create the .pcr folder if needed) containing exactly one JSON object:
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

// --- Builder ---------------------------------------------------------------

function builderPrompt({ phase, index, total, context, prompt }) {
  return `You are the BUILDER agent in a fully automated pipeline. No human is watching; never ask questions — pick sensible defaults and finish the job.
${contextBlock(context)}
Your task (${phase} — step ${index + 1} of ${total}):
${prompt}

Ground rules:
- Work only inside the current directory (the project root).
- Keep a proper .gitignore (node_modules, build output, .pcr/). Do NOT run git commit/push — the orchestrator owns git.
- A TESTER agent will verify your work right after you finish, so make sure what you claim actually runs.
- When the task is complete, ${REPORT_INSTRUCTION}`;
}

async function runBuilder({ projectPath, config, onSpawn, phase, index, total, context, prompt }) {
  ensurePcrDir(projectPath);
  clearAgentFile(projectPath, 'report');
  const res = await runClaudeCode({
    prompt: builderPrompt({ phase, index, total, context, prompt }),
    cwd: projectPath,
    config,
    onSpawn,
  });
  res.report = readAgentFile(projectPath, 'report');
  return res;
}

// A fix round reuses the builder role with the failure evidence inlined.
async function runBuilderFix({ projectPath, config, onSpawn, fixPrompt }) {
  ensurePcrDir(projectPath);
  clearAgentFile(projectPath, 'report');
  const res = await runClaudeCode({ prompt: fixPrompt, cwd: projectPath, config, onSpawn });
  res.report = readAgentFile(projectPath, 'report');
  return res;
}

// --- Tester ----------------------------------------------------------------

function testerPrompt({ phase, context, prompt, report, builderResult, autoSummary }) {
  const reportText = report
    ? JSON.stringify(report, null, 2)
    : `(builder wrote no report file; its final message was)\n${truncate(builderResult || '(empty)', 3000)}`;
  return `You are the TESTER (QA) agent in a fully automated pipeline. The BUILDER agent claims it finished a task. Verify that claim quickly and skeptically — trust nothing you have not seen run.
${contextBlock(context)}
The task the builder was given (${phase}):
${prompt}

The builder's report:
${reportText}

Automated checks the orchestrator already ran (exit codes only, they passed):
${autoSummary}

Do this, fast:
1. Inspect what actually changed in the project.
2. Run the quickest checks that prove or disprove the claim (start the app and curl it, open the built page, run a focused test — whatever fits this project). Time-box yourself; this is a smoke test, not an audit.
3. Judge ONLY this task's scope. Missing features from other steps are not failures.

Hard rules:
- Do NOT fix or change any project file. Read and run only.
- Your one and only write: ${FILES.verdict.replace(/\\/g, '/')} containing exactly one JSON object:
  {"pass": true|false, "summary": "<one line>", "failures": [{"what": "<what is broken>", "evidence": "<exact error/output you saw>", "suggested_fix": "<hint for the builder>"}]}
- An empty or missing verdict file counts as FAIL, so always write it.`;
}

async function runTester({ projectPath, config, onSpawn, phase, context, prompt, report, builderResult, autoSummary }) {
  ensurePcrDir(projectPath);
  clearAgentFile(projectPath, 'verdict');
  const testerConfig = {
    ...config,
    claude_timeout_ms: config.tester_timeout_ms || Math.min(config.claude_timeout_ms || 3600000, 20 * 60 * 1000),
  };
  const res = await runClaudeCode({
    prompt: testerPrompt({ phase, context, prompt, report, builderResult, autoSummary }),
    cwd: projectPath,
    config: testerConfig,
    onSpawn,
  });
  const raw = readAgentFile(projectPath, 'verdict');
  res.verdict = normalizeVerdict(raw, res);
  return res;
}

// Whatever happened, the orchestrator always gets a well-formed verdict.
function normalizeVerdict(raw, res) {
  if (!res.ok) {
    return { pass: false, summary: `Tester agent call failed: ${res.error}`, failures: [{ what: 'tester crashed', evidence: String(res.error || ''), suggested_fix: '' }], source: 'tester_error' };
  }
  if (!raw || typeof raw !== 'object') {
    return { pass: false, summary: 'Tester wrote no readable verdict file — treated as FAIL.', failures: [{ what: 'missing verdict', evidence: truncate(String(res.parsed?.result ?? ''), 2000), suggested_fix: '' }], source: 'missing' };
  }
  return {
    pass: raw.pass === true,
    summary: typeof raw.summary === 'string' ? raw.summary : '(no summary)',
    failures: Array.isArray(raw.failures) ? raw.failures.filter((f) => f && typeof f === 'object') : [],
    source: 'verdict_file',
  };
}

// --- Deployer --------------------------------------------------------------

function deployerPrompt({ projectName, repoName, visibility, context }) {
  return `You are the DEPLOYER agent in a fully automated pipeline. The project in the current directory is finished, verified, and committed on branch main. Put it live on GitHub. No human is watching; never ask questions.
${contextBlock(context)}
Do exactly this:
1. The gh CLI is already authenticated. Create the GitHub repository "${repoName}" (visibility: ${visibility}) if it does not exist, add it as remote "origin" (replace origin if it points elsewhere), and push main.
2. Make the site live with GitHub Pages: pick the right mechanism for this project type — deploy-from-branch for a plain static site, or a GitHub Actions workflow that builds and uploads the artifact for anything with a build step. Commit and push whatever workflow/config that needs.
3. Wait for the deployment to finish, then fetch the public URL and confirm it returns the real site (HTTP 200 and actual content, not a 404 page).
4. Write ${FILES.deploy.replace(/\\/g, '/')} containing exactly one JSON object:
   {"repo_url": "https://github.com/...", "pages_url": "https://...", "live": true|false, "notes": "<what you set up / anything a human should know>"}
   Set "live" to true only if you saw the URL serve the site yourself.
Project name for titles/descriptions: ${projectName}`;
}

async function runDeployer({ projectPath, config, onSpawn, projectName, repoName, visibility, context, fixPrompt }) {
  ensurePcrDir(projectPath);
  clearAgentFile(projectPath, 'deploy');
  const res = await runClaudeCode({
    prompt: fixPrompt || deployerPrompt({ projectName, repoName, visibility, context }),
    cwd: projectPath,
    config,
    onSpawn,
  });
  res.deploy = readAgentFile(projectPath, 'deploy');
  return res;
}

module.exports = {
  runBuilder,
  runBuilderFix,
  runTester,
  runDeployer,
  builderPrompt,
  testerPrompt,
  deployerPrompt,
  readAgentFile,
  REPORT_INSTRUCTION,
  PCR_DIR,
};
