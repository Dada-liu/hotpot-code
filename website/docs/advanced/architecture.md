# 总体架构

hotpot-agent 是 pnpm monorepo，Node >= 22 + TypeScript（erasable-syntax-only，Node strip-only 直跑），vitest 测试，biome 检查。

## 分层

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

依赖方向严格自上而下（`server → orchestrator → core → ai`；`cli` 与 `server` 同为 orchestrator 之上的入口，`web` 不引 workspace 包、构建产物由 server 托管），禁止反向依赖。

旁路包：

- `packages/telemetry`：`cli`/`server` → `telemetry` → `core`，只做匿名指标上报，不进入 agent 主链路。
- `benchmarks/`（根级，与 `packages/` 并列）：复用 core/orchestrator/telemetry 跑批，不被 `cli`/`server` 引用，也不进入工具产物。
- `packages/hotpot-agent`：唯一 npm 发布包（`hotpot` 命令 + Web 产物），tsup 把 workspace 源码打进单文件 CLI。

## 一次用户消息的数据流

```
cli / web
  → runMainTurn（首轮提示词难度路由）
  → worker / task 内联跑 core runTurn
  → 每个 step 由 deriveMessages 从会话日志转换出模型历史
  → ai.streamChat（流式 + tool calling）
  → 工具批次经审批 waterfall 执行
  → 全部事件 append 进 JSONL，并流回 cli/web 渲染
```

要点：**模型历史不是内存状态，而是从 JSONL 日志现算出来的**。这意味着进程重启、会话恢复、token 统计都天然一致，没有第二份状态需要同步。

## 各包职责

| 包 | 职责 |
|----|------|
| `@hotpot/ai` | LLM 协议适配：api×provider 二维（anthropic-messages / openai-completions）、SSE 流式解析、模型目录、用量统计、结构化错误 |
| `@hotpot/core` | turn/step 两级循环、append-only JSONL 事件日志 + deriveMessages、系统提示词 section 注册表、工具与审批 waterfall、配置加载 |
| `@hotpot/orchestrator` | 三层编排：MainAgent / WorkerAgent / TaskAgent、难度评估与模型档位路由、plan 生成与审批流、steer/queue 双队列、MCP 接入 |
| `@hotpot/server` | REST + SSE：会话管理、审批桥、JSONL tailer 断线补发、静态托管 |
| `@hotpot/web` | React SPA：会话列表、流式对话、工具卡片、plan 审查、队列与用量面板（纯前端，不依赖 node 包） |
| `@hotpot/cli` | 行式交互入口：参数解析、终端渲染、审批交互 |
| `@hotpot/telemetry` | 匿名遥测客户端：事件白名单、脱敏、批量上报 |
| `@hotpot/benchmarks` | benchmark runner：SWE-bench 官方评测 + 自建题三类 |

## 工程原则

1. **md 即代码**：每个文件夹带 `README.md`（做了什么）与 `AGENTS.md`（怎么改），细节下沉。
2. **特性目录化**：`core` 与 `orchestrator` 的 `src/` 下每个特性独立成子文件夹，以 `index.ts` 作为对外出口。
3. **可测试**：适配器用录制回放 mock，不依赖真实 API；测试随功能走。
4. **类型严格**：no `any`；只用可被 Node strip-only 擦除的 TS 语法。
