# Prompt Chain Runner

An autonomous **agent company** that builds, tests, and ships a whole project from a single prompt file — driven by [Claude Code](https://claude.com/claude-code), watched from a live dashboard, with **zero human input between Start and "your site is live."**

You import a markdown/txt file of ordered prompts. Then the company takes over:

| Agent | Job |
|---|---|
| **Orchestrator** (`runner.js`) | The main agent. Injects prompts in order, routes every hand-off, verifies everything, commits every passing step, halts on real trouble. Deterministic code — it never hallucinates. |
| **Builder** | A headless Claude Code session per prompt. Does the work, then files a machine-readable report (`.pcr/report.json`). |
| **Tester** | A *separate* Claude Code session. Reads the builder's claims and verifies them skeptically — runs the app, clicks through, checks output — then files a verdict (`.pcr/verdict.json`). Failures go straight back to the builder as fix prompts with the exact evidence. |
| **Deployer** | When every prompt has passed: creates the GitHub repo, pushes, sets up GitHub Pages, and reports the public URL. The orchestrator then **polls that URL itself** — the site is "live" only when the orchestrator has seen it serve HTTP 200. |

On top of the agents, **auto-detected checks** (npm install / typecheck / lint / build / test — derived from what the project actually is, nothing to configure) run after every builder attempt. Exit codes never hallucinate.

You get exactly one Windows notification: when the site is fully built, tested, and live on GitHub. (And one if the run halts and genuinely needs you.)

**Zero dependencies.** Node's standard library only.

---

## Quick start

```bash
npm run dashboard        # or: node dashboard.js --open  →  http://127.0.0.1:4747
```

1. **Prompts tab** — drop in your `.md`/`.txt` prompt file (or paste it). It is split into ordered prompts automatically: by markdown headings, `---` separators, or `Prompt 1 / 2 / 3` numbering. Text above the first prompt becomes shared project context sent with every build step.
2. Review the parsed queue (edit/reorder/remove if you like), name the project, leave *Deploy to GitHub Pages* on.
3. Click **Save & start the run** — and walk away.
4. **Live tab** — watch the company work: which agent is on duty, the pipeline of prompts, and the agent-to-agent feed (builder reports, tester verdicts, fix prompts, commits, deploy).
5. **Logs tab** — every run, filterable per prompt: full prompts, full outputs, every check, every verdict, every fix.

Requirements: Node.js 20+, git, the Claude Code CLI logged in (`claude` on PATH), and the GitHub CLI (`gh`) authenticated if you want deploys. No API key — it rides your existing Claude Code session.

### Example prompt file

```markdown
This is a one-page portfolio site for a photographer. Dark, minimal, fast.

## Prompt 1 — scaffold
Create a static site: index.html, styles.css, script.js. Semantic HTML, no frameworks.

## Prompt 2 — gallery
Build a responsive photo gallery with a lightbox. Use placeholder images.

## Prompt 3 — polish
Add smooth scrolling, meta/OG tags, favicon, and a contact section.
```

(`prompts/example-prompts.md` in this repo is a ready-to-import sample.)

---

## How a single prompt flows

```
Orchestrator ──prompt──► Builder (Claude Code, headless)
     ▲                      │ works, writes .pcr/report.json
     │                      ▼
     │        auto-detected checks (real commands, real exit codes)
     │                      │ all exit 0
     │                      ▼
     │                   Tester (separate Claude Code session)
     │                      │ verifies the claims, writes .pcr/verdict.json
     │   FAIL: fix prompt   │
     └──── with evidence ◄──┤ PASS
                            ▼
                git commit → next prompt … → Deployer → GitHub Pages
                                                  │
                            orchestrator polls the public URL itself
                                                  ▼
                            🔔 Windows toast: "your site is LIVE" + URL
```

- Every failure (failed check *or* tester rejection) becomes a fix prompt containing the exact error output / evidence, sent back to the builder. Bounded by `max_retries`.
- Retries exhausted → the phase is `stuck` and the run **halts** (exit 2) instead of building on sand — and you get notified.
- Fully resumable: rerun and `passed` phases are skipped; a phase caught mid-run is redone.
- One commit per passed phase in the target project's own git repo — a full audit trail.
- Agent files live in `<project>/.pcr/` (gitignored) and are **deleted by the orchestrator before each agent call**, so a stale or forged report/verdict can never be reused.

## Settings — `config.json`

Verification is automatic; there is nothing you must edit here.

| Key | Meaning |
|---|---|
| `claude_command`, `claude_args` | The CLI to drive (array form supported; tests use it to swap in a mock). |
| `claude_timeout_ms` / `tester_timeout_ms` | Hard kill per builder / tester call (1 h / 20 min default). |
| `max_retries` | Fix rounds per prompt (and per deploy) before `stuck`. |
| `tester.enabled` | Turn the tester agent off (checks-only gating). Default on. |
| `deploy.enabled` | Deploy stage on/off. Default on (the dashboard toggle overrides per project). |
| `deploy.visibility` | GitHub repo visibility (`public` default — Pages on the free plan needs public). |
| `deploy.verify_live`, `deploy.live_timeout_ms` | The orchestrator's own URL polling. |
| `notify.enabled` | Windows toast (with `msg` fallback) on finish/halt. |
| `verification_steps` | Optional manual override; when absent (default) checks are auto-detected per attempt. |

## The three tabs

- **Live** — status pill + Start/Stop/Kill; stat tiles (project, progress, elapsed, cost); the four agent cards with live activity; the prompt pipeline with per-prompt status and retry counts (plus the 🚀 deploy chip); the agent feed; a big green banner with the live URL when done.
- **Prompts** — file drop / paste → parsed preview (editable, reorderable) → project name, deploy toggle, repo name → Save / Save & start.
- **Logs** — run selector, per-prompt filter chips, expandable full detail for every event, raw log download.

The dashboard binds to `127.0.0.1` only and rejects foreign `Host`/`Origin` headers (DNS-rebinding/CSRF protection). It is a local control panel — never expose it.

Headless equivalents:

```bash
node runner.js                  # start a run
node runner.js --retry-stuck    # revive stuck phases
node runner.js --dry-run        # validate + print the plan, execute nothing
# graceful stop: create a file named .stop next to state.json
```

## Files

```
prompt-chain-runner/
├── runner.js               # the Orchestrator
├── dashboard.js            # zero-dep local web server + API
├── public/index.html       # the dashboard (single self-contained file)
├── config.json             # settings (verification is auto-detected)
├── prompts/queue.json      # the active queue (written by the dashboard)
├── prompts/example-prompts.md
├── lib/
│   ├── agents.js           # Builder / Tester / Deployer roles + .pcr protocol
│   ├── autocheck.js        # auto-detected verification steps
│   ├── parse-prompts.js    # md/txt → ordered prompt queue
│   ├── live-check.js       # the orchestrator's own "is it live" polling
│   ├── notify.js           # Windows toast / msg fallback
│   └── claude, verify, git, queue, state, logger, fix-prompt, util
├── logs/                   # run-<stamp>.log + run-<stamp>.events.jsonl
├── state.json              # live state for the dashboard (generated)
└── projects/<slug>/        # each built site (its own git repo, own GitHub remote)
```

## Tests

```bash
npm test
```

27 end-to-end + unit tests. The Claude CLI is swapped for a scripted mock; everything else is real — real processes, real shell checks, real git commits, real HTTP for the dashboard API and the live check. Covered: the happy path, fix prompts from real errors, tester verdict flow (including a missing verdict and a builder-forged verdict), retry exhaustion → stuck, CLI crashes, resume, graceful stop, deploy (trust + independent live rejection), the parser, auto-check detection, and the dashboard API with its security guards.

## Safety notes, honestly

- Builder/tester/deployer sessions run with `--dangerously-skip-permissions` — that's what makes a fully unattended run possible. Point projects only at directories you're happy to have rewritten, and treat the checks + tester + git history as the safety net.
- The deployer uses your authenticated `gh` CLI and creates **public** repos by default (Pages requirement on free plans). Set `deploy.visibility` or turn deploys off per project if that's not what you want.
- Auto-commits are unsigned (repo-local `commit.gpgsign false`) so a run can never hang on a GPG prompt.
- Only one runner per queue (`.runner.lock`, dead-pid steal). Stop is graceful; Kill takes down the whole process tree including the in-flight Claude call.

## License

MIT
