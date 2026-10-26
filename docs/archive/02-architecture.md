# 02 总体架构

> 本文档描述系统分层、包划分、关键数据流、存储格式与配置体系。
> 技术方案调研参考了两个同类项目：`pi`（@earendil-works 的 monorepo code agent）和 `deepseek-harness`（简称 dsh，插件化 agent harness）。借鉴点与不借鉴点见第 7、8 节。

## 1. 技术选型

| 项 | 选型 | 理由 |
|----|------|------|
| 语言/运行时 | Node >= 22 + TypeScript | PRD 要求；pi 与 dsh 均如此 |
| TS 约束 | erasable-syntax-only，源码间用 `.ts` 后缀 import | AGENTS.md 硬性规则；pi 同款配置（`erasableSyntaxOnly` + `rewriteRelativeImportExtensions`） |
| 开发期运行 | Node strip-only 直接跑 TS（可用 tsx） | pi/dsh 都是零编译开发体验，tsc/tsup 只用于发布 |
| 包管理 | pnpm monorepo | dsh 同款；多包共享类型 |
| 构建发布 | tsup（发布时才用） | 将 workspace 源码打成单文件 CLI，并复制 Web 产物 |
| 测试 | vitest | pi/dsh 均使用 |
| lint/format | biome | pi 在用，lint+format 一体（dsh 用 oxlint，功能重合，二选一即可） |
| 工具 schema | zod | pi 用 typebox、dsh 用自研 DSL（过重）；zod 生态成熟，可转 JSON Schema |
| 前端 | React + Vite | dsh 的 apps/web 同款 |
| 后端 | Hono（HTTP + SSE） | 轻量、SSE 支持好；dsh 用裸 node http + ws，Hono 更省开发量 |

## 2. 分层架构

```
┌─────────────────────────────────────────┐
│  packages/web    (React SPA)            │
│  packages/cli    (终端入口，M1 唯一界面)  │  接入层：只负责 IO 渲染与用户输入
├─────────────────────────────────────────┤
│  packages/server (HTTP + SSE API)       │  服务层：会话管理、事件推送（M3 引入）
├─────────────────────────────────────────┤
│  packages/orchestrator                  │  编排层：三层 agent、plan 模式、
│                                         │        human-in-the-loop、任务队列
├─────────────────────────────────────────┤
│  packages/core                          │  核心层：agentic loop、系统提示词、
│                                         │        工具系统、会话事件日志
├─────────────────────────────────────────┤
│  packages/ai                            │  适配层：provider 无关 LLM 接口、
│                                         │        流式、tool calling、用量统计
└─────────────────────────────────────────┘
```

依赖方向严格自上而下，禁止反向依赖。`core` 不感知编排，`orchestrator` 不感知 HTTP。

## 3. 包划分

### packages/ai — LLM 适配器
- **api × provider 二维适配**（借鉴 pi）：抽象轴是「协议」（anthropic-messages、openai-completions），provider = 协议 + baseUrl + 凭证的组合。M1 只实现这两个协议，即可覆盖 Anthropic / OpenAI / DeepSeek / Kimi 等
- 统一接口：`streamChat(messages, tools, options) → AsyncIterable<StreamEvent>`
- StreamEvent 类型：`block_start / text_delta / reasoning_delta / tool_call_delta / block_end / usage / finish(reason: stop|tool_calls|max_tokens|aborted|error)`（借鉴 dsh 的 StreamChunk 形状）
- 结构化错误：统一错误类型含机器码、HTTP status、`retryAfter`；模型请求的指数退避重试尚未实现，`retryAfter` 目前只透传给上层
- 模型元数据 catalog：`contextWindow`、`maxTokens`、`reasoning 档位`、`cost`；M1 手写少量模型常量即可，不做 pi 那种 40+ provider 的生成管线

