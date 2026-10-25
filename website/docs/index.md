---
pageType: home
hero:
  name: HotPot Agent
  text: 更低的成本，更好的效果
  tagline: 分层模型路由、三层 agent 编排、JSONL 会话日志可完整恢复
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started.html
    - theme: alt
      text: GitHub
      link: https://github.com/Dada-liu/hotpot-agent
  image:
    src: /logo.png
    alt: hotpot-agent logo
features:
  - icon: /icons/layers.svg
    title: 三层编排
    details: main 首轮提示词判定难度并路由模型档位，worker 执行与并行拆分，task 跑原子任务；复杂任务先出计划、审批后执行。
  - icon: /icons/gauge.svg
    title: 分层模型路由
    details: trivial / simple / complex 任务分别路由到 high / medium / low 档位，按 token 消耗与成功率量化每一档的收益。
  - icon: /icons/log.svg
    title: 会话日志即唯一事实源
    details: append-only JSONL 事件日志，deriveMessages 从中转换出模型历史；进程被杀、断线重连后都能折叠恢复、继续对话。
  - icon: /icons/shield.svg
    title: 三档权限与审批
    details: 只读 / 工作区 / 完全三档权限；main 只读工具、worker 按档位放行；高危命令与覆盖写先询问，asked / decided 全程落盘可审计。
  - icon: /icons/monitor.svg
    title: Web 工作区与面板
    details: hotpot web 一键启动；工作区按目录分组会话并支持拖拽排序；排队优先输入框、附件与 @ 文件提及；agent 面板展示任务清单与用量。
  - icon: /icons/target.svg
    title: Benchmark 驱动
    details: SWE-bench Lite 10 题 9/10 通过（patch-only 基线），单题 token 与耗时进报告；任何增加开销的功能都必须用数据证明收益。
---

## 为什么做 hotpot-agent

代码 agent 的核心矛盾是**成本与效果**：更强的模型更贵，更便宜的模型更容易失败。hotpot-agent 的立场是把这笔账算清楚：

| 维度 | 度量指标 |
|------|----------|
| 成本 | 单任务 token 消耗（分档统计）、单任务耗时 |
| 效果 | 任务成功率（benchmark 通过率）、人工干预次数 |

任何增加 token 开销的功能，必须能用数据证明它提升成功率，否则默认关闭。围绕这条原则，项目做了三件事：

1. **分层模型路由**：主 agent 首轮提示词判定任务难度，trivial 直答、simple 派 worker 执行、complex 先产出计划；worker/task 继承低档模型，把贵模型的调用压到最少。
2. **三层 agent 编排**：复杂任务拆给并行 worker，每个 worker 再拆原子 task（默认上限 10 个并行）；plan 先审后执行，steer / queue 双队列支持回合中纠偏。
3. **全程可度量**：会话 JSONL 记录每次 LLM 调用与工具调用的用量，遥测按整棵 agent 树折叠 token，benchmark runner 直接复用同一套链路输出通过率与成本报告。

## 架构总览

```
┌───────────────────────────────────────────────────────────────────────────┐
│ 【接入层】                                                                │
│   web    React SPA 三栏界面（会话列表 / 对话流 / agent 状态面板）         │
│   cli    行式交互入口                                                     │
├───────────────────────────────────────────────────────────────────────────┤
│ 【服务层】                                                                │
│   server   REST + SSE（会话管理、日志补发、静态托管）                     │
├───────────────────────────────────────────────────────────────────────────┤
│ 【编排层】                                                                │
│   orchestrator                                                            │
│     三层 agent 编排：main 难度路由 → worker 执行/并行拆分 → task 原子任务 │
│     plan 先审后执行、steer/queue 双队列                                   │
├───────────────────────────────────────────────────────────────────────────┤
│ 【核心层】                                                                │
│   core                                                                    │
│     turn/step 两级循环、工具三面分离、审批 waterfall                      │
│     会话 JSONL 事件日志为唯一事实源                                       │
├───────────────────────────────────────────────────────────────────────────┤
│ 【适配层】                                                                │
│   ai                                                                      │
│     api×provider 二维协议适配（anthropic-messages / openai-completions）  │
│     SSE 流式解析、模型目录、用量统计                                      │
└───────────────────────────────────────────────────────────────────────────┘
```

依赖方向严格自上而下（`server → orchestrator → core → ai`），禁止反向依赖；`telemetry` 只做匿名指标上报的旁路，不进入 agent 主链路。详见 [总体架构](/advanced/architecture)。

## 效果数据

以 2026-10-19 的 SWE-bench Lite 10 题跑批为例（DeepSeek 模型，patch-only 基线）：

- **通过率 9/10（90%）**，平均单题 input 908,943 / output 17,615 token
- 平均单题耗时 185s，10 题估算成本约 **$4.62**（非高峰价）
- 报告与失败原因脱敏落盘，不含 prompt、回复与 patch 内容

数据来源与复现步骤见 [Benchmarks](/advanced/benchmarks)。
