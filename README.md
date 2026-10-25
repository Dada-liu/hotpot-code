<p align="center">
  <img src="public/logo.png" alt="hotpot-agent logo" width="160" />
</p>

<h1 align="center">hotpot-agent</h1>

<p align="center">
  中文 | <a href="README.en.md">English</a>
</p>

基于 Node + TypeScript 的 code agent。目标：更低的成本、更好的效果。

## 安装

```bash
npm install -g hotpot-agent
```

npm 包名是 `hotpot-agent`，安装后的命令是 `hotpot`。要求 Node >= 22。

## 架构

```
┌───────────────────────────────────────────────────────────────────────────┐
│ 【接入层】                                                                │
│   packages/web    React SPA 三栏界面（会话列表 / 对话流 / agent 状态面板）│
│   packages/cli    行式交互入口                                            │
├───────────────────────────────────────────────────────────────────────────┤
│ 【服务层】                                                                │
│   packages/server REST + SSE 服务层（会话管理、日志补发、静态托管）       │
├───────────────────────────────────────────────────────────────────────────┤
│ 【编排层】                                                                │
│   packages/orchestrator                                                   │
│     三层 agent 编排：main 难度路由 → worker 执行/并行拆分 → task 原子任务 │
│     plan 先审后执行、steer/queue 双队列                                   │
├───────────────────────────────────────────────────────────────────────────┤
│ 【核心层】                                                                │
│   packages/core                                                           │
│     turn/step 两级循环、工具三面分离、审批 waterfall                      │
│     会话 JSONL 事件日志为唯一事实源                                       │
├───────────────────────────────────────────────────────────────────────────┤
│ 【适配层】                                                                │
│   packages/ai                                                             │
│     api×provider 二维协议适配（anthropic-messages / openai-completions）  │
│     SSE 流式解析、模型目录、用量统计                                      │
└───────────────────────────────────────────────────────────────────────────┘
```

依赖方向严格自上而下（`server → orchestrator → core → ai`；`cli` 与 `server` 同为 orchestrator 之上的入口，`web` 不引 workspace 包、构建产物由 server 托管），禁止反向依赖。另有旁路包 `packages/telemetry`（`cli`/`server` → `telemetry` → `core`），只做匿名指标上报，不进入 agent 主链路；开发工具 `benchmarks/`（根级目录，与 `packages/` 并列）复用 core/orchestrator/telemetry 跑批，但不被 `cli`/`server` 引用，也不进入工具产物。

一次用户消息的数据流：cli → `runMainTurn`（首轮提示词难度路由）→ worker / task 内联跑 core `runTurn` → 每个 step 由 `deriveMessages` 从会话日志转换历史 → `ai.streamChat` → 工具批次经审批 waterfall 执行 → 全部事件 append 进 JSONL 并流回 cli 渲染。

## 目录结构

```
├── AGENTS.md          # 开发约定（英文）
├── AGENTS_zh-CN.md    # 开发约定（中文备份）
├── docs/              # 项目文档（md 即代码）
│   ├── PRD.md         # 定稿产品需求文档（权威需求来源）
│   ├── archive/       # 设计探讨归档：需求/架构/编排/里程碑
│   └── superpowers/   # 实现计划
├── packages/          # 代码（pnpm monorepo）
│   ├── ai/            # @hotpot/ai：LLM 协议适配与模型目录
│   ├── core/          # @hotpot/core：会话日志、turn 循环、工具与审批
│   ├── orchestrator/  # @hotpot/orchestrator：三层编排（spawn_workers/spawn_tasks、plan 审批、inbox）
│   ├── server/        # @hotpot/server：REST + SSE 服务层（会话管理、日志补发、审批桥、静态托管）
│   ├── web/           # @hotpot/web：React SPA（三栏界面、agent 状态面板）
│   ├── cli/           # @hotpot/cli：行式交互入口
│   ├── hotpot-agent/  # hotpot-agent：npm 发布包（hotpot 命令 + Web 产物）
│   └── telemetry/     # @hotpot/telemetry：M5 匿名遥测客户端（事件 schema、脱敏、批量上报）
├── benchmarks/        # @hotpot/benchmarks：M5 benchmark runner（SWE-bench 官方评测 + 自建题三类）
└── scripts/           # 开发辅助脚本（pnpm dev 等）
```