### packages/core — agent 核心
- **turn/step 两级循环**（借鉴 dsh）：turn = 一次用户意图的完整处理；step = 一次 LLM 请求 + 它触发的工具批次。无新工作时 turn 关闭
- **消息历史 = 会话日志投影**（借鉴 dsh/pi，最重要的一个决策）：不维护游离的内存消息数组。所有状态（消息、工具结果、系统提示词变更、队列变更）都是 append-only 事件日志里的条目，调 LLM 前由 `deriveMessages()` 从日志折叠出模型可见历史。不变量：**模型可见 ⟺ 已记录**。恢复、回放、审计、调试由此免费获得
- 中断：AbortSignal 贯穿流式请求与每个工具执行；被中断的 assistant 消息把已收到的前缀落盘并标记 `interrupted: true`，不伪造历史
- 防御细节（借鉴 pi）：`finish reason === max_tokens` 的消息，其 tool call 全部判失败不执行（参数可能被截断）
- 系统提示词：**section 注册表**（借鉴 dsh/pi）——每段有 name + order，插件/功能模块注册自己的段；集中分配 order 常量；英文撰写，组装逻辑有单元测试
- 工具系统：
  - 接口三面分离（借鉴 dsh）：`execute(args) → 结构化结果（lossless JSON）`；`render(result) → 给模型的内容`（纯函数）；`present(args, result) → 给 UI 的展示投影`（纯函数）
  - 内置 bash / read / write / edit
  - 权限钩子：工具执行前 waterfall 审批链（借鉴 dsh `approval/asked|decided` 审计事件对）；高危命令确认、沙箱都挂在这条链上
  - 工具可声明 `isConcurrencySafe`，同批 tool call 默认并行，不安全的串行（借鉴 dsh/pi）

### packages/orchestrator — 三层编排
- MainAgent / WorkerAgent(从) / TaskAgent(子)，复用 core 的 turn/step 循环，差异在系统提示词与可用工具集
- 难度评估 + 模型路由、plan 生成与审批、任务拆分与并行调度
- steer/queue 双队列（见 03 文档第 7 节）
- 详见 `docs/03-agent-orchestration.md`

### packages/server — API 服务（M3）
- REST：会话 CRUD；SSE：事件推送（含断线重连后从日志补发）
- POST 消息 / 审批决定 / steer 指令

### packages/web — 前端（M3）
- 会话列表页、对话页（流式渲染 markdown）、工具调用卡片、plan 审查面板、用量展示

### packages/cli — 终端入口（M1 唯一界面）
- 最小可用：直接对话、恢复会话、审批交互
- 不引入自研 TUI 库（pi 自研 TUI 是一个包的工作量，过重）；M1 用行式交互即可

### packages/telemetry — 匿名遥测客户端（M5.1）
- 旁路包：`cli` 与 `server` 依赖 `@hotpot/telemetry`，后续 `benchmarks` runner 复用（`kind: "benchmark"`）；workspace 依赖只有 `core`（复用 `resolveHome`、`loadSession`、`featureEnabled`），外部依赖仅 `zod`，不依赖 `orchestrator`/`server`/`cli`
- 事件 schema v1：九类事件（`session_start`/`session_end`/`turn_start`/`turn_end`/`llm_call`/`tool_call`/`error`/`feature_usage`/`benchmark_run`）严格白名单，zod `.strict()`，未知字段直接拒绝
- 错误消息统一经 `sanitizeErrorMessage` 脱敏；客户端异步批量 POST、失败指数退避、定时器 unref，绝不阻塞或让 turn 失败
- 开关与 endpoint：`settings.telemetry` > `HOTPOT_TELEMETRY_ENDPOINT` > 源码常量；settings 中的空值/空白继续回退，最终为空或非 http(s) 地址视为未启用（空环境变量会遮挡源码常量）
- 安装 ID：`<home>/telemetry/install-id`（benchmark 使用独立文件），不关联账号或机器名
- 详见 [packages/telemetry/README.md](../../packages/telemetry/README.md)

## 3.1 模块目录约定（core / orchestrator）

`packages/core` 与 `packages/orchestrator` 的 `src/` 采用「一个特性一个子文件夹」：

- 特性文件夹自带 `index.ts`（该特性的对外 barrel）、实现文件、`README.md`（中文）与 `AGENTS.md`（英文）。
- `src/` 根目录只保留包入口 `index.ts` 与 `node-builtins.d.ts`；包入口只做 re-export，不写逻辑。
- 跨特性调用按具体文件路径导入，不互相引用特性 `index.ts`，避免 barrel 循环依赖。
- 包对外 API 保持不变，接入层（cli/server/web）仍从 `@hotpot/core` / `@hotpot/orchestrator` 根入口导入。

```text
packages/core/src/
├── index.ts                 # 包入口，仅 re-export
├── node-builtins.d.ts
├── agent/                   # turn/step 循环
├── approval/                # 审批 waterfall 与审计包装
├── config/                  # 双层 settings 加载
├── frontmatter/             # 最小 frontmatter 解析（skill / prompt template 共用）
├── hooks/                   # 生命周期钩子链
├── prompt/                  # 系统提示词 section 注册表
├── prompt-templates/        # prompts/*.md → /命令
├── session/                 # 事件日志、derive、todo 折叠
├── skills/                  # SKILL.md 发现
└── tools/                   # 工具框架与 bash/read/write/edit/todo/web 工具
```

