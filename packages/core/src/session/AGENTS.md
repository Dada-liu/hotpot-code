# Working in src/session/

- The JSONL event log is the single source of truth. Never add parallel mutable session state; anything the UI or the LLM loop needs must be derived from events (see `derive.ts`).
- `events.ts` is the v1 event contract; field shapes follow `docs/archive/02-architecture.md` section 5 exactly. Do not change existing variants — the format is final at v1; a future v2 would add migration instead. (M2 amendment: `tool_result` gained an optional `agentId` for multi-agent attribution; missing means "main".) Additive variant: `internal_msg` carries orchestrator-internal continuation prompts; `deriveMessages` folds it like `user_msg`, but UI must not render it. Audit-only additive variants (folded nowhere, not rendered by UI): `permission/changed` records permission mode switches (`mode: PermissionMode`, `source: "user" | "settings"`).
- `store.ts` append must keep the open/write/fsync/close discipline: a crash may lose at most the last line, and `loadSession` must keep tolerating that truncated tail.
- Home resolution order is fixed: explicit `home` argument, then `HOTPOT_HOME`, then `~/.hotpot`. The cwd encoding rule (`/` and `:` to `-`) lives in `encodeCwd`; reuse it instead of re-implementing.
- Export the feature's public surface through `index.ts`; cross-feature imports target concrete files.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
- Verify with `pnpm test` and `pnpm exec biome check` from the repo root before committing.
