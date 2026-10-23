# src/registries/

按角色装配工具注册表（规则见 `docs/archive/03-agent-orchestration.md` §1）。

- `createRoleRegistry(runtime, role, metaTools)`：
  - main：编排元工具 + read（M1 起唯一的文件工具，裸注册——不套 decorateWorkerTool，也不套 skill 追踪；main 仍无 write/edit/bash）。
  - worker：bash/read/write/edit + feature 派生工具 + metaTools。
  - task：bash/read/write/edit + feature 派生工具，忽略 metaTools。
- feature 派生按 `runtime.features` 判读：todo、web_fetch、web_search、MCP；`decorateWorkerTool` 只作用于 worker/task 四件套基础工具（main 的 read 与 feature 外工具、元工具都不装饰）。
- `decorateWorkerTool` 由装配层经 `createPermissionModeDecorator(holder)` 提供（runtime.ts）：execute 时读 `holder.mode` 动态分派——readonly 下非 read 工具逐个预审批，workspace/full 原样放行。
- `createWorkerRegistry(runtime, { agentId, tier })`：worker 专用工厂，闭包绑定该 worker 的 `spawn_tasks`，派生 task 继承其档位。
- worker/task 的 read 工具包一层 skill 追踪，命中 `SKILL.md` 时落 `skill/loaded`（每会话每文件一次）。
- `index.ts` 是本特性的对外出口。