```text
packages/orchestrator/src/
├── index.ts                 # 包入口，仅 re-export
├── node-builtins.d.ts
├── inbox/                   # steer/queue 双队列
├── json-schema-to-zod/      # MCP inputSchema 子集转换
├── main-turn/               # runMainTurn 主流入口
├── mcp/                     # MCP 客户端桥接
├── models/                  # 档位模型解析
├── plan/                    # plan 审批与修订循环
├── prompts/                 # 三角色系统提示词
├── registries/              # 角色工具注册表
├── runtime/                 # 编排运行时（spawn / resolveModel）
├── types/                   # 角色与编排事件类型
└── tools/                   # spawn_workers / spawn_tasks / run-worker
```

## 4. 关键数据流：一次用户消息

```
cli/web ──> orchestrator.MainAgent
MainAgent 第一个动作 = 结构化判定（难度 + worker 模型档位）:
  ├─ trivial → 直接回答
  ├─ simple  → spawn WorkerAgent(指定档位)
  └─ complex → plan → approval/asked ──> 用户批准 ──> spawn WorkerAgent
WorkerAgent: 可并行则 spawn TaskAgent × N（上限可配，默认 10）
每个 agent 的每次 step:
  deriveMessages() ──> ai.streamChat ──> provider
  tool call ──> 审批 waterfall（需确认则 approval/asked 阻塞等待）
  所有事件 append 到会话 JSONL + 推给 UI
```

### 4.1 遥测旁路数据流（M5.1）

遥测不改变上面这条主链路，只在 cli/server 的 turn 边界旁路采集：

```text
cli / server
  └─ createTelemetryRuntime(settings)          # 关闭、未配置或解析后地址不可用 → null
       ├─ collector.start()/observe()/finish() # 观察编排事件 + 从会话 JSONL 折叠
       │     · done/error/plan/agent_spawn 只判 outcome，不读内容
       │     · llm_call/tool_call/error/feature_usage 只取元数据
       │     · turn_end 覆盖整棵 agent 树（main + worker + task）
       └─ client.enqueue()                     # 内存队列
            └─ 阈值(50)/定时(30s)/close flush
                 → POST <endpoint>/api/v1/ingest
                      └─ 后台部分（M5.2，未开始，独立工作流）：
                         ../hotpot-telemetry ingest → SQLite → 聚合/告警
```

边界与保证：

- **无用户内容**：不上报 prompt/回复文本、工具入参/输出、文件内容、文件路径、命令、URL 查询参数、用户名、仓库名。错误只上报机器码与脱敏后的消息；脱敏失败时丢弃原文。
- **不阻塞、不失败**：`enqueue` 同步返回；`flush` 串行执行并吞掉所有网络/序列化异常；`close()` 只做一次有界尝试（不重试、不退避，并持有 ref 定时器直到最后一次请求结算），cli 的 `/exit` 不会被网络拖住，也不会因事件循环提前排空而以 code 13 退出；会话日志缺失或损坏时按空日志折叠；server 读取 settings 失败只退化为「遥测关闭」。
- **仅用户级配置**：`telemetry.endpoint`/`token` 不接受项目级覆盖，避免恶意仓库把上报数据与凭证导向别处。
- 后台服务在仓库外（`../hotpot-telemetry/`），M5.2 尚未开始；客户端只约定 ingest 的 HTTP 契约（`POST <endpoint>/api/v1/ingest`，`schemaVersion = 1`）。后台不进入 CLI/server 的构建产物。

## 5. 会话存储：append-only JSONL 事件日志

每会话一个文件，append-only，**日志即唯一事实源**。

- 位置：`~/.hotpot/sessions/<cwd 编码>/<timestamp>_<session-id>.jsonl`（借鉴 pi 按 cwd 分目录）
- 格式直接定 v1 定稿，不做 dsh 那种 v0→v4 相邻迁移链；真出现 v2 需求时再加迁移
- 恢复 = 顺序折叠日志，重建各 agent 的消息历史与队列状态

事件类型（v1）：

