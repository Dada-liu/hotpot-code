# Working in src/tools/

- `spawn_workers` is the main agent's only meta tool, shared by the first-turn simple dispatch and the complex execution phase. Its gate is dual-branch: allowed when `planApproved`, or when the turn has no plan marker (`detectPlanDraft`); with an unapproved plan marker in the turn it must fail-closed (isError) and must not emit `agent_spawn` before approval.
- `spawn_tasks` batches by `runtime.maxParallelTasks` (default 10) and aggregates each failure as `[FAILED] ${agentId}: ${reason}` with `isError=false` — the worker decides whether to retry, take over, or report.
- `run-worker` selects `createWorkerRegistry` for workers (bound `spawn_tasks`) and `createRoleRegistry` for tasks. It must not forward child transient events to the main stream; only error events, `done(aborted)` and the final summary are collected, and an `agent_end` log event is appended at wrap-up (web panel card status; guaranteed by try/finally even when runTurn throws).
- Before building a child prompt, fold its todos and skills only when the corresponding feature is enabled.
- Export the directory barrel through `index.ts`; the package entry intentionally exports only spawn-workers.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