## 常用命令

```bash
pnpm install          # 安装依赖
pnpm build            # 构建 Web 并打包 npm 发布包
pnpm test             # 跑全部测试（vitest，packages/*/test/**/*.test.ts）
pnpm typecheck        # 所有包 tsc 类型检查
pnpm pack:npm         # 在 artifacts/ 生成 npm tarball
pnpm publish:npm      # 发布 npm tarball（需先 npm login）
pnpm bench --help     # benchmark runner：SWE-bench 官方评测 / 自建题三类
pnpm dev <pkg> [args] # tsx 直跑包入口，如 pnpm dev cli chat
pnpm dev web          # 构建并启动 Web 端（默认 4573 端口，启动后自动打开浏览器）
pnpm exec biome check # lint + format 检查
```

web 产物构建与开发：`pnpm --filter @hotpot/web build` 后由 server 直接托管；开发态跑 `pnpm --filter @hotpot/web dev`（Vite dev，把 `/api` 代理到 4573）。

## 当前状态

M1 已完成：终端里跑通「对话 → 工具调用 → 完成任务」最小闭环（脚本化验收见 `packages/cli/test/acceptance.test.ts`，验收标准见 `docs/archive/04-roadmap.md` M1 节）。

M2 已完成：三层编排（main 难度路由 → worker 执行/并行拆分 → task 原子任务）、plan 先审后执行、steer/queue 双队列（场景级验收见 `packages/orchestrator/test/m2-acceptance.test.ts`，验收标准见 `docs/archive/04-roadmap.md` M2 节）。

M3 已完成：Web 端交付——`packages/server`（REST + SSE，默认 4573 端口，断线重连从日志补发、CLI 与 web 可同时观察同一会话）+ `packages/web`（React SPA：会话列表、流式对话、工具卡片、plan 审查、审批、steer/中断、用量展示、右侧面板 agent 工作状态）。测试见 `packages/server/test/`（api / session-manager / tailer / static）与 `packages/web/test/`，验收标准见 `docs/archive/04-roadmap.md` M3 节。

M5 已完成（本仓库部分）：`packages/telemetry` 匿名遥测客户端（cli/server 接入、事件白名单、脱敏、批量重试）+ `benchmarks/` benchmark runner（SWE-bench 实例导出/选择、普通 checkout + worktree、无交互 agent、predictions、官方 `swebench` harness 编排、报告、`benchmark_run` 遥测、自建题三类）。用法见 `benchmarks/README.md`；自建题沉淀流程见 `docs/benchmark-authoring.md`；Lite 10 题验收记录见 `docs/archive/04-roadmap.md` M5 节。遥测后台是仓库外独立项目 `../hotpot-telemetry/`，不进入工具产物。

M6 已完成：Web 端交互完善——运行中发送默认进入 next-turn 队列（QueueBar 固定在输入框上方；点击条目转 steer 注入、✕ 移除，消费即落盘，重开不会重复执行）；工作区是一等实体（`~/.hotpot/workspaces.json` 持久化注册表：路径/标题/会话归属/顺序），侧栏按工作区分组、组内新建会话、重命名/删除/拖拽排序，新增工作区走系统原生目录选择器（macOS `osascript`、Windows `FolderBrowserDialog`、Linux `zenity`/`kdialog`，不可用时降级手填路径）；权限三档（只读/工作区修改/完全权限，按审批策略实现，composer 内实时切换并持久化）；composer 支持 `/` 内置指令（`/help`、`/permission`）与 prompt 模板、➕ 文本附件上传、`@` 工作区文件提及（main agent 新增 read 工具按引用读取）。

运行方式：

