# Prompt Chain Runner

An autonomous **agent company** that plans, builds, tests, designs, security-checks and ships a whole project — driven by [Claude Code](https://claude.com/claude-code), watched from a live dashboard, with **zero human input between "go" and "your site is live."**

Give it one line — *"a one-page site for a family bakery in Nairobi"* — or your own written prompt chain. Then the company takes over:

| Agent | Job |
|---|---|
| **Orchestrator** (`runner.js`) | The main agent. Deterministic code, never hallucinates. Routes every hand-off, gates every claim, commits every passing step, controls the money. |
| **Planner** | Turns your one-line brief into an ordered build plan: stack, file layout, visual direction, and 3–8 precise step prompts. |
| **Builder** | A headless Claude Code session per prompt. Does the work, files a report (`.pcr/report.json`). |
| **Tester** | A *separate* session that verifies the builder's claims in a real browser, then files a verdict plus **re-testable criteria** — which every later step is then re-checked against, so step 6 can't silently break step 2. |
| **Debugger** | When ordinary fixes stall, this one changes nothing: it finds the actual root cause and hands it to the builder, so the next attempt stops guessing. |
| **Designer** | Screenshots the site at 360/768/1440px and **looks at the images**, then fixes what's ugly — spacing, hierarchy, contrast, overflow. Its changes are re-gated and rolled back if they break anything. |
| **Security** | The last gate before anything goes public: secrets in the tree *and in git history*, exposed credentials, dangerous client-side code. Critical findings block the deploy. |
| **Deployer** | Ships to **GitHub Pages, Vercel or Netlify** — whichever is actually installed and logged in. The orchestrator then proves the site is live **including that its CSS/JS return 200**, because a page that loads while every asset 404s is a broken deploy, not a live one. |

On top of the agents, **auto-detected checks** (install / typecheck / lint / build / test — derived from what the project actually is, nothing to configure) gate every builder attempt on real exit codes.

**It doesn't stop when things go wrong.** Each prompt climbs an escalation ladder — retry → retry with lessons from past runs → Debugger root-cause → revert to the last good commit and take a different approach. Only if all of that fails does it mark that one step *degraded*, tell you so honestly at the end, and **keep building the rest**.

**It survives its own accidents.** The dashboard watches the runner: if it dies in a reboot or wedges on a hung session, it's restarted and resumed automatically (capped at 4 restarts/hour so a broken queue can't loop forever).

**It queues.** Line up five projects in the backlog and walk away for a day.

You hear from it once — when the site is live — on Windows *and* on your phone (ntfy, Telegram, Discord, Slack, or any webhook).

**Zero dependencies.** Node's standard library only.

---

## Quick start

```bash
npm run dashboard        # or: node dashboard.js --open  →  http://127.0.0.1:4747
```

**The one-line way** — Prompts tab → *"describe it in one line"* → type what you want, pick a deploy target (or leave it on Auto) → **Plan & build it**. The Planner writes the prompt chain and the company builds it. That's the whole interaction.

**The precise way** — drop in your own `.md`/`.txt` prompt file (or paste it). It's split into ordered prompts automatically: markdown headings, `---` separators, or `Prompt 1 / 2 / 3` numbering. Text above the first prompt becomes shared context for every step. Review, reorder, then **Save & start**.

Either way: **Live tab** shows which agent is on duty, the prompt pipeline, and the agent-to-agent feed (builder reports, tester verdicts, root-cause diagnoses, design scores, security verdicts, deploy). **Logs tab** has every run in full detail, filterable per prompt. **Backlog** holds the projects it builds next.

Requirements: Node.js 20+, git, and the Claude Code CLI logged in (`claude` on PATH). No API key — it rides your existing Claude Code session. For deploys, whichever of `gh` / `vercel` / `netlify` you're logged into; the runner probes them at startup and tells the agents the truth about what's available. For the Designer and browser-driven testing, Playwright's chromium (`npx playwright install chromium`).

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

## How it flows

