# src/runtime/

编排运行时：spawn、模型解析、权限模式与 M4 可选能力的闭包。

- `createRuntime(opts)` 返回 `OrchestrationRuntime`。
- spawn：首次调用按既有日志播种各 role 计数器（resume 场景防 agentId 复用），按 role 分配单调递增编号（worker-1、task-1…），并把 `agent_spawn` 落盘；spawn 本身不运行 turn。
- 编号分配经 Promise 链串行化，保证「播种 → 编号 → 落盘」与调用序一致；task turn 仍并行执行。
- `resolveModel(tier)` 走 `models/`；`decorateWorkerTool` 是装配层权限包装（`createPermissionModeDecorator`）的注入缝。
- 权限模式（M1）：`permissionMode: { mode: PermissionMode }` 可变持有者在 runtime 上，装配时从 settings 初始化（默认 workspace），运行期可被 server API 改写（M2）；与装饰器工厂共享同一对象引用，改写立即对后续工具执行生效。
- `createPermissionModeDecorator(holder)`：worker/task 工具的权限动态分派装饰器——readonly 下非 read 工具逐个预审批，workspace/full 原样放行；装配期总是设置，execute 时才读 mode。
- 可选透传：`features`、`skills`、`mcpTools`、`webSearch` / `webSearchBackend`、`hooks`。
- `index.ts` 是本特性的对外出口。
