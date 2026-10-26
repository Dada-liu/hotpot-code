# hotpot-agent 产品需求文档（PRD）

> 本文档是 hotpot-agent 的定稿需求。探讨过程文档归档在 `docs/archive/`（01 需求细化、02 总体架构、03 编排设计、04 里程碑），细节以归档文档为准，本文档只保留决议后的结论。

## 1. 项目定位

基于 Node + TypeScript 的 code agent，项目名 **hotpot-agent**。

核心原则：**更低的成本、更好的效果**，可量化：

| 维度 | 度量指标 |
|------|----------|
| 成本 | 单任务 token 消耗（分档统计）、单任务耗时 |
| 效果 | 任务成功率（benchmark 通过率）、人工干预次数 |

任何增加 token 开销的功能必须能用数据证明它提升成功率，否则默认关闭。

## 2. 工程原则

1. **md 即代码**：每个文件夹带 `README.md`（做了什么）和 `AGENTS.md`（怎么改）。当前层只概述子文件夹，细节下沉。
2. 符合软件工程要求：模块化、可测试、类型严格（no `any`）、版本控制。
3. **特性目录化**：`packages/core` 与 `packages/orchestrator` 的 `src/` 下每个特性独立成子文件夹；子文件夹以 `index.ts` 作为对外出口，并各自携带 `README.md` / `AGENTS.md`；`src/` 根目录只保留包入口 `index.ts` 与 ambient 声明，不散放特性文件。
4. README/代码注释用简体中文；LLM prompt 和 AGENTS.md 用英文（附中文注释或中文备份）。

## 3. 架构决议

- pnpm monorepo，Node >= 22 + TypeScript erasable-syntax-only（`.ts` 后缀 import，Node strip-only 开发直跑），vitest 测试，biome 检查，tsup 发布
- 包结构：`packages/ai`（LLM 适配，api×provider 二维，首批 anthropic-messages + openai-completions）→ `packages/core`（turn/step 循环、工具、提示词、会话日志）→ `packages/orchestrator`（三层编排）→ `packages/server`（REST + SSE 服务层，实现见 [packages/server/README.md](../packages/server/README.md)）+ `packages/web`（React SPA，实现见 [packages/web/README.md](../packages/web/README.md)）（M3，已实现）、`packages/cli`（M1）、`packages/telemetry`（M5 匿名遥测客户端，实现见 [packages/telemetry/README.md](../packages/telemetry/README.md)）
- **会话日志即唯一事实源**：append-only JSONL 事件日志，`deriveMessages()` 转换出模型历史；存储于 `~/.hotpot/sessions/`
- 配置：双层——用户级 `~/.hotpot/settings.json`（三档模型 high/medium/low、`maxParallelTasks` 默认 10、`planMaxRevisions` 默认 3）+ 项目级 `./.hotpot/settings.json`（仅可覆盖非凭证字段；凭证只从用户级读取）
- 技术方案参考 pi 与 deepseek-harness，借鉴与取舍清单见 `docs/archive/02-architecture.md` 第 7、8 节

## 4. 功能需求

### P0 基础功能（M1-M3，除特别注明外已实现）
1. 基础 agentic loop（turn/step 两级循环与中断已实现；上下文长度管理未实现）
2. 系统提示词（section 注册表，英文 prompt，分层组装）
3. 四个基础工具：bash / read / write / edit（审批 waterfall，高危确认）
4. LLM 适配器（流式、tool calling、用量统计、结构化错误已实现；模型请求的指数退避重试未实现）
5. 三层 agent 编排：主 agent（对话入口，首轮提示词判定难度+模型档位路由，无独立路由工具）→ 从 agent（任务执行，可拆并行）→ 子 agent（原子任务，继承从 agent 档位）；复杂任务首轮直出计划、经用户审批后执行，简单任务首轮直接派发执行
6. 原始会话全量存储（JSONL，可恢复续聊）
7. Web 端（M3：会话列表、流式对话、工具可视化、plan 审查、用量展示）

### P1 扩展功能（M4，按实施顺序）
todo、steer/queue、hooks、skill、prompt templates、web_search/web_fetch、MCP、上下文自动压缩、用户记忆、向量数据库、后台任务 jobs、权限预设、tool_search、沙箱

### P2 配套（贯穿 + M5）
测试（vitest 单元 + mock LLM 集成）、benchmarks（SWE-bench + 自建金融/软件开发/自媒体运营 bench，各领域先 1 题打底，后续从使用历史沉淀）、遥测（token/耗时/成功率；M5.1 已实现：工具向中心服务上报匿名指标与脱敏后的系统错误，后台管理界面为独立项目 `../hotpot-telemetry/`、不打进工具产物，不再以本地存储/导出为主路径）

## 5. 里程碑

- **M1**：最小可用闭环，只做 CLI（ai + core + cli + 会话存储 + 配置）
- **M2**：三层编排 + human-in-the-loop + 分层模型路由 + steer/queue API（已实现，验收见 `docs/archive/04-roadmap.md` M2 节与 `packages/orchestrator/test/m2-acceptance.test.ts`）
- **M3**：Web 端（server + web，已实现，验收见 `docs/archive/04-roadmap.md` M3 节）
- **M4**：P1 扩展功能逐项落地
- **M5**：benchmarks + 遥测体系

各里程碑验收标准见 `docs/archive/04-roadmap.md`。

## 6. Anti-goals（做了就算失败）

- 编排开销大于收益：简单任务被强行拆分
- 会话存储无法完整重建上下文
- 工具无防护：高危命令无确认机制