```
   one-line brief ──► Planner ──► the prompt chain
                                       │
        ┌──────────────────────────────┘
        ▼   for each prompt, in order
Orchestrator ──prompt──► Builder (headless Claude Code)
     ▲                      │ writes .pcr/report.json
     │                      ▼
     │        auto-detected checks (real commands, real exit codes)
     │                      │ all exit 0
     │                      ▼
     │                   Tester (separate session, real browser)
     │                      │ verdict + criteria; re-checks ALL earlier criteria
     │   FAIL → ladder:     │
     │   fix → lessons →    │ PASS
     │   Debugger → revert  ▼
     └───────────────  git commit → next prompt
                                       │
                            all prompts done
                                       ▼
                   Designer (screenshots → looks → fixes ugly)
                                       ▼
                   Security (secrets, history, exposure) ── blocks if critical
                                       ▼
                   Deployer → GitHub Pages / Vercel / Netlify
                                       ▼
        orchestrator verifies the live URL *and every asset it loads*
                                       ▼
              🔔 phone + desktop: "it's LIVE" + the URL
                                       ▼
                        next project from the backlog
```

- Every failure (failed check *or* tester rejection) becomes a fix prompt containing the exact error output and evidence.
- The **escalation ladder** changes strategy instead of repeating itself: `fix` → `lessons` (what fixed this class of error on previous runs) → `diagnosis` (Debugger finds the root cause) → `fresh_start` (revert to the last good commit, take a different approach).
- Ladder exhausted → that prompt is marked `degraded`, the run **keeps going**, and the final report says exactly what didn't get built. Set `on_stuck: "halt"` if you'd rather it stop.
- Fully resumable: `passed` phases are skipped, a phase caught mid-run is redone, and a completed deploy is never repeated.
- One commit per passed step in the project's own git repo — a full audit trail.
- Agent files live in `<project>/.pcr/` and are **deleted by the orchestrator before each agent call**, so a stale or forged report/verdict can never be reused. `.pcr/` and QA scratch dirs are excluded via `.git/info/exclude` *and* untracked before every commit, so agent traffic can never leak into a public repo.
- The Tester's working-tree fingerprint is compared before and after: if it edited the project instead of judging it, its PASS is void.

## Settings — `config.json`

Verification is automatic; there is nothing you *must* edit.

| Key | Meaning |
|---|---|
| `claude_command`, `claude_args` | The CLI to drive (array form supported; tests use it to swap in a mock). |
| `default_model` | Model every agent uses unless overridden below. **Default: `"haiku"`** — cheapest/fastest tier, since Builder and Tester are called once per phase attempt and dominate cost. Editable from the dashboard's **Prompts → Models** card, not just this file. |
| `planner_model`, `builder_model`, `tester_model`, `debugger_model`, `design_model`, `security_model`, `deployer_model` | Per-role override, e.g. `"sonnet"` or a full ID like `"claude-sonnet-5"`. Unset → falls back to `default_model` → unset entirely means the CLI's own default. Debugger/Designer/Security are low-volume judgment calls (root-cause analysis, visual review, vulnerability audit) where a stronger model can pay for itself by avoiding extra retries or missing a real finding — dial those up individually if quality suffers on `haiku`. Also settable from the dashboard's Models card; takes effect on the next run. |
| `fallback_model` | Comma-separated list passed as `--fallback-model`, tried in order for one turn if the primary is overloaded, e.g. `"sonnet,opus"`. Unset by default (no automatic cost escalation). |
| `claude_timeout_ms`, `planner_/tester_/debugger_/design_/security_timeout_ms` | Hard kill per agent call. |
| `max_retries` | Rungs on the escalation ladder per prompt (and deploy attempts). Default 5. |
| `on_stuck` | `"continue"` (default, hands-free — mark degraded and keep going) or `"halt"`. |
| `tester.enabled` | Turn the QA agent off (checks-only gating). Default on. |
| `design.enabled`, `design.rounds` | Screenshot-and-fix passes after the build. Default on, 1 round. |
| `security.enabled`, `.block_deploy`, `.max_fix_rounds` | The pre-publication gate. Default on and blocking. |
| `lessons.enabled` | Cross-run memory of error → fix (`memory/lessons.jsonl`). Default on. |
| `budget.max_usd_per_run` | Hard cap; checked before every agent call. Default $40. |
| `deploy.target` | `auto` (default), `github-pages`, `vercel`, or `netlify`. Auto picks what's actually logged in. |
| `deploy.visibility` | GitHub repo visibility (`public` default — Pages on the free plan needs public). |
| `deploy.verify_live`, `.live_timeout_ms` | The orchestrator's own URL + asset verification. |
| `notify.enabled` | Desktop toast. |
| `notify.ntfy/telegram/discord/slack/webhook` | Off-machine channels — fill in one to get told on your phone. |
| `watchdog.enabled`, `.heartbeat_stale_ms` | Auto-restart a dead or wedged runner. |
| `capabilities.cache_ms`, `.override` | Probing every CLI costs ~a minute, so it's cached (1 h). Override skips it. |
| `verification_steps` | Optional manual override; absent (default) means auto-detected per attempt. |

