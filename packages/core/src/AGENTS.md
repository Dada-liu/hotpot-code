# Working in packages/core/src/

- The session JSONL event log is the single source of truth. UI-facing state must be derivable via `session/derive.ts`; do not introduce parallel mutable state. Every persisted `assistant_msg` tool_call must end up with exactly one `tool_result` — a missing one makes the next API request invalid.
- `src/` is organized one feature per subdirectory: `agent/`, `approval/`, `config/`, `frontmatter/`, `hooks/`, `prompt/`, `prompt-templates/`, `session/`, `skills/`, `tools/`, `workspace/`. Each carries its own `index.ts` (barrel), `README.md` (Simplified Chinese) and `AGENTS.md` (English) with module-level rules; read them before editing and keep them in sync with behavior changes.
- `src/index.ts` re-exports only; no logic. It re-exports each feature's `index.ts`. New public surface is exported from the owning feature's barrel.
- Import across features by concrete file path (e.g. `../session/store.ts`), not through another feature's `index.ts`, to avoid barrel cycles.
- `config/config.ts` (`loadSettings`) resolves home via `resolveHome` from `session/store.ts` (param > `HOTPOT_HOME` env > `~/.hotpot`) — reuse it, never duplicate the rule. Settings are two-layer: user-level `<home>/settings.json` (required, models + credentials) merged with an optional project-level `.hotpot/settings.json` found by walking up from `cwd` (whitelist fields only; credentials never come from project). `apiKey` supports whole-string `$ENV` references (user-level only).
- `node-builtins.d.ts` holds minimal ambient declarations for `node:*` modules because the dependency whitelist forbids `@types/node`; extend it when a new API is used, declaring only what is actually consumed.
- Dependency direction is fixed (`cli → orchestrator → core → ai`): may import `@hotpot/ai` and whitelisted runtime deps (`zod`); never import `@hotpot/cli` or `@hotpot/orchestrator`.
- LLM-facing prompt text and tool descriptions are English; code comments in Simplified Chinese.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports.
- Verify with `pnpm test` and `pnpm exec biome check` from the repo root before committing.
