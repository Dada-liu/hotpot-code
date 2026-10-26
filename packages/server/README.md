# @hotpot/server

M3 服务层：在 cli 与 orchestrator 之上提供 REST + SSE API，负责会话管理、事件推送与断线重连（重连时按 seq 从 wire ring buffer 增量补发，掉出留存窗口后降级为 JSONL 全量重放）。依赖方向 `server → orchestrator → core → ai`；遥测经 `@hotpot/telemetry` 旁路上报（`server → telemetry → core`）。

## 当前已实现

- **`createTailer` JSONL 日志 tailer**（`src/tailer.ts`）：事件总线的基础。
  - `start()` 先补读历史（`fromOffset`，默认 0）整批回调，再进入跟随模式；
  - 跟随：`fs.watch` 触发增量读 + `pollIntervalMs`（默认 250）轮询文件大小兜底；
  - 只读新增字节：空行与 `JSON.parse` 失败的坏行跳过；末尾无换行的半行留待下次拼接（写入中途被杀不掉数据）；
  - `offset()` 返回已消费字节数（半行不算），tailer 调用方可把它作为新 tailer 的 `fromOffset` 续读；SSE 客户端重连不携带这个字节 offset，而是携带 wire `seq`；
  - `stop()` 清除 watch 与轮询；原地再 `start()` 从上次 offset 续读；`fs.watch` 报错自动降级为纯轮询，不抛给调用方。
- **UI 事件协议与总线**（`src/wire.ts`）：`WireEvent` 七事件联合（`log`/`delta`/`turn`/`plan`/`spawn`/`approval`/`permission`，全部带会话内单调 `seq`）；`createWireHub` 分配 seq 并留存 ring buffer（上限 2000，超出丢最旧），供订阅重放（`buffer()`）与断线增量（`tailAfter()`）。
- **审批桥**（`src/approvals.ts`）：`createApprovalBridge(notify)` 把审批询问转成「入 pending 表 → 广播 approval 事件 → 返回 parked promise」；`answer(requestId)` 按 id 应答，`answerPendingPlan` 应答唯一挂起的 plan 询问。
- **usage 统计**（`src/usage.ts`）：`summarizeUsage(events)` 折叠 `assistant_msg.usage`，产出 total/byTier（含条数 count）/byAgent。
- **会话管理器**（`src/session-manager.ts`）：`createSessionManager({home, llm?, warn?})`。
  - 回合装配镜像 `cli/src/chat.ts` 的 runChat（tier 解析、审批链 + 审计落盘——full 模式链头 `allowAllHandler`、其余模式挂桥 handler；`createPermissionModeDecorator` 权限动态分派的 worker 工具预审批、`createRuntime` + `llm` 覆盖 `resolveModel`、`createInbox` + `foldInbox` 播种、followup 补发循环）；
  - turn 串行化：每会话一条 `turnTail` promise 链，`send` 排队执行；
  - 事件转发架构规则：durable 事件只由 tailer 推 `log`；迭代器只转发瞬态 `delta`/`spawn`/`plan`，`done`/`error` 收敛为回合级一次 `turn(end)`；delta 前、plan 前与 `turn(end)` 前做 durable 水位同步（`wrapAppend` 计数 + `syncDurable`），plan 事件携带 `messageIds` 供 web 隐藏重复的计划正文；
  - 广播顺序不变量：每会话一条 emit 管道分配 seq，同步 fan-out 到各订阅者 FIFO（重放先于 live 到达）；
  - `create`/`attachById`/`get`/`list`/`send`/`steer`/`cancel`/`answerToolApproval`/`answerPlan`/`subscribe`/`usage`/`close`。
- **静态托管**（`src/static.ts`）：`mountStatic(app, {webDist?, publicDir?})`，零依赖（`node:fs` 自读）。
  - webDist（默认按 `import.meta.url` 定位 `<仓库根>/packages/web/dist`）：产物文件（`/assets/*` 等）按扩展名给 Content-Type；`/` 与任意非 `/api` 路径的 GET 回退 `index.html`（SPA 兜底）；
  - publicDir（默认 `<仓库根>/public`）：`/<文件名>` 原样直出；
  - 两个目录都不存在时不挂任何路由（纯 API 模式）；`/api` 前缀永不进静态路由，URL 路径规范化后拒绝逃逸根目录。
- **REST + SSE 路由**（`src/app.ts`）：全部路由挂 `/api/sessions*`；`GET /:id` 与 `events`（SSE）等单会话路由经共享的 `requireSession` 解析——内存 managed 表未命中时降级 `attachById` 恢复磁盘会话（CLI 创建的会话同样可打开），attach 也未命中才 404。`DELETE /:id` 删除会话：运行中 409（先取消再删）；删除 = close 收尾（拒决未决审批/停 tailer/摘 managed/关 MCP）+ 删磁盘日志，之后任何入口均 404。`POST /:id/archive` 归档会话：结束运行中的回合（abort + 拒决未决审批 + 不再消费队列）并等回合链落定（日志与遥测全部落盘）后摘托管；会话保留在磁盘列表中，可随时重新打开。
- **`startServer` 启动装配**（`src/serve.ts`）：SessionManager + Hono app + 静态托管 + `@hono/node-server` 监听的可复用接线；`hotpot-server` bin 与发布包 `hotpot web` 共用。默认仅监听 `127.0.0.1`，端口取参数或 `HOTPOT_PORT`（默认 4573），静态目录可用参数或 `HOTPOT_WEB_DIST`/`HOTPOT_PUBLIC_DIR` 覆盖。每次启动生成随机 API token，也可由非空 `HOTPOT_API_TOKEN` 固定；REST 使用 Bearer 认证，SSE events 使用 `access_token` 查询参数，静态资源无需认证。
- **模型设置**（`src/settings-store.ts`）：`GET /api/settings` 只返回固定 apiKey 掩码，不返回字面值或 `$ENV` 引用；PUT 中仍为掩码的档位保留磁盘原密钥，其他非空值明确替换，其他设置字段不变。
- **`hotpot-server` bin**（`src/bin.ts`）：调用 `startServer` 并打印带 `?token=` 的实际启动地址，供源码仓库开发态使用。