```jsonc
{"type":"meta","sessionId":"...","createdAt":"...","cwd":"...","formatVersion":1}
{"type":"turn/start|turn/end","id":"...","ts":"...","agentId":"main"}
{"type":"user_msg","id":"...","ts":"...","content":"...","agentId":"main"}
{"type":"internal_msg","id":"...","ts":"...","content":"...","agentId":"main"}
{"type":"assistant_msg","id":"...","ts":"...","agentId":"main","content":[...],"usage":{"input":123,"output":45},"model":"...","tier":"high"}
{"type":"request_header","id":"...","ts":"...","agentId":"...","configHash":"...","toolsHash":"..."}
{"type":"tool_call","id":"...","ts":"...","agentId":"...","name":"bash","input":{...}}
{"type":"tool_result","id":"...","ts":"...","toolCallId":"...","content":"...","isError":false}
{"type":"agent_spawn","id":"...","ts":"...","parentAgentId":"main","agentId":"worker-1","role":"worker","task":"...","tier":"medium"}
{"type":"approval/asked","id":"...","ts":"...","agentId":"...","payload":{...}}
{"type":"approval/decided","id":"...","ts":"...","requestId":"...","decision":"approved"}
{"type":"inbox/spliced","id":"...","ts":"...","agentId":"main","queue":"next-step","messages":[...]}
{"type":"todo/set","id":"...","ts":"...","agentId":"worker-1","todos":[{"content":"...","status":"pending"}]}
{"type":"hook/fired","id":"...","ts":"...","agentId":"main","hook":"pre_tool","command":"...","exitCode":0,"durationMs":12}
{"type":"skill/loaded","id":"...","ts":"...","agentId":"worker-1","skill":"commit","path":".../SKILL.md"}
{"type":"prompt/invoked","id":"...","ts":"...","agentId":"main","name":"commit","args":"fix lint","content":"..."}
{"type":"mcp/attached","id":"...","ts":"...","server":"fs","transport":"stdio","tools":["mcp__fs__read"]}
{"type":"error","id":"...","ts":"...","agentId":"...","code":"...","message":"..."}
```

`internal_msg` 是编排层内部延续提示（plan 起草/修订、批准 kickoff 等）：`deriveMessages` 按 user 角色折入模型历史，但它不是用户输入，UI 不渲染。

要点：
- 一个会话内所有 agent（含子 agent）写同一文件，`agentId` 区分
- `request_header`：config + 工具 schema 快照变化时才记新条目（借鉴 dsh），支撑缓存命中分析
- 队列变更（`inbox/spliced`）也落盘，崩溃恢复后 steering 队列不丢（借鉴 dsh）
- M4 新增的 `todo/set`、`hook/fired`、`skill/loaded`、`prompt/invoked`、`mcp/attached` 均**不进模型历史**（`deriveMessages` 不折叠）：todo 由 `foldTodos` 重建清单并注入提示词段，其余供审计与遥测计数
- 崩溃最多丢最后一行；关键事件写入后 fsync

## 6. 配置体系

双层配置（参考 kimi-code / pi 惯例）：项目级 `.hotpot/` 覆盖用户级 `~/.hotpot/` 的指定字段。

**用户级 `~/.hotpot/`**（`HOTPOT_HOME` 环境变量可覆盖）：

```
~/.hotpot/
├── settings.json     # 主配置（含模型与凭证）
├── sessions/         # 会话日志
├── skills/           # M4 skill（<name>/SKILL.md）
├── prompts/          # M4 prompt templates（<name>.md → /命令）
├── telemetry/        # M5 匿名安装 ID（install-id；benchmark 用 benchmark-install-id）
└── memory/           # 用户记忆（M4 后续项）
```

**项目级 `./.hotpot/`**（自 cwd 向上逐级查找，首个含 `settings.json` 的目录生效）：

```
<项目>/.hotpot/
└── settings.json     # 项目覆盖：仅允许非凭证字段（见下）
```

`settings.json` 可配项（加粗为已确认需求）：

