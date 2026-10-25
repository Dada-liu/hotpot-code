# 更新日志

## v0.1.1（2026-10-25）

v0.1.0 之后的 Web 与编排迭代，重点补齐工作区、权限档位与输入框能力。

### 编排

- 移除 delegate 工具，改为 main 首轮提示词难度路由；新增 plan 草稿检测与格式模板，plan 扫描窗口对齐回合起点。
- 内联 agent 收尾时落盘 `agent_end` 事件。

### 工作区

- 新增持久化工作区注册表；服务端提供工作区 CRUD、会话归属与系统原生目录选择器。
- Web 侧栏按工作区分组、支持拖拽排序，并可通过原生选择器直接添加工作区。

### 权限与队列

- 三档权限模式、main 只读工具与 inbox 队列变更方法；Web 端提供中文权限档位选择器。
- 发送改为排队优先，回合进行中可排队补发并随时取消。

### 输入框与附件

- 输入框改为上下布局，支持回形针附件上传、`@` 文件提及与工作区选择。
- 新增临时草稿会话与始终可用的输入控件；发送/取消按钮补充 tooltip。

### 会话与面板

- agent 卡片状态改由 `agent_end` 驱动，新增任务清单与详情弹窗。
- 会话列表支持归档/删除、行尾操作菜单与省略名称；新增模型档位设置弹窗。
- 审批 durable requestId 透传为广播级 requestId，内外 id 统一，Web 审批 UI 同步调整。

### 基础设施

- 默认遥测地址指向已部署的 telemetry server；`turn_end` 的分档/分模型统计与 server schema 对齐。

### 官网与 benchmark

- 新增 Rspress 官网与 GitHub Pages 部署。
- benchmarks 移至仓库根目录，并新增 `software-pos-cart` 任务。

## v0.1.0（2026-10-19）

首个发布版本。核心闭环与配套体系均已通过里程碑验收（验收标准见仓库 `docs/archive/04-roadmap.md`）。

### 核心能力

- **最小可用闭环（M1）**：CLI 对话 → 工具调用 → 完成任务；append-only JSONL 会话日志为唯一事实源，进程被杀后可恢复续聊；bash / read / write / edit 四工具带审批 waterfall。
- **三层编排（M2）**：main 首轮提示词难度路由（trivial 直答 / simple 派 worker / complex 出 plan）、worker 执行与并行拆分（默认上限 10）、task 原子任务继承档位；plan 先审后执行（修订上限 3 轮）；steer / queue 双队列支持回合中纠偏与排队补发。
- **Web 端（M3）**：`hotpot web` 一键启动（默认 4573 端口）；REST + SSE 流式会话，断线重连从 JSONL 按偏移补发不丢事件；三栏界面含工具卡片、plan 审查、审批桥、队列与用量面板；CLI 与 Web 可同时观察同一会话。

### 扩展功能（M4，已完成 7/14）

todo 工具、steer/queue Web 交互、hooks（Claude Code 格式）、skill（SKILL.md 渐进式注入）、prompt templates（`/` 命令）、web_search / web_fetch 工具、MCP 接入（stdio + streamable HTTP，工具桥接 `mcp__<server>__<tool>`）。

### 配套体系（M5）

- **遥测客户端**：九类事件严格白名单、错误消息脱敏、匿名安装 ID、内存队列批量上报；明确不采集 prompt / 回复 / 工具入参输出 / 文件内容等用户内容。
- **Benchmark runner**：SWE-bench 官方 harness 评分 + 自建三题（金融 / 软件开发 / 自媒体）；SWE-bench Lite 10 题通过率 **9/10（90%）**，平均单题 input 908,943 / output 17,615 token，估算成本约 $4.62（patch-only 基线）。

### 路线（后续版本）

- M4 剩余项：上下文自动压缩、用户记忆、向量数据库、后台任务 jobs、权限预设、tool_search 延迟工具加载、沙箱。
- M5.2 遥测后台（仓库外独立项目）：ingest + 聚合 + 管理界面 + 告警。