1. 配置 `~/.hotpot/settings.json`（三档模型必填；`apiKey` 可写字面值，或 `"$VAR"` 引用环境变量）：

   ```json
   {
     "models": {
       "high": { "provider": "anthropic", "model": "claude-sonnet-4-5", "apiKey": "$ANTHROPIC_API_KEY" },
       "medium": { "provider": "openai", "model": "gpt-4.1", "apiKey": "$OPENAI_API_KEY" },
       "low": {
         "provider": "deepseek",
         "model": "deepseek-chat",
         "apiKey": "$DEEPSEEK_API_KEY",
         "baseUrl": "https://api.deepseek.com/v1"
       }
     }
   }
   ```

   内置目录模型的协议自动选择（anthropic→anthropic-messages，其余→openai-completions）；`baseUrl` 可省略，默认走各家官方端点（openai 系默认 `https://api.openai.com/v1`，deepseek/moonshot 等第三方端点需显式填写）。项目级可在 cwd 向上任一目录放 `.hotpot/settings.json` 覆盖非凭证白名单字段（`mainAgentTier`/`maxParallelTasks`/`planMaxRevisions`/`permission.mode`），凭证只从用户级读取。

2. 命令行入口为 `hotpot`（安装后直接可用；源码仓库开发态：`pnpm dev cli chat`），启动行式对话：`/exit` 退出，Ctrl-C 中断当前回合；高危命令与覆盖写会询问 `y/n` 审批（默认 n）。
3. 会话以 JSONL 落盘在 `~/.hotpot/sessions/`；`hotpot chat --session <会话文件路径>` 恢复历史继续对话（源码仓库开发态：`pnpm dev cli chat --session <会话文件路径>`）。
4. Web 端：安装后运行 `hotpot web` 一键启动（默认 http://127.0.0.1:4573，就绪后自动打开浏览器；同一 settings 配置，会话与 CLI 互通）；源码仓库开发态运行 `pnpm dev web`。开发态改前端时另开 `pnpm --filter @hotpot/web dev`，Vite 将 `/api` 代理到 4573。

## 发布 npm 包

发布包位于 `packages/hotpot-agent`，构建后只包含 `dist/`（单文件 CLI + Web 产物）。发版步骤：

1. 同步版本号：`packages/hotpot-agent/package.json` 与 `packages/telemetry/src/defaults.ts` 的 `APP_VERSION`。
2. 在 GitHub 仓库 Settings → Secrets and variables → Actions 添加 `NPM_TOKEN`。该 token 必须具备 publish 权限，并且能绕过 2FA（npm Automation token，或在 granular token 中勾选 bypass 2FA）；普通 token 会在发布会报 `EOTP`。
3. 提交后打 tag 并推送：

   ```bash
   git tag v0.1.1
   git push origin main --tags
   ```

   `.github/workflows/publish.yml` 会校验 tag 与包版本一致，依次运行 check / typecheck / test / build，然后带 provenance 发布到 npm。
   如果 token 只能 staged publish，或 npm 账号启用了 staged publishing，工作流会先把版本放入 Staged Packages；需要维护者在 npmjs.com 用 2FA 点击 Approve 后才会公开。
4. 本地手动发布：先 `npm login`，再执行 `pnpm publish:npm`。

`artifacts/` 是本地 tarball 目录，不提交。发布产物只包含 `dist/bin.js`、`dist/web/**`、`README.md` 与 `LICENSE`。

## 已知问题（TODO）

- **掉窗全量重连后 composer 的回合状态无法重建**：`turn(start/end)` 是瞬态 wire 事件不落盘，掉窗全量重放（`loadSession` 路径，见 `packages/server/src/session-manager.ts` 的 `subscribeResuming`）只重放 durable 日志。后果：① 繁忙会话（事件超出 hub 2000 条留存窗口）运行中刷新页面，客户端 `turn` 停在初始 `idle`——composer 显示普通发送模式，没有队列条与取消按钮；服务端仍以 `holder.running` 为准把发送排入 next-turn（不会误跑新回合），但排队消息在下次快照刷新前不可见、也无法取消；② 断线错过 `turn(end)` 且掉出窗口后，客户端 `turn` 卡在 `running`——composer 显示排队提示与取消按钮，而服务端实际空闲，发送会正常开启新回合（取消按钮为无效展示）。修复方向：订阅对账时以 `holder.running` 为权威，向本订阅者 `hub.replay` 合成缺失的 `turn(start/end)`（sink-only，模式 B，参考已移除的旧合成 `turn(end)` 机制）。关联缺口：plan 审批等待态同样依赖瞬态 `plan`/`approval` 事件，掉窗重连后审批入口不恢复（服务端 parked promise 仍在等待）。待排期修复。

