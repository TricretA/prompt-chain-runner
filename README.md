# Prompt Chain Runner

An autonomous prompt-chain orchestrator for [Claude Code](https://claude.com/claude-code).

You write an ordered list of build prompts ("phases") once. The runner then drives Claude Code through them completely unattended:

1. Sends the next unfinished phase to Claude Code programmatically — no typing, no approval clicks.
2. When Claude Code finishes, runs **real verification commands** (install, typecheck, lint, build, test) against the actual project and reads the real exit codes. "Claude said it's done" counts for nothing.
3. Verification passed → commits to git, marks the phase `passed`, moves on.
4. Verification failed → auto-builds a fix prompt from the **exact error output** and sends it back to Claude Code. Retries up to `max_retries`.
5. Retries exhausted → marks the phase `stuck` and **halts the whole run** (later phases likely depend on the broken one). Everything is in the log.
6. Repeats until every phase is done.

A live **web dashboard** shows the entire run as it happens: every phase, every Claude call, every verification step, every fix prompt, every commit — plus start/stop/kill controls.

The only human touchpoints: writing the phase list before the run, and reading the log if something gets stuck.

**Zero dependencies.** No database, no workflow engine, no accounts. Node's standard library only — `npm install` is not even needed for the runner itself.

---

## Quick start

```bash
# 1. Describe what "verified" means for your project
#    (edit the verification_steps in config.json)

# 2. Write your phases, in order, fully, in advance
#    (edit prompts/queue.json)

# 3. Start the dashboard (opens the browser)
npm run dashboard        # or: node dashboard.js --open

# 4. Click "Start run" — or run headless:
node runner.js
```

Requirements: Node.js 20+, git, and the Claude Code CLI installed and logged in (`claude` on your PATH). The runner rides on your existing Claude Code session — no API key needed.

---

## The phase queue — `prompts/queue.json`

This is the only input you write by hand:

```json
{
  "project_path": "./target-project",
  "phases": [
    {
      "id": "phase-1",
      "prompt": "Set up a Next.js project with TypeScript and Tailwind. Create the folder structure for pages, components, and lib.",
      "status": "pending",
      "retries": 0,
      "commit_hash": null
    },
    {
      "id": "phase-2",
      "prompt": "Build the landing page UI. Use the components folder created in phase-1.",
      "status": "pending",
      "retries": 0,
      "commit_hash": null
    }
  ]
}
```

- `project_path` — where Claude Code works. A relative path resolves against this repo's root. The runner creates the folder and initializes a git repo in it if needed.
- Phases run strictly in order. The runner never skips ahead and never reorders.
- `status` is owned by the runner: `pending` → `running` → `passed` / `failed_retry` / `stuck`. The file is rewritten after every step, so you can watch it, and a crashed run resumes exactly where it left off — `passed` phases are skipped, a phase caught mid-`running` is re-run.
- `commit_hash` records exactly which commit each phase produced — a full audit trail.

## Settings — `config.json`

```json
{
  "claude_command": "claude",
  "claude_args": [],
  "claude_timeout_ms": 3600000,
  "max_retries": 4,
  "stop_on_first_failure": false,
  "output_capture_limit": 20000,
  "fix_prompt_output_limit": 8000,
  "verify_timeout_ms": 600000,
  "dashboard_port": 4747,
  "verification_steps": [
    { "name": "install",   "command": "npm install" },
    { "name": "typecheck", "command": "npx tsc --noEmit" },
    { "name": "lint",      "command": "npm run lint" },
    { "name": "build",     "command": "npm run build" },
    { "name": "test",      "command": "npm test -- --run" }
  ]
}
```

| Key | Meaning |
|---|---|
| `claude_command` | The CLI to drive. A string, or an array like `["node", "path/to/cli.js"]` (the test suite uses this to swap in a mock). |
| `claude_args` | Extra flags appended to every Claude Code call (e.g. `["--model", "opus"]`). |
| `claude_timeout_ms` | Hard kill for a single Claude Code call. Default 1 hour. |
| `max_retries` | Fix-prompt retries per phase before it's declared `stuck`. |
| `verification_steps` | The gate. Every command must exit 0, in your project, for a phase to pass. Per-step `timeout_ms` optional. |
| `stop_on_first_failure` | `false` (default) runs all steps and puts **every** failure into the fix prompt; `true` stops at the first. |
| `output_capture_limit` | Max chars of a step's output kept in logs/events. |
| `fix_prompt_output_limit` | Max chars of a step's output embedded in a fix prompt (tail-kept — errors live at the end). |

## The dashboard

```bash
node dashboard.js --open     # default http://127.0.0.1:4747
```

- **Stat tiles** — phases passed (with progress meter), current phase and attempt, Claude calls and total time in Claude, cost reported by Claude Code, elapsed.
- **Phase pipeline** — every phase with its live status chip, retry count, commit hash, full prompt, and per-step verification results with error output.
- **Activity feed** — the structured event stream: prompts sent, Claude results, each verification step passing/failing, auto-generated fix prompts (viewable in full), commits, stuck/done.
- **Raw log** — the actual transcript file, live-tailing, including past runs via the run selector.
- **Controls** — Start run (optionally reviving stuck phases), Stop (graceful: finishes the current step, then halts), Kill (force-kills the process tree).

The dashboard binds to `127.0.0.1` only. It is a local control panel — don't expose it.

Headless equivalents:

```bash
node runner.js                  # start a run
node runner.js --retry-stuck    # also revive phases marked stuck
node runner.js --dry-run        # validate queue + config, print the plan, execute nothing
# graceful stop from another terminal: create a file named .stop next to state.json
```

## How the pieces fit

```
┌────────────┐   phase prompt    ┌─────────────┐
│ runner.js  │ ────────────────► │ Claude Code │  (claude -p, stdin prompt,
│ (the loop) │ ◄──────────────── │  headless   │   --output-format json,
└─────┬──────┘   JSON result     └─────────────┘   --dangerously-skip-permissions)
      │
      │ real commands, real exit codes
      ▼
┌─────────────────────────────┐  all pass → git commit, next phase
│ verification gate           │
│ install → typecheck → lint  │  any fail → fix prompt from exact errors,
│ → build → test              │             same phase again (≤ max_retries)
└─────────────────────────────┘
      │
      ▼
 queue.json (statuses, commit hashes)   state.json (live run state)
 logs/run-*.log (full transcript)       logs/run-*.events.jsonl (event stream)
      ▲                                       ▲
      └────────────── dashboard.js ───────────┘  → http://127.0.0.1:4747
```

Files:

```
prompt-chain-runner/
├── runner.js            # the orchestrator — one while loop, no magic
├── dashboard.js         # zero-dep local web server + runner controls
├── public/index.html    # the dashboard UI (single self-contained file)
├── config.json          # verification gate + settings
├── prompts/queue.json   # your phases (the only hand-written input)
├── lib/                 # claude, verify, git, queue, state, logger, fix-prompt, util
├── logs/                # run-<stamp>.log + run-<stamp>.events.jsonl per run
├── state.json           # live state for the dashboard (generated)
└── target-project/      # the codebase Claude Code builds (its own git repo)
```

## When a phase gets stuck

The run halts (exit code 2) instead of silently skipping ahead. To diagnose:

1. Open the dashboard → the stuck phase shows its failed steps and error output; or read `logs/run-<stamp>.log` — every prompt, every Claude result, every command output is in there.
2. Fix the cause: sharpen the phase prompt, fix the environment, or hand-fix the code in `target-project` and commit.
3. Resume with `node runner.js --retry-stuck` (or tick *retry stuck* in the dashboard). Passed phases are never re-run.

Exit codes: `0` all phases passed · `1` runner error · `2` stuck · `3` stopped.

## Tests

```bash
npm test
```

The suite swaps the Claude CLI for a scripted mock (`test/mock-claude.js`) but keeps everything else real — real child processes, real shell verification commands, real git commits. It covers: the happy path, fix-prompt generation from real error output, multi-step failure aggregation, retry exhaustion → stuck → halt, CLI-crash retries, resume + `--retry-stuck`, graceful stop, output truncation, and queue validation.

## Safety notes, honestly

- The runner passes `--dangerously-skip-permissions` to Claude Code. That is the flag that makes a fully unattended run possible — and it means Claude Code edits files and runs commands in `target-project` **without asking**. Point `project_path` only at a directory you're happy to have rewritten wholesale, and treat the verification gate + git history as your safety net.
- Auto-commits in the target repo are made with signing disabled (`commit.gpgsign false`, repo-local) so an unattended run can never hang on a GPG prompt.
- The dashboard has no authentication; it listens on localhost only. Anyone with local access to the machine can control the runner through it.

## License

MIT
