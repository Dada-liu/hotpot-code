# 04 里程碑与实施计划

> 原则：每个里程碑结束都有可运行的交付物，能真实演示，不是半成品堆叠。
> M4 功能清单已参考 pi 与 dsh 调研结果调整（见 M4 节末尾说明）。

## M1 最小可用闭环

**目标**：终端里跑通「对话 → 工具调用 → 完成任务」全流程。**只做 CLI**（已确认），不做 web。

范围：
- packages/ai：统一接口 + anthropic-messages 协议 + openai-completions 协议；模型元数据常量（手写少量）
- packages/core：turn/step 两级循环、append-only JSONL 事件日志 + deriveMessages、系统提示词 section 注册表、bash/read/write/edit 四工具（审批 waterfall + 高危确认）
- packages/cli：行式对话入口，恢复会话
- 配置：`~/.hotpot/settings.json`（三档模型必填）

验收标准：
1. CLI 中完成任务「找出 src 下所有 .ts 文件，统计行数写入 report.txt」，agent 自主多步调用工具完成
2. kill 进程后用同一会话重启，从 JSONL 折叠恢复，能继续对话
3. `pnpm test` 全绿（ai 适配器用录制回放 mock，不依赖真实 API）

## M2 三层编排 + human-in-the-loop

**目标**：主/从/子三层结构可用，复杂任务先 plan 后执行，分层模型路由生效。

范围：
- packages/orchestrator：MainAgent / WorkerAgent / TaskAgent、难度评估 + modelTier 路由、并行调度（上限 10，可配）
- plan 生成与审批流（CLI 内审批，修订上限 3，可配）
- 上下文隔离与摘要回传
- 分层 usage 记账（按 agentId + tier）
- steer/queue 双队列 API（含 `inbox/spliced` 事件落盘），CLI 内最小可用

验收标准：
1. simple 任务（如「改一下 readme 标题」）不出现 plan 审批，token 消耗与 M1 同量级（偏差 < 20%）
2. complex 任务（如「加一个 CLI 子命令」）必须先展示 plan，批准前无任何文件改动
3. 8 个只读审查任务触发并行 TaskAgent，总耗时明显低于串行
4. 分层路由可观测：simple 任务被路由到 medium/low 档时，usage 事件里的 tier 字段正确
5. 子 agent 失败时 WorkerAgent 能重试或上报，不会静默丢失

## M3 Web 端

**目标**：浏览器完成全部操作。

**状态：已完成（M3 收口提交 78096b6）。**

范围：
- packages/server：REST + SSE、会话管理、断线重连从日志补发（已完成，测试见 `packages/server/test/api.test.ts`、`session-manager.test.ts`、`tailer.test.ts`）
- packages/web：会话列表、流式对话、工具调用卡片、plan 审查面板、用量展示（已完成，测试见 `packages/web/test/`）

验收标准：
1. web 端走完 M1/M2 的全部验收场景（已完成（M3 收口提交 78096b6），测试依据：`packages/server/test/session-manager.test.ts` 与 `api.test.ts` 以 scriptedAdapter 回放 simple/complex/审批/并行子任务/steer/cancel 场景，`packages/web/test/` 覆盖 reducer 与 markdown，`packages/orchestrator/test/` 覆盖编排场景）
2. 断网重连后 SSE 恢复，事件不丢（已完成（M3 收口提交 78096b6），测试依据：`packages/server/test/tailer.test.ts` 钉住字节偏移续读，`api.test.ts` 钉住 `Last-Event-ID` 重连补发不丢序）
3. 审批操作在 web 端完成，CLI 与 web 可同时观察同一会话（已完成（M3 收口提交 78096b6），测试依据：`packages/server/test/session-manager.test.ts` 审批桥全流程，`tailer.test.ts` 全量推送 durable 事件）

## M4 扩展功能

**目标**：按优先级逐个落地，每完成一个功能跑一次回归。

参考 pi/dsh 后调整的功能清单（排序 = 建议实施顺序）：

