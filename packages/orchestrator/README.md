# @hotpot/orchestrator

三层 agent 编排，位于 core 之上（依赖方向 `orchestrator → core → ai`）。

## 架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 【主流与 plan】                                                             │
│   main-turn/  runMainTurn：主流入口，透传全部事件                           │
│   plan/       runPlanPhase：plan 复用 / 起草 / 审批 / 修订循环              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 【元工具】                                                                  │
│   tools/spawn-workers.ts   按档位 spawn worker 并聚合摘要（首轮 simple     │
│                            直派与 complex 执行共用；未批准且本回合有计划    │
│                            标记时 fail-closed isError）                     │
│   tools/spawn-tasks.ts     worker 内并行原子任务（并发池，默认 10）         │
│   tools/run-worker.ts      worker / task 内联跑 core runTurn                │
├─────────────────────────────────────────────────────────────────────────────┤
│ 【运行时与角色】                                                            │
│   runtime/      createRuntime：spawn 落盘、resolveModel、decorateWorkerTool │
│   models/       provider→api 映射                                           │
│   registries/   main / worker / task 角色工具注册表                         │
│   prompts/      角色系统提示词（英文）                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│ 【基础设施】                                                                │
│   inbox/  steer/queue 双队列 + foldInbox 崩溃恢复                           │
│   mcp/    MCP 客户端桥接（stdio / streamable HTTP → 注册表工具）            │
│   types/  AgentRole / OrchestrationEvent                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

三种角色（main / worker / task）复用 core 的 `runTurn`，差异只在系统提示词与可用工具集；所有事件最终落进 core 的会话 JSONL，依赖方向 `orchestrator → core → ai`。

## 已实现能力（M2 完成）

- **主流入口 `runMainTurn`**：以 "main" 身份落盘 user_msg → main 角色注册表（spawn_workers 元工具 + M1 起标配的 read 文件工具）跑 core `runTurn` → 透传全部事件。首轮提示词路由（无 delegate）：trivial 纯文本直答；simple 首轮直接 spawn_workers（本回合无计划标记即放行）；complex 不调用工具、本轮最终消息按 `PLAN_FORMAT_TEMPLATE` 输出计划正文。初始 turn 结束后 `detectPlanDraft` 命中 → 进入 plan 阶段（首轮草稿直接复用）；批准后跑执行 turn（注册表仍只挂 spawn_workers + read，planApproved 翻转后门禁放行）。worker spawn 以 `agent_spawn` 流变体直产（包装 `runtime.spawn` 推入本回合待产队列，主循环先 drain 再透传，事件先于对应 tool_result 到达、与调用序一致）。
- **`detectPlanDraft`（plan/）**：首轮流路由与 spawn_workers 门禁共用的计划检测——扫描最后一条 main `user_msg` 之后、最新一条带 `# Plan` 标记与 Steps/Files/Acceptance criteria 三个必备段落的 main `assistant_msg`（同轮「计划正文 + 后续补充说明」取最早命中的标记消息）。漏标/缺段落一律视为普通回答。
- **`spawn_workers` 元工具（main 唯一元工具）**：首轮 simple 直派与 complex 执行阶段共用。按 modelTier 逐个 spawn worker 并聚合摘要；双分支门禁——planApproved 直接放行，未批准时 detectPlanDraft 命中本回合计划标记则 fail-closed 返回 isError（同轮既出计划又执行、审批被绕过的洞被堵死），无标记（simple 首轮）放行，不产生 agent_spawn 于批准前。
- **`spawn_tasks` 元工具（worker）**：并行拆分原子子任务，并发池按 `runtime.maxParallelTasks`（默认 10，可配）分批；失败任务以 `[FAILED] ${agentId}: ${reason}` 段聚合（整体 isError=false），由 worker 决定重试/接手/上报。
- **plan 审批流 `runPlanPhase`**：优先复用 main 在初始轮产出的计划，仅当计划缺失、或 `next-step` 队列非空时追加内部起草 → `onPlanApproval` 回调（CLI 给终端审批实现）→ 批准/批注修订/拒绝；修订上限 `planMaxRevisions`（默认 3）。plan 阶段不挂工具，内部提示写 `internal_msg`（进入模型历史、UI 不渲染）；`plan(drafted)` 携带 `messageIds` 供 web 隐藏重复的计划正文。asked/decided 事件落盘会话日志（审批审计），批注以 note 记入 denied 的 decided。
- **运行时 `createRuntime`**：spawn 落盘 `agent_spawn`、按 role 计数的 agentId（worker-1、task-1…单调不复用）、`resolveModel` 档位解析、`decorateWorkerTool` 工具装饰注入（装配层的权限包装 `createPermissionModeDecorator` 经此进入下层注册表）、`permissionMode` 权限模式可变持有者（M1，默认 workspace，运行期可被改写）。
- **角色提示词与注册表**：main 为 spawn_workers 元工具 + read（M1 起唯一的文件工具）；worker 为 bash/read/write/edit + spawn_tasks；task 只有四件套。LLM-facing prompt 全英文。
- **权限三档（M1）**：`permission.mode`（readonly/workspace/full）经 `runtime.permissionMode` 持有者与 `createPermissionModeDecorator` 动态分派——readonly 下 worker/task 非 read 工具逐个预审批，workspace 仅危险操作询问（默认），full 全部自动放行（审批链头部 `allowAllHandler`）。CLI 与 server 装配镜像。
- **steer/queue 双队列 `createInbox`**：next-turn（followup，turn 结束后消费补发）与 next-step（steer/inject，经 `LoopConfig.pollInbox` 在 step 顶部注入模型历史）双队列；变更动词 `steerQueued(id)`/`removeNextTurn(id)`（M1，未命中返回 false）移动/移除排队消息，跨队列移动对两队列各落一条快照；`inbox/spliced` 事件落盘 + `foldInbox` 纯函数崩溃恢复。`createInbox` 支持 `seed` 从 `foldInbox` 结果播种恢复两队列（不追加新快照）。`runMainTurn` 接受可选 `inbox` 接线注入，初始轮、plan 起草/修订轮与执行轮都在 step 顶部消费；默认不轮询。
- **分层 usage 记账依据**：worker/task 经 `runtime.resolveModel(tier)` 走自己的档位模型，core 把 tier/model/agentId 落盘进 assistant_msg（`packages/orchestrator/test/m2-acceptance.test.ts` 验收 4 钉住）。

