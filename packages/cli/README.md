# @hotpot/cli

行式交互入口 `hotpot chat`（M2 三层编排的用户界面）。

## 架构

```
┌──────────────────────────────────────────────────────────────────────────┐
│ bin.ts — 可执行入口（package.json bin.hotpot；开发期 pnpm dev cli chat） │
├──────────────────────────────────────────────────────────────────────────┤
│ chat.ts — runChatCli 行式循环：读输入 → runMainTurn → 流式渲染事件       │
├──────────────────────────────────────────────────────────────────────────┤
│ approval-ui.ts — 工具审批 y/n 终端交互                                   │
│ plan-approval.ts — plan 终端审阅（y / 批注 / n）                         │
│ （两者共享 chat.ts 的 ChatInput / ChatOutput 类型）                      │
└──────────────────────────────────────────────────────────────────────────┘
```

本包只做终端 IO、参数解析与渲染，agent 逻辑全在 core / orchestrator：编排入口 `runMainTurn` / `runPlanPhase`，配置经 `loadSettings`（core）。worker / task 事件不透出主流，结果经 tool_result 摘要回到终端。

- `src/bin.ts` 可运行入口（package.json 的 `bin.hotpot` 指向它），开发时用根目录 `pnpm dev cli chat` 经 tsx 直跑。
- `src/index.ts` 包入口：re-export `runChatCli` / `parseChatArgs`，供 npm 发布包 `hotpot-agent` 打包调用。
- 行式交互循环：输入消息 → `runMainTurn` 编排（main 首轮提示词判定：trivial 直答、simple 首轮 spawn_workers 派 worker 内联执行、complex 首轮产出计划等审批）→ 流式打印文本 → `[spawn] worker-1 (tier=low): <task>` 展示子 agent 诞生 → `[tool] name(参数摘要)` / `[tool_result]` 展示 main 的工具调用 → `[plan] drafted/approved/denied` 展示计划审批流；`/exit` 退出，Ctrl-C 中断当前回合而不退出进程。
- 文件操作全在 worker/task 层：worker 瞬态事件不外传，其结果经 `spawn_workers` 的 tool_result 摘要回到终端（收尾落盘的 `agent_end` 仅供 web 面板消费，终端渲染忽略）；危险 command/write 审批询问在 worker 工具执行内触发，终端交互与 M1 一致，且 asked/decided 经 `createAuditedApprovalChain` 落盘会话日志。权限三档 `permission.mode`（`readonly`/`workspace`/`full`，默认 `workspace`）作用于 worker 工具链：`readonly` 时经 runtime 的 `decorateWorkerTool` 通道给非 read 工具逐个包预审批；`workspace` 仅危险操作询问；`full` 链头 `allowAllHandler` 全部自动放行。
- complex 流的 plan 审批在终端就地审阅：打印 plan 全文，输入 `y` 批准、`n` 拒绝、其他非空行批注（进入修订循环）、空行/EOF 拒绝（fail-closed）；`planMaxRevisions` 从 settings 透传。
- steer/queue 双队列：turn 结束后 drain next-turn 队列、按序补发为新用户消息；next-step 消息经 `runMainTurn` 的 inbox 接线在每个 step 顶部注入模型历史；Ctrl-C 同时 abort 当前回合的 AbortController 与 `inbox.cancel()`。
- `hotpot chat [--session <path>] [--tier high|medium|low]`；`--tier` 是主 agent 档，默认取 `settings.mainAgentTier`，再默认 `high`。`--session` 恢复会话（`resumeSession` 追加到同一文件，`runTurn` 内部 `loadSession` + `deriveMessages` 重建 main 历史，worker 事件按 agentId 过滤）。
- 配置经 `@hotpot/core` 的 `loadSettings({ cwd })` 双层读取：用户级 `~/.hotpot/settings.json`（`HOTPOT_HOME` 可覆盖，三档模型与凭证必填）+ 项目级 `.hotpot/settings.json`（自 cwd 向上查找、可选，只覆盖非凭证白名单字段）；真实适配器由 `@hotpot/orchestrator` 的 `resolveModel` 按 `ModelRef` 的 provider→api 映射选择，未知模型按 provider 名推断协议并告警（contextWindow 取 128000）。

当前状态：M2 编排接入已完成（Task 11）：`runChat` 主干走 `runMainTurn`，plan 终端审批见 `src/plan-approval.ts`，测试（含 M1 验收场景的编排流迁移版）见 `test/`。

## M4 增量

- **prompt templates**：启动时扫描 `settings.promptsDirs` + `<home>/prompts` + `<cwd>/.hotpot/prompts`；输入 `/name args` 命中模板则展开（`$ARGUMENTS`/`$1..$9`）、落 `prompt/invoked` 再跑回合；未知 `/` 命令提示可用列表。`features.promptTemplates` 关闭时 `/` 按普通消息处理。
- **hooks**：按用户级 `settings.hooks`（Claude Code 格式）构造生命周期链，装配完成触发 `session_start`；pre/post tool 与 turn_end 由 core/orchestrator 触发。
- **skill**：启动扫描 `<home>/skills`、`<cwd>/.hotpot/skills` 与 `skillsDirs`，清单注入三角色提示词（渐进式，模型按需 read）。
- **MCP**：按 `settings.mcpServers` 连接（stdio/HTTP），`[mcp] attached: ...` 提示，工具桥接为 `mcp__<server>__<tool>`；退出时关闭连接。
- **todo / web 工具**：由 orchestrator 按 `features.*` 注入 worker/task，CLI 无需额外接线。