| # | 功能 | 说明 | 来源/依据 | 状态 |
|---|------|------|-----------|------|
| 1 | todo 工具 | 全量替换语义的任务清单（dsh `tool-todo` 同款），长任务成功率收益最直接 | dsh | ✅ 已实现：`core/src/tools/todo.ts`、`core/src/session/todos.ts`；验收 `core/test/todo.test.ts`、`orchestrator/test/todo-flow.test.ts` |
| 2 | steer / queue 完善 | M2 已有队列 API，本步完成 web 端交互（排队展示、steer 注入、中断） | dsh/pi | ✅ 已实现：`GET /api/sessions/:id/inbox`、web 队列条（`web/src/components/ChatView.tsx`）；验收 `orchestrator/test/inbox.test.ts`、`server/test/api.test.ts`、`web/test/reducer.test.ts` |
| 3 | hooks | 生命周期钩子链：session_start、pre/post tool、turn_end（审批 waterfall 的公开版）；兼容 Claude Code 钩子配置格式可选 | dsh | ✅ 已实现：`core/src/hooks/hooks.ts`（Claude Code 格式）；验收 `core/test/hooks.test.ts`、`core/test/loop.test.ts`、`orchestrator/test/hooks.test.ts` |
| 4 | skill 支持 | SKILL.md + frontmatter；启动只注入 name+description+路径，模型按需 read 加载（渐进式，省 token） | pi | ✅ 已实现：`core/src/skills/skills.ts` + read 追踪；验收 `core/test/skills.test.ts`、`orchestrator/test/skills.test.ts` |
| 5 | prompt templates | `prompts/*.md` 变成 `/命令`，支持参数占位；自定义命令入口 | pi | ✅ 已实现：`core/src/prompt-templates/prompt-templates.ts`、CLI 展开、server 统一展开、web `/` 补全；验收 `core/test/prompt-templates.test.ts`、`server/test/api.test.ts`、`cli/test/cli.test.ts` |
| 6 | web_search / web_fetch 工具 | 自媒体运营 bench 需要联网能力；搜索后端可换 | dsh | ✅ 已实现：`core/src/tools/web-fetch.ts`、`core/src/tools/web-search.ts`；验收 `core/test/web-fetch.test.ts`、`core/test/web-search.test.ts` |
| 7 | MCP 支持 | stdio + streamable HTTP client；工具桥接为 `mcp__<server>__<tool>` | pi/dsh 一致 | ✅ 已实现：`orchestrator/src/mcp/mcp.ts` + `orchestrator/src/json-schema-to-zod/json-schema-to-zod.ts`；验收 `orchestrator/test/mcp.test.ts`、`json-schema-to-zod.test.ts`；真实 server 冒烟步骤见 `orchestrator/README.md` |
| 8 | 上下文自动压缩 | compaction 作为会话事件（记录保留点 + 摘要），恢复时跳过被压缩段（pi 手法）；M1 遗留项 | pi/dsh | ⏳ 未开始 |
| 9 | 用户记忆 | 跨会话记忆，启动时注入摘要 section，写记忆走独立工具 | — | ⏳ 未开始 |
| 10 | 向量数据库 | 服务记忆与代码检索，独立 packages/memory | — | ⏳ 未开始 |
| 11 | 后台任务 jobs | 后台 bash、子 agent 后台运行，完成时通知 | dsh | ⏳ 未开始 |
| 12 | 权限预设 | 三档审批预设：readonly / ask-on-dangerous / full | dsh | ✅ 已实现：`core/src/config/config.ts`、`orchestrator/src/runtime/runtime.ts`；验收 `core/test/config.test.ts`、`orchestrator/test/runtime.test.ts`、`server/test/api.test.ts` |
| 13 | tool_search 延迟工具加载 | 工具多时先给目录、按需加载声明，省 token | pi | ⏳ 未开始 |
| 14 | 沙箱 | 审批链上的执行器替换；本地 Seatbelt/容器 | — | ⏳ 未开始 |

每项验收：功能自身可用 + 新增事件类型纳入 JSONL v1 规范 + 遥测能看到该功能的开关与用量。

相对 PRD 的变更说明：新增 #3 hooks、#5 prompt templates、#6 web 工具、#11 jobs、#12 权限预设、#13 tool_search（均来自 pi/dsh 调研）；其余为 PRD 原有项重排。

## M5 配套体系

M5 拆成两条独立工作流：工具侧遥测客户端（M5.1，本仓库，已完成）与遥测后台 / benchmarks。benchmarks runner 已在本仓库完成（M5.3/M5.4）；遥测后台仍在仓库外独立推进。

原 M5 范围中的「测试补齐：集成测试覆盖主要 agent 场景（mock LLM 录制回放）」没有取消：沿用「测试随功能走」的持续补测策略，随每个里程碑补充，不单独堆到 M5 收尾；当前全量为 64 个测试文件 / 539 条用例。

### M5.1 遥测客户端（已完成）

范围（已实现）：