### Getting notified on your phone

The zero-setup option is [ntfy](https://ntfy.sh): install the app, pick any hard-to-guess topic name, and set it — no account, no keys.

```json
"notify": { "enabled": true, "ntfy": { "topic": "pcr-<something-random>" } }
```

## The three tabs

- **Live** — status pill + Start/Stop/Kill; stat tiles (project, progress, elapsed, cost); the four agent cards with live activity; the prompt pipeline with per-prompt status and retry counts (plus the 🚀 deploy chip); the agent feed; a big green banner with the live URL when done.
- **Prompts** — a **Models** card at the top (a dropdown per agent role — Default, Planner, Builder, Tester, Debugger, Designer, Security, Deployer — choosing Haiku/Sonnet/Opus/Fable) so you don't have to hand-edit `config.json` to control cost; then file drop / paste → parsed preview (editable, reorderable) → project name, deploy toggle, repo name → Save / Save & start.
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
├── dashboard.js            # zero-dep local web server + API + watchdog
├── public/index.html       # the dashboard (single self-contained file)
├── config.json             # settings (verification is auto-detected)
├── prompts/queue.json      # the active project
├── prompts/backlog.json    # projects to build next
├── prompts/example-prompts.md
├── lib/
│   ├── agents.js           # all 7 agent roles + the .pcr message protocol
│   ├── capabilities.js     # what this machine can actually deploy to
│   ├── autocheck.js        # auto-detected verification steps
│   ├── parse-prompts.js    # md/txt → ordered prompt queue
│   ├── live-check.js       # "is it live" — page AND every asset it loads
│   ├── lessons.js          # cross-run memory of error → fix
│   ├── backlog.js          # the multi-project queue
│   ├── notify.js           # desktop toast
│   ├── remote-notify.js    # ntfy / telegram / discord / slack / webhook
│   └── claude, verify, git, queue, state, logger, fix-prompt, util
├── memory/lessons.jsonl    # what past runs learned (generated)
├── logs/                   # run-<stamp>.log + run-<stamp>.events.jsonl
├── state.json              # live state for the dashboard (generated)
└── projects/<slug>/        # each built project (its own git repo + remote)
```

## Tests

```bash
npm test
```

45 end-to-end + unit tests. The Claude CLI is swapped for a scripted mock; everything else is real — real processes, real shell checks, real git commits, real HTTP for the dashboard API and the live checks. Covered: the happy path; planner brief → chain (and an unusable plan halting); the full escalation ladder reaching the Debugger and then a real `git revert` + fresh start; degraded-and-continue; regression criteria re-checked by later testers; design commits and design rollback when it breaks the build; security blocking and unblocking a deploy; budget cap enforcement; the backlog building a second project in one run; deploy target prompts per platform; a live page whose assets 404 being rejected; lessons matching across projects; forged and missing verdicts; tester tree-tampering; CLI crashes; resume; graceful stop; the parser; auto-check detection; and the dashboard API with its security guards.

## Safety notes, honestly

- Every agent session runs with `--dangerously-skip-permissions` — that's what makes a fully unattended run possible. Point projects only at directories you're happy to have rewritten, and treat the checks + tester + security gate + git history as the safety net.
- The deployer uses **whichever account your CLIs are logged into** and creates **public** repos by default (Pages needs public on free plans). Check `gh auth status` / `vercel whoami` before a run — the dashboard shows what it detected. Set `deploy.visibility`, or turn deploys off per project.
- `budget.max_usd_per_run` defaults to **$40**. An unattended multi-project night is the one situation where a runaway loop costs real money — that cap is the backstop, and the run halts and notifies when it's hit.
- The watchdog restarts a dead or wedged runner **with `--retry-stuck`**, so a project that halted gets one more go automatically. It's capped at 4 restarts/hour and can be turned off with `watchdog.enabled: false`.
- Auto-commits are unsigned (repo-local `commit.gpgsign false`) so a run can never hang on a GPG prompt.
- Only one runner per queue (`.runner.lock`, atomic dead-pid steal). Stop is graceful; Kill takes down the whole process tree including the in-flight agent session.

## License

MIT
