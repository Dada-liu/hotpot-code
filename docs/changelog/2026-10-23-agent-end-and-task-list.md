# agent_end 驱动 agent 状态与任务清单

- 日期：2026-10-23
- 状态：已合入 main（`bc5f931`、`695e3df`）

## 背景与动机

Web 的 agent 卡片此前依赖 `turn(end)` 和工具结果文本推断状态。内联 worker/task 的生命周期与 main 回合并不等价，文本启发式也无法可靠区分失败，导致卡片状态可能被提前结束或错误翻转。

## 变更内容

- core 增加 durable `agent_end` 会话事件，orchestrator 在内联 agent 收尾时写入 `done` 或 `failed`。
- Web reducer 只由 `agent_end` 驱动卡片的完成/失败状态，`log(error)` 可立即标记失败且不被后续事件回退。
- agent 面板增加任务清单和详情弹窗，移除基于 `[FAILED]` 等结果文本的状态启发式。

## 影响面

涉及 `core` 会话事件、`orchestrator` 内联执行、`server` 日志转发和 `web` 协议镜像、reducer 与 agent 面板。旧回合结束事件不再承担 worker/task 卡片收尾语义。

## 验证

- `orchestrator/test/run-worker.test.ts` 覆盖内联 agent 收尾事件。
- `server/test/session-manager.test.ts` 覆盖事件转发。
- `web/test/reducer.test.ts` 覆盖 `agent_end`、错误与面板状态折叠。

## 相关链接

- 提交：`bc5f931`（durable 事件与收尾）、`695e3df`（Web 状态与任务面板）。
- 当前协议：[packages/web/src/protocol.ts](../../packages/web/src/protocol.ts)。
