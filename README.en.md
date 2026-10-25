<p align="center">
  <img src="public/logo.png" alt="hotpot-agent logo" width="160" />
</p>

<h1 align="center">hotpot-agent</h1>

<p align="center">
  <a href="README.md">中文</a> | English
</p>

A code agent built on Node + TypeScript. Goal: lower cost, better results.

## Install

```bash
npm install -g hotpot-agent
```

The npm package is named `hotpot-agent` (the `hotpot` name is taken by an unrelated project); the installed command is `hotpot`. Node >= 22 is required.

## Architecture

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│[Access Layer]                                                                      │
│  packages/web     React SPA: sessions / chat stream / agent panel                  │
│  packages/cli     line-based interactive entry                                     │
├────────────────────────────────────────────────────────────────────────────────────┤
│[Service Layer]                                                                     │
│  packages/server  REST + SSE (sessions, log replay, static hosting)                │
├────────────────────────────────────────────────────────────────────────────────────┤
│[Orchestration Layer]                                                               │
│  packages/orchestrator                                                             │
│    three-tier agents: main routes difficulty -> worker runs/splits                 │
│    -> task executes atomic tasks; plan review; steer/queue queues                  │
├────────────────────────────────────────────────────────────────────────────────────┤
│[Core Layer]                                                                        │
│  packages/core                                                                     │
│    turn/step two-level loop, tool three-face separation, approvals                 │
│    session JSONL event log as the single source of truth                           │
├────────────────────────────────────────────────────────────────────────────────────┤
│[Adapter Layer]                                                                     │
│  packages/ai                                                                       │
│    api x provider protocol adaptation                                              │
│    (anthropic-messages / openai-completions)                                       │
│    SSE streaming, model catalog, usage accounting                                  │
└────────────────────────────────────────────────────────────────────────────────────┘
```

Dependencies flow strictly top-down (`server → orchestrator → core → ai`; `cli` and `server` are both entry points above orchestrator, and `web` imports no workspace packages — its build output is served by server). Reverse dependencies are forbidden. There is also a side package `packages/telemetry` (`cli`/`server` → `telemetry` → `core`) that only reports anonymous metrics and stays off the agent main path; the dev tool `benchmarks/` (root-level, sibling of `packages/`) reuses core/orchestrator/telemetry for batch runs, but is not referenced by `cli`/`server` and is not shipped in the tool artifact.

Data flow of one user message: cli → `runMainTurn` (first-turn prompt difficulty routing) → worker / task inline-runs core `runTurn` → each step's history is derived by `deriveMessages` from the session log → `ai.streamChat` → tool batches execute through the approval waterfall → all events are appended to JSONL and streamed back to the cli renderer.

## Directory Structure

```
├── AGENTS.md          # development conventions (English)
├── AGENTS_zh-CN.md    # development conventions (Chinese backup)
├── docs/              # project docs (markdown as code)
│   ├── PRD.md         # finalized product requirements (authoritative source)
│   ├── archive/       # design archive: requirements / architecture / orchestration / milestones
│   └── superpowers/   # implementation plans
├── packages/          # code (pnpm monorepo)
│   ├── ai/            # @hotpot/ai: LLM protocol adaptation and model catalog
│   ├── core/          # @hotpot/core: session log, turn loop, tools and approvals
│   ├── orchestrator/  # @hotpot/orchestrator: three-tier orchestration (spawn_workers/spawn_tasks, plan approval, inbox)
│   ├── server/        # @hotpot/server: REST + SSE service (sessions, log replay, approval bridge, static hosting)
│   ├── web/           # @hotpot/web: React SPA (three-column UI, agent status panel)
│   ├── cli/           # @hotpot/cli: line-based interactive entry
│   ├── hotpot-agent/  # hotpot-agent: npm distribution package (hotpot command + web assets)
│   └── telemetry/     # @hotpot/telemetry: M5 anonymous telemetry client (event schema, redaction, batching)
├── benchmarks/        # @hotpot/benchmarks: M5 benchmark runner (official SWE-bench evaluation + three categories of custom tasks)
└── scripts/           # development helper scripts (pnpm dev, etc.)
```

## Common Commands

```bash
pnpm install          # install dependencies
pnpm build            # build the web app and the npm distribution package
pnpm test             # run all tests (vitest, packages/*/test/**/*.test.ts)
pnpm typecheck        # tsc typecheck for all packages
pnpm pack:npm         # create the npm tarball under artifacts/
pnpm publish:npm      # publish the npm tarball (requires npm login)
pnpm bench --help     # benchmark runner: official SWE-bench / three categories of custom tasks
pnpm dev <pkg> [args] # run a package entry directly with tsx, e.g. pnpm dev cli chat
pnpm dev web          # build and start the web app (default port 4573, opens the browser)
pnpm exec biome check # lint + format check
```

Web build and development: `pnpm --filter @hotpot/web build`, then server serves the output directly; for frontend development run `pnpm --filter @hotpot/web dev` (Vite dev, proxies `/api` to 4573).

## Current Status

M1 done: the minimal loop "conversation → tool calls → task completion" works in the terminal (scripted acceptance in `packages/cli/test/acceptance.test.ts`; criteria in the M1 section of `docs/archive/04-roadmap.md`).

M2 done: three-tier orchestration (main difficulty routing → worker execution/parallel split → task atomic tasks), plan review before execution, steer/queue dual queues (scenario acceptance in `packages/orchestrator/test/m2-acceptance.test.ts`; criteria in the M2 section of `docs/archive/04-roadmap.md`).

M3 done: web delivery — `packages/server` (REST + SSE, default port 4573, reconnect replay from the log, CLI and web can observe the same session) + `packages/web` (React SPA: session list, streaming chat, tool cards, plan review, approvals, steer/interrupt, usage display, right-side agent status panel). Tests in `packages/server/test/` (api / session-manager / tailer / static) and `packages/web/test/`; criteria in the M3 section of `docs/archive/04-roadmap.md`).

M5 done (this repo's part): `packages/telemetry` anonymous telemetry client (cli/server integration, event allowlist, redaction, batch retry) + `benchmarks/` benchmark runner (SWE-bench instance export/selection, plain checkout + worktree, non-interactive agent, predictions, official `swebench` harness orchestration, reports, `benchmark_run` telemetry, three categories of built-in tasks). Usage in `benchmarks/README.md`; authoring flow in `docs/benchmark-authoring.md`; Lite 10-task acceptance record in the M5 section of `docs/archive/04-roadmap.md`. The telemetry backend is a separate project outside this repo at `../hotpot-telemetry/` and is not shipped in the tool artifact.

M6 done: web interaction polish — sends made while a turn runs queue into next-turn by default (a QueueBar pinned above the composer; click an item to steer it into the running loop, ✕ to remove; consumption is persisted so reopening never re-runs executed messages); workspaces are first-class entities (`~/.hotpot/workspaces.json` registry with path/title/session membership/order), the sidebar groups sessions by workspace with in-group session creation, rename/delete and drag reordering, and adding a workspace goes through the native system directory picker (macOS `osascript`, Windows `FolderBrowserDialog`, Linux `zenity`/`kdialog`, with a manual path fallback); three permission presets (read-only / workspace-write / full access, implemented via approval policy, switchable in the composer and persisted); the composer supports `/` builtin commands (`/help`, `/permission`) plus prompt templates, ➕ text attachments, and `@` workspace file mentions (the main agent now has a read tool to follow those references).

How to run:

1. Configure `~/.hotpot/settings.json` (all three model tiers are required; `apiKey` can be a literal value or `"$VAR"` referencing an environment variable):

   ```json
   {
     "models": {
       "high": { "provider": "anthropic", "model": "claude-sonnet-4-5", "apiKey": "$ANTHROPIC_API_KEY" },
       "medium": { "provider": "openai", "model": "gpt-4.1", "apiKey": "$OPENAI_API_KEY" },
       "low": {
         "provider": "deepseek",
         "model": "deepseek-chat",
         "apiKey": "$DEEPSEEK_API_KEY",
         "baseUrl": "https://api.deepseek.com/v1"
       }
     }
   }
   ```

   Protocol selection for catalog models is automatic (anthropic → anthropic-messages, others → openai-completions); `baseUrl` is optional and defaults to each provider's official endpoint (the OpenAI family defaults to `https://api.openai.com/v1`; third-party endpoints such as deepseek/moonshot must be set explicitly). At project level, a `.hotpot/settings.json` in cwd or any parent directory can override non-credential allowlisted fields (`mainAgentTier`/`maxParallelTasks`/`planMaxRevisions`/`permission.mode`); credentials are read only from the user level.

