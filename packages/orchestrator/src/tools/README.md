# src/tools/

编排元工具与下层 agent 的内联执行。

- `spawn-workers.ts` — main 唯一的元工具：首轮 simple 直派与 complex 执行阶段共用。按 `modelTier` 逐个 spawn worker 并聚合摘要；双分支门禁——`planApproved` 直接放行，未批准时 `detectPlanDraft` 命中本回合计划标记则 fail-closed 返回 isError（堵同轮既出计划又执行、审批被绕过），无标记（simple 首轮）放行，批准前不产生 `agent_spawn`。
- `spawn-tasks.ts` — worker 内并行原子任务；并发池按 `runtime.maxParallelTasks`（默认 10）分批；失败任务聚合为 `[FAILED] ${agentId}: ${reason}`，整体 `isError=false`。
- `run-worker.ts` — worker/task 内联执行：按角色装配注册表，瞬态事件不外传，只回收 error、done(aborted) 与收尾 summary，收尾落盘 `agent_end`（web 卡片状态数据源，try/finally 保证 runTurn 抛错也落盘）；构建 prompt 前按 features 折入 todo/skills 段。
- `index.ts` 是本目录的 barrel；包入口只导出 spawn-workers，spawn-tasks / run-worker 保持包内可见。