## M4 增量

- **装配扩展**：`assemble()` 按 `settings.features` 装配 M4 能力——扫描 skill / prompt template 目录、连接 MCP server（成功落 `mcp/attached`）、构造 hooks 链并触发一次 `session_start`；功能开关、`webSearch` 后端与附件配置全部经 `createRuntime` 透传。
- **prompt templates**：`send()` 对 `/name args` 统一展开并落 `prompt/invoked`；未知命令抛 `PromptCommandError`，REST 转 400（消息不进入回合）。
- **新增路由**：`GET /api/sessions/:id/prompts`（`/` 补全列表）、`GET /api/sessions/:id/inbox`（steer/queue 两队列快照）。
- **usage 扩展**：`summarizeUsage(events, features)` 增加 `features` 段（todo/hooks/skills/promptTemplates/webSearch/webFetch/mcp 的开关 + 事件/工具调用计数），满足 M4 遥测验收；M5 报表直接消费。
- **hooks 生命周期**：`session_start` 在装配完成时触发；pre/post tool 与 turn_end 由 core / orchestrator 的回合路径触发，server 只负责装配与关闭。

## M5 增量

- **遥测旁路**：`createSessionManager` 用用户级 settings 装配一次 `createTelemetryRuntime`（`telemetryFetch` 为测试注入缝）。运行时为 null（`telemetry.enabled === false`，或 endpoint 为空/非法）时所有上报点直接跳过。
  - `create` 上报 `session_start`（`resumed: false`，时长为会话 `createdAt` 起算），`attachById` 上报 `session_start`（`resumed: true`，时长为挂接时刻起算）；
  - `runOneTurn` 每回合一个采集器：入队 `turn_start`，逐事件 `observe`（`plan.phase === "denied"` 记为计划被拒），在复位 `currentAbort` 的同一 `finally` 中折算 `turn_end` 并入队、随后异步 `flush`；
  - `close(id)` 在从 managed 摘除前上报该会话的 `session_end`（本会话累计 turn/error 数，flush 不 await，关闭路径不被网络重试拖住）；
  - 采集与上报异常全部吞掉，永不阻塞或失败一个回合。

## W2 增量

- **工作区注册表接入**：`SessionManager` 首次使用时懒打开 `openWorkspaceRegistry({ home })`（工厂仍同步），提供 `listWorkspaces` / `createWorkspace` / `renameWorkspace` / `removeWorkspace` / `reorderWorkspaces` / `createInWorkspace` 与 `pickDirectory` 薄封装；`WorkspaceError` 统一映射为 `SessionApiError`（invalid-path/title/order → 400，not-found → 404，name-conflict → 409，invalid-storage → 500）。
- **新增路由**：`GET /api/workspaces`、`POST /api/workspaces`、`PATCH /api/workspaces/:id`、`DELETE /api/workspaces/:id`、`PUT /api/workspaces/order`、`POST /api/directory-picker/pick`（取消 200 `{path:null}`，无后端 501 `{code:"picker-unavailable"}`，超时 504）。
- **会话归属**：`POST /api/sessions` body 改为 `{cwd?, workspaceId?}`（互斥）；`workspaceId` 用注册表记录的 canonical 路径建会话并 attach；显式 `cwd` 命中已注册工作区时自动归属。删除会话后 detach，归档保留归属。
- **原生目录选择器**：`src/directory-picker.ts` 支持 macOS `osascript`、Windows PowerShell `FolderBrowserDialog`（`-STA`）与 Linux `zenity`/`kdialog`；可注入 `platform`/`timeoutMs`/`spawnFn` 供单测，默认 120s 超时后 kill 子进程。

## 目录

```
src/
  index.ts             包入口：re-export 全部公开模块
  bin.ts               hotpot-server 启动入口（REST + SSE + 静态托管）
  serve.ts             startServer 启动装配（bin 与发布包 hotpot web 共用）
  app.ts               HTTP 路由（REST + SSE，requireSession 共享解析）
  directory-picker.ts  系统原生目录选择器（macOS/Windows/Linux）
  tailer.ts            JSONL 会话日志 tailer（createTailer）
  wire.ts              UI 事件协议（WireEvent）与 seq 总线（createWireHub）
  approvals.ts         审批桥（pending 表 + parked promise）
  usage.ts             usage 折叠统计（summarizeUsage）
  session-manager.ts   会话管理器（createSessionManager）
  settings-store.ts    模型设置读写（apiKey 掩码与安全保存）
  static.ts            静态托管（mountStatic：web 产物 + 根 public/）
  node-builtins.d.ts   Node 内置模块的最小 ambient 声明（禁 @types/node，超集自 core）
test/
  tailer.test.ts              补读/坏行/半行/stop/offset 续读用例
  session-manager.test.ts     事件顺序/spawn/审批/plan/串行/attach/usage 集成用例
  serve.test.ts               默认回环监听、REST/SSE 认证与静态免认证
  api.test.ts                 REST/SSE 集成用例（真实端口 + fetch + SSE 流式消费）
  directory-picker.test.ts    原生选择器平台分支/取消/回退/超时用例（假 spawn）
  static.test.ts              纯 API 模式/SPA 兜底/资产 MIME/public 直出用例
  telemetry.test.ts           遥测上报（turn/session 事件、无对话文本、关闭旁路）用例
```