## M4 增量

- **注册表按 runtime 派生**：`createRoleRegistry(runtime, role, metaTools)` 统一装配。worker/task 按 `features.*` 并入 todo、web_fetch、web_search、MCP 工具；main 为元工具 + read。`decorateWorkerTool`（权限预审批包装）仍只作用于 worker/task 四件套基础工具，main 的 read 不装饰。
- **todo**：`features.todo` 开时 worker/task 注册 todo 工具；`runAgentInline` 构建 prompt 前 `foldTodos`，把该 agent 的清单段（order 1500）注入系统提示词。
- **skill**：装配层扫描出的清单经 `runtime.skills` 注入三角色 prompt（order 1400，只给 name/description/path）；worker/task 的 read 工具包一层追踪，命中 SKILL.md 时落 `skill/loaded`（每会话每文件一次）。
- **hooks**：`runtime.hooks` 贯穿 main/worker/task 的 `LoopConfig`；`executeCall` 触发 pre/post tool，`runMainTurn` 与 `runAgentInline` 在回合收尾触发 turn_end，CLI/server 装配时触发 session_start。
- **web 工具**：`runtime.webSearchBackend` 依 `settings.webSearch` 解析（duckduckgo 默认，可换 custom）；`features.webFetch`/`features.webSearch` 分别门控注册。

## 已知边界（留待后续里程碑）

- worker/task 内联 turn 的事件仍不透出主流：CLI 只能渲染 main 事件流与 spawn 标记行；子 agent 的过程事件全量落盘会话日志，经 server tailer 补发可在 web 端右侧面板实时观察（M3）。
- steer/inject 只做入队 + step 顶部轮询，无进程内唤醒；已排队消息在 abort 后是否保留由调用方决定（两队列崩溃恢复已由 `foldInbox` + `createInbox({seed})` 播种解决，M3）。