- `packages/telemetry`：事件 schema v1（九类事件严格白名单）、错误消息脱敏、匿名安装 ID、内存队列 + 批量 POST + 指数退避、turn 采集器、cli/server 共用 runtime
- `packages/core/src/config/config.ts`：用户级 `telemetry` 配置（`enabled` / `endpoint` / `token` / `flushIntervalMs`），项目级不接受
- `packages/cli`、`packages/server`：会话生命周期与每个 turn 的旁路接入
- 数据边界：只上报匿名指标与脱敏后的错误；不采集 prompt/回复、工具入参/输出、文件内容、文件路径、命令、URL 查询参数、用户名、仓库名（详见 `packages/telemetry/README.md`）

验收证据：

- `packages/telemetry/test/`：schema 4 条、脱敏 6 条、客户端 9 条、安装 ID 7 条、采集器 18 条（turn 折叠、worker/task 用量、outcome 判定、feature 计数、损坏日志、会话生命周期）
- `packages/cli/test/telemetry.test.ts`（4 条）：每个 turn 上报匿名批次且 payload 不含对话文本；`enabled=false`、未配置 endpoint（测试直接注入 settings，绕过 schema）、非法 endpoint 均不发请求
- `packages/server/test/telemetry.test.ts`（4 条）：`turn_end` 含 worker 用量、`close(id)` 上报 `session_end`、`attachById` 上报 `session_start(resumed: true)`、禁用与未配置 endpoint 不发请求
- 全量 `pnpm typecheck`、`pnpm test`、`pnpm exec biome check .` 通过

### M5.3 / M5.4 benchmark runner 与官方评测（实现已完成，验收记录见下）

范围（已实现）：

- `packages/benchmarks`：`WorkspaceProvider`（M5 为普通 checkout + 每题独立 worktree）、无交互 agent runner（临时 HOME、allow-all 审批落盘、plan 自动批准、超时 abort）、实例 JSONL 导出/确定性选择、predictions、官方 harness 编排（local / remote + tmux/nohup）、report、benchmark 遥测
- `packages/benchmarks/src/custom/`：三个离线种子任务（金融日收益率、slugify、自媒体内容计划）
- `pnpm bench swebench|custom` 一键入口；默认 Lite `test`、10 题、`--max-workers 1`、固定 seed
- patch-only 基线：不装 repo 依赖、不跑 repo 测试；评分只来自官方 `swebench` harness
- 文档：`packages/benchmarks/README.md`、`docs/benchmark-authoring.md`、`docs/archive/05-m5-telemetry-benchmarks.md`

验收证据：

- `packages/benchmarks/test/`：custom runner / 三题校验、workspace + patch 捕获（含 untracked、排除 node_modules/.hotpot）、allow-all 审批落盘、实例选择、predictions 格式、官方命令构造与 report 解析、报告聚合/脱敏、CLI 参数、benchmark 遥测
- `packages/ai/src/testing/record-replay.ts` + `packages/ai/test/record-replay.test.ts`（2 条）：JSONL 录制/回放与回放耗尽报错
- `pnpm bench --help` 与未知参数非 0 退出
- 全量 `pnpm typecheck`、`pnpm test`、`pnpm exec biome check .` 通过

#### Lite 10 题验收状态（2026-10-19，macmini）

macmini 环境：Node v24.21.0（fnm）、pnpm 10.33.0、Python 3.12.15（uv）、swebench 5.0.2、Docker Desktop 4.95 / Engine 29.8.2（VM 8GB 内存）。仓库同步后 `pnpm install` 通过；`pnpm test --maxWorkers=4` 64 个测试文件 / 545 条用例全部通过（默认 64 worker 并发在 macmini 上会触发 orchestrator `spawn-tasks` 的既有计时 flake，单文件重跑通过）。

已完成的操作性预检：

- 用 `HF_ENDPOINT=https://hf-mirror.com` 导出 `SWE-bench/SWE-bench_Lite` test 全部 300 条到 `instances-lite.jsonl`；`--limit 10 --seed 0` 选中 sympy / django / pylint / sphinx 混合 10 题（固定种子可复现）。
- 官方 harness（swebench 5.0.2）empty-patch 预检：report 写入 `empty_patch_ids`，runner 解析为失败原因 "empty patch"，不误判 resolved。
- 官方 harness gold-patch 预检（`astropy__astropy-12907`）：`docker pull --platform linux/amd64` 镜像 4.16GB / 200s；单题评测 437s（约 7 分 17 秒），结果 resolved；容器内存峰值约 235MB，系统内存空闲 78%-82%，评测后磁盘剩余 153GB。
- Apple Silicon 上 swebench 5.x 的 docker-py pull 不传 platform，必须先手动预拉 amd64 镜像；步骤写入 `packages/benchmarks/README.md` 与 `05-m5-telemetry-benchmarks.md`。