| 配置项 | 默认 | 层级 | 说明 |
|--------|------|------|------|
| **models.high / medium / low** | 必填 | 仅用户级 | provider、model、baseUrl、apiKey（支持 `$ENV` 引用环境变量）；项目级忽略 models，防恶意仓库借 baseUrl 重定向窃取凭证 |
| mainAgentTier | high | 用户级+项目级 | 主 agent 默认档位 |
| **maxParallelTasks** | **10** | 用户级+项目级 | 并行 TaskAgent 上限 |
| **planMaxRevisions** | **3** | 用户级+项目级 | plan 审批修订轮次上限 |
| permission.mode | ask-on-dangerous | 仅用户级 | 权限三档：readonly（read 类放行，其余 worker 工具逐个审批）/ ask-on-dangerous（危险操作询问）/ full（全部放行）；项目级 permission 会被忽略 |
| features.* | 全开 | 仅用户级 | M4 功能开关：todo/hooks/skills/promptTemplates/webSearch/webFetch/mcp |
| hooks | 无 | 仅用户级 | Claude Code 钩子格式（SessionStart/PreToolUse/PostToolUse/Stop） |
| webSearch | duckduckgo | 仅用户级 | web_search 后端（duckduckgo 或 custom + baseUrl/apiKey/headers） |
| mcpServers | 无 | 仅用户级 | MCP server：stdio（command/args/env）或 streamable HTTP（url/headers） |
| skillsDirs | [] | 仅用户级 | 额外 skill 扫描目录（相对 cwd） |
| promptsDirs | [] | 仅用户级 | 额外 prompt template 扫描目录（相对 cwd） |
| telemetry.enabled | true | 仅用户级 | 匿名遥测开关（M5.1） |
| telemetry.endpoint | 源码内置已部署地址 | 仅用户级 | 上报地址；settings 中的空串/纯空白会回退到环境变量与源码常量；解析顺序 settings > `HOTPOT_TELEMETRY_ENDPOINT` > 源码常量，空环境变量会遮挡源码常量，最终值为空或非 http(s) 时视为未启用 |
| telemetry.token | 无 | 仅用户级 | ingest 的 Bearer token，支持整串 `$ENV` 引用；默认时不带 Authorization 头 |
| telemetry.flushIntervalMs | 30000 | 仅用户级 | 定时批量上报间隔（毫秒），非负整数，`0` 表示不定时 flush；负数仍是校验错误 |

项目级可覆盖白名单：`mainAgentTier`、`maxParallelTasks`、`planMaxRevisions`；其余字段（含 models 与 permission）一律忽略。凭证和权限只从用户级读取，规避恶意仓库注入或提权风险。M4 新增字段（features/hooks/webSearch/mcpServers/skillsDirs/promptsDirs）一律仅用户级：hooks/mcpServers 涉及任意命令执行，项目级注入即 RCE；扫描目录与外发流量同理。M5 的 `telemetry` 同样仅用户级：endpoint/token 决定数据与凭证去向，项目级可写等于允许仓库劫持上报。

## 7. 从 pi / dsh 借鉴的设计（汇总）

| 设计 | 来源 | 落点 |
|------|------|------|
| 日志即唯一事实源，deriveMessages 折叠历史 | dsh | core |
| turn/step 两级循环 | dsh | core |
| 系统提示词 section 注册表（name + order） | dsh/pi | core |
| 工具三面分离：execute / render / present | dsh | core |
| 审批 waterfall + asked/decided 审计事件对 | dsh | core |
| steer 双队列且队列变更落事件 | dsh/pi | orchestrator |
| api × provider 二维适配 + 模型 catalog | pi | ai |
| max_tokens 截断消息的 tool call 全判失败 | pi | core |
| 按 cwd 分目录的会话存储 | pi | core |
| 中断前缀落盘、不伪造历史 | dsh/pi | core |

## 8. 明确不借鉴（过重）

| 项 | 理由 |
|----|------|
| dsh 的 Cordis 插件树 + YAML patch 组合层（319 个包） | 产品级分发机制，内部项目不需要；用简单注册表替代 |
| pi 的自研 TUI 库 + napi 原生模块 | 一个包的工作量；M1 行式交互，界面重心在 web |
| 40+ provider 适配与模型生成管线 | M1 两个协议足够，模型常量手写 |
| declaration merging 扩展事件类型（pi/dsh 都在用） | 类型魔法重、编译期耦合；用显式联合类型 |
| dsh 自研 schema DSL（编译 JSON Schema + 双端代码生成） | zod 替代 |
| 会话格式迁移链、zstd 压缩、lease 文件 | v1 一次定稿，需要时再加 |
| dsh 的 PTC（run_code）、Electron desktop、Python SDK、CBOR 远程协议 | 多形态产品能力，超出当前定位 |

## 9. 扩展点预留

| 扩展功能 | 预留位置 |
|----------|----------|
| MCP | core 工具注册表增加 MCP 工具适配器（工具名 `mcp__<server>__<tool>`，pi/dsh 同款命名） |
| skill | 系统提示词 section 注册表加 skills 段：启动时只注入 name+description+路径，模型按需自行 read（pi 的渐进加载方式，省 token） |
| hooks | 审批 waterfall 泛化为生命周期钩子链（session_start、pre/post tool、turn_end） |
| 用户记忆 | server 会话启动时注入记忆摘要 section；写记忆走独立工具 |
| 向量数据库 | 独立 packages/memory 包（M4），core 不依赖 |
| 沙箱 | 审批链上的执行器替换点，接口不变 |
| steer/queue | orchestrator 的双队列，M2 预留 API，M4 完成 |
| todo / plan 模式 | plan 状态作为会话事件（借鉴 dsh `plan/mode` 为唯一状态源）；todo 作为工具 |
