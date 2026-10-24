# Working in packages/core/

- Source in `src/` with one subdirectory per feature: `agent/`, `approval/`, `config/`, `frontmatter/`, `hooks/`, `prompt/`, `prompt-templates/`, `session/`, `skills/`, `tools/`, `workspace/`. Each feature folder has `index.ts` (barrel), implementation files, `README.md` (Chinese) and `AGENTS.md` (English). `src/index.ts` is the package entry (re-exports only); `node-builtins.d.ts` holds ambient declarations. Tests in `test/*.test.ts`.
- May depend on `@hotpot/ai` (`workspace:*`) and whitelisted runtime deps (`zod`); never import from `@hotpot/cli`.
- The session JSONL event log is the single source of truth — UI-facing state must be derivable via `deriveMessages`; do not introduce parallel mutable state.
- Home resolution (`resolveHome` in `session/store.ts`) is shared by sessions and `config/config.ts` (`loadSettings`): param > `HOTPOT_HOME` env > `~/.hotpot`. Reuse it, don't duplicate the rule. Settings merge user-level (`~/.hotpot/settings.json`, required, models + credentials) with optional project-level (`.hotpot/settings.json` walked up from `cwd`, whitelist fields only).
- LLM-facing prompt text is English; code comments in Simplified Chinese.
- Session events: `internal_msg` is an additive variant for orchestrator-internal continuation prompts. `deriveMessages` folds it as a user-role message for its `agentId`, but it is not user input and the UI must not render it.
- M4 capabilities: `tools/todo.ts` (full-replace task list persisted as `todo/set`; state rebuilt by `session/todos.ts`), `hooks/hooks.ts` (Claude Code hook chain; PreToolUse non-zero exit blocks the tool), `skills/skills.ts` + `frontmatter/frontmatter.ts` (SKILL.md discovery), `prompt-templates/prompt-templates.ts` (`/command` discovery + `$ARGUMENTS`/`$N` expansion), `tools/web-fetch.ts` and `tools/web-search.ts` (injectable fetch/search backends). Feature switches are read through `featureEnabled` (default on); M4 settings fields are user-level only.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports.
- Verify with `pnpm test` and `pnpm exec biome check` from the repo root before committing.