## 测试

- `test/m2-acceptance.test.ts`：M2 验收 1-5 场景级串联（全部从 `runMainTurn` 入口跑完整流）+ pollInbox 接线用例。
- 单点行为见 `main-turn.test.ts`（首轮提示词路由）、`plan-flow.test.ts`（plan 审批流）、`plan-detect.test.ts`（计划标记检测）、`spawn-tasks.test.ts`（并行调度/失败上报/abort）、`inbox.test.ts`、`runtime.test.ts`、`registries.test.ts`。

## MCP 支持（M4 Feature⑦）

`mcp/mcp.ts` 把 `settings.mcpServers` 配置的 MCP server 桥接为编排工具：

- **传输**：stdio（`command`/`args`/`env`，SDK `StdioClientTransport` 起子进程，stderr 走 inherit 便于排障）与 streamable HTTP（`url`/`headers` 经 `requestInit` 传入，`StreamableHTTPClientTransport`）。
- **连接**：`connectMcpServers` 逐 server try/catch，单 server 失败 warn + 跳过，不阻塞其余装配；连接超时默认 30s（`MCP_CONNECT_TIMEOUT_MS`），connect 与中止信号竞速，超时关闭 transport（stdio 会杀子进程）。连接层可注入（`createClient` 工厂），测试用 stub 保证 hermetic。
- **桥接**：`listTools` 结果转 `ToolDefinition`：命名 `mcp__<server>__<tool>`（server 名含空格等非法字符替换为 `_` 并 warn），description 透传，inputSchema 经 `json-schema-to-zod/json-schema-to-zod.ts` 子集转换（object/string/number/integer/boolean/array/enum；结构性不支持回退 `z.unknown()` 放行，顶层非 object 回退空对象 passthrough——保住「不拦」且 `declarations()` 顶层必须是 object）。
- **执行**：`client.callTool`，60s 超时（`AbortSignal.timeout`，与 `ctx.signal` 组合），content 的 text 块换行拼接（非 text 块以占位行保留），MCP `isError` 透传；`isConcurrencySafe: false`。
- **装配**：CLI（`packages/cli/src/chat.ts`）与 server（`packages/server/src/session-manager.ts`）在 `featureEnabled(features, "mcp")` 且 `settings.mcpServers` 非空时连接，工具经 `runtime.mcpTools` 只进 worker/task 注册表（main 为元工具 + read，外工具不进 main）；连接成功逐个落盘 `mcp/attached` 事件；CLI REPL 结束 finally / `manager.close()` 里 `closeMcpConnections` 统一关闭。

### 手工冒烟（不进自动化）

需要网络（npx 首次下载 server 包）与本机 Node。步骤：

1. 用户级配置 `~/.hotpot/settings.json` 增加 `mcpServers`（stdio 用 everything 参考 server）：

   ```json
   {
     "mcpServers": {
       "everything": {
         "command": "npx",
         "args": ["-y", "@modelcontextprotocol/server-everything"]
       }
     }
   }
   ```

   HTTP 形态对照：`"demo-http": {"url": "http://localhost:8080/mcp", "headers": {"authorization": "Bearer <token>"}}`。

2. 启动 CLI：`pnpm dev cli chat`。启动行应打印 `[mcp] attached: everything (stdio) — N tools`，随后 worker 的工具清单里出现 `mcp__everything__echo`、`mcp__everything__add` 等（模型可用即证明注册成功）。

3. 让 agent 调用一个 MCP 工具（如 "用 mcp__everything__add 计算 2+3"），`[tool_result]` 应显示远端返回的文本。

4. 检查会话 JSONL：文件里有一条 `mcp/attached` 事件（`server`/`transport`/`tools` 字段齐全）。

5. 进程退出（`/exit`）后确认无遗留子进程：`ps aux | grep server-everything` 应为空（stdio 子进程随 `closeMcpConnections` 被 SIGKILL）。

验收点：配置真实 attach 成功、失败 server（如把 command 改成不存在的可执行文件）只告警不阻塞启动、工具命名符合 `mcp__<server>__<tool>`。