2. The CLI command is `hotpot` (available after installation; source-repo dev equivalent: `pnpm dev cli chat`); it starts line-based chat: `/exit` quits, Ctrl-C interrupts the current turn; high-risk commands and overwrites ask for `y/n` approval (default n).
3. Sessions are persisted as JSONL under `~/.hotpot/sessions/`; `hotpot chat --session <session file path>` resumes history and continues the conversation (source-repo dev equivalent: `pnpm dev cli chat --session <session file path>`).
4. Web: after installation run `hotpot web` (http://127.0.0.1:4573 by default, opens the browser once ready; same settings, sessions shared with CLI); in the source repo use `pnpm dev web`. When developing the frontend, run `pnpm --filter @hotpot/web dev` in another terminal and Vite proxies `/api` to 4573.

## Publishing the npm Package

The distribution package lives in `packages/hotpot-agent` and contains only `dist/` (single-file CLI + web assets). Release steps:

1. Keep versions in sync: `packages/hotpot-agent/package.json` and `APP_VERSION` in `packages/telemetry/src/defaults.ts`.
2. Add `NPM_TOKEN` (an npm granular access token with publish permission) under GitHub repo Settings → Secrets and variables → Actions. The token must be able to bypass 2FA (an npm Automation token, or a granular token with "bypass 2FA" enabled); otherwise publishing fails with `EOTP`.
3. Commit, then tag and push:

   ```bash
   git tag v0.1.1
   git push origin main --tags
   ```

   `.github/workflows/publish.yml` verifies that the tag matches the package version, runs check / typecheck / test / build, then publishes to npm with provenance.
   If the token can only stage publishes, or the npm account has staged publishing enabled, the workflow puts the version in Staged Packages; a maintainer must approve it on npmjs.com with 2FA before it becomes public.
4. Manual local publish: run `npm login`, then `pnpm publish:npm`.

`artifacts/` is a local tarball directory and is not committed. The published tarball contains only `dist/bin.js`, `dist/web/**`, `README.md` and `LICENSE`.

## Known Issues (TODO)

- **The composer cannot rebuild turn state after a missed-window full replay**: `turn(start/end)` are transient wire events that are never persisted, while the missed-window replay path (`loadSession`, see `subscribeResuming` in `packages/server/src/session-manager.ts`) only replays durable logs. Failure shapes: 1) refreshing the page mid-turn in a busy session (events beyond the hub's 2000-entry retention window) leaves the client `turn` at its initial `idle` — the composer shows the normal send mode with no QueueBar or cancel button; the server still uses `holder.running` as the authority and queues the send into next-turn (no accidental new turn), but queued items stay invisible until the next snapshot refresh and cannot be cancelled; 2) after missing `turn(end)` and falling out of the window, the client `turn` is stuck at `running` — the composer shows the queue hint and a cancel button while the server is actually idle, so the send opens a normal new turn and the cancel button is a dead affordance. Fix direction: reconcile at subscribe time using `holder.running` as the authority, `hub.replay`-ing the missing `turn(start/end)` to that subscriber only (sink-only, mode B; cf. the removed synthetic `turn(end)` mechanism). Related gap: the plan-approval waiting state also relies on transient `plan`/`approval` events, so the approval entry does not recover after a missed-window replay while the server's parked promise is still waiting. Fix scheduled later.