#### Lite 10 题验收结果（2026-10-19，run id `bench-20261019-125546-e439bbf3-eval`）

补齐 `~/.hotpot/settings.json`（high=deepseek-flash、medium=deepseek-v4-pro、low=deepseek-v4-flash）后完成正式跑批：

- 数据集/切片：`SWE-bench/SWE-bench_Lite` test，`--limit 10 --seed 0`；10 题为 sympy ×4、django ×4、pylint ×1、sphinx ×1。
- 命令：`pnpm bench swebench --instances-file instances-lite.jsonl --limit 10 --seed 0 --eval-mode local --max-workers 1 --output benchmark-runs/lite10`。
- **通过率：9/10 resolved（90.0%）**；失败题 `pylint-dev__pylint-7228`（patch 成功应用，`FAIL_TO_PASS` 的 `tests/config/test_config.py::test_regex_error` 与 `::test_csv_regex_error` 失败，`PASS_TO_PASS` 全部通过）。
- token：平均 input **908,943** / output **17,615.3**；总计 input 9,089,430 / output 176,153。
- 平均时长：**185.2s**（agent 阶段单题均值；agent 阶段总计约 30 分钟）。官方评测阶段另约 17 分钟（max_workers=1，amd64 模拟）。
- 估算成本：按非高峰价、缓存未命中，并按会话日志中的实际档位统计（high=deepseek-flash ¥1/¥4 per M，medium=deepseek-v4-pro ¥4.5/¥13.5 per M），合计 **¥32.83 ≈ $4.62**；高峰翻倍约 **$9.25**。DeepSeek 缓存命中价更低，实际账单可能低于该估算。
- 备注：`django__django-15695` 的 agent 回合以 `max_tokens` 结束，但 patch 仍被官方 resolve；`sympy__sympy-17655` agent 阶段接近 600s 超时上限。patch-only 基线不变：agent 未安装 repo 依赖、未运行 repo 测试；题目来自公开 benchmark，模型训练语料可能覆盖相关内容。
- 产物（macmini，不提交仓库）：`~/hotpot-agent/benchmark-runs/lite10/report.json`、`report.md`、`predictions.jsonl`、`official/hotpot-agent.bench-20261019-125546-e439bbf3-eval.json`、`~/hotpot-agent/logs/lite10-run.log`、`logs/lite10-eval.log`。

运行中发现并修复的问题：

- swebench 5.x 的 `SWE-bench/SWE-bench_Lite` 数据集自带 `image` 字段；旧名 `princeton-nlp/SWE-bench_Lite` 缺该字段会让 harness 抛 `KeyError: 'image'`。CLI/导出脚本默认数据集已改为官方新名（commit `fa9de78`）。
- sphinx 题目镜像被 DaoCloud 白名单拒绝，改用 `docker.1ms.run` 拉取后 retag 为官方镜像名；GitHub 直连不稳定，验收期间临时使用 `ghfast.top` 镜像并预取各题 base commit（验收后已恢复 git 配置）。

### 仍未开始（独立工作流）

- M5.2 遥测后台：仓库外 `../hotpot-telemetry/`（ingest + SQLite + 聚合 API + 管理界面 + 邮件/webhook/飞书告警），部署在 `sell_system`，不打进 CLI/server 构建产物

遥测后台与 runner 解耦：客户端只约定 ingest 的 HTTP 契约（`POST <endpoint>/api/v1/ingest`，`schemaVersion = 1`，`kind` 区分 `user`/`benchmark`）。

验收标准（保持原目标）：

1. benchmark 一键运行，输出成功率与平均 token 成本报告（已完成：Lite 10 题 9/10，90.0%，平均 input 908,943 / output 17,615.3，估算 $4.62 非高峰）
2. 遥测报表能回答「上周每个任务平均花了多少 token、成功率多少」（依赖 M5.2，未开始）
3. 自建 bench 有从历史会话沉淀新题的流程文档（筛选 → 脱敏 → 题目化）（已完成：`docs/benchmark-authoring.md`）

## 依赖关系

```
M1 ──> M2 ──> M3 ──> M4 ──> M5
  │              │
  └── 测试从 M1 起持续编写（随功能走，不堆到最后）
      benchmark 题目沉淀流程在 M2 之后开始积累语料，不等 M5
```

## 已确认决议记录

| 问题 | 决议 |
|------|------|
| M1 范围 | 只做 CLI |
| M4 功能集 | 参考 pi/dsh 调研调整为上表 14 项，按表内顺序实施 |
| 自建 benchmark 题目 | 三个领域各先出 1 题，后续从使用历史沉淀 |
