# 权限三档、排队优先与输入框扩展

- 日期：2026-10-23
- 状态：已合入 main（`3002020`、`af48a10`、`08c87fe`）

## 背景与动机

原有审批策略缺少统一的三档用户入口，运行中发送与即时 steer 的边界不够直观。Web 输入框也需要权限切换、文本附件和工作区文件引用，才能覆盖常见操作链路。

## 变更内容

- 配置与运行时新增 `readonly` / `workspace` / `full` 三档权限，main 增加只读工具，inbox 支持队列变更。
- server 增加权限、队列、上传和文件浏览端点；运行中普通发送优先进入 next-turn 队列，并新增 `permission` wire 事件。
- Web 增加中文权限选择器、固定 QueueBar、文本附件上传和 `@` 文件提及；内置 `/help`、`/permission` 以本地提示展示结果。

## 影响面

涉及 `core`、`orchestrator`、`cli`、`server` 和 `web`。权限选择与队列变化持久化到会话日志，Web 与 CLI 可观察同一会话状态。

## 验证

- `core/test/config.test.ts`、`core/test/approval-audit.test.ts` 覆盖配置与审批审计。
- `orchestrator/test/permission-modes.test.ts`、`orchestrator/test/inbox.test.ts` 覆盖权限分派和队列变更。
- `server/test/api.test.ts`、`server/test/session-manager.test.ts` 覆盖 REST、持久化与发送行为。
- `web/test/reducer.test.ts` 覆盖权限和 inbox 状态折叠。

## 相关链接

- 提交：`3002020`（核心与编排）、`af48a10`（服务端）、`08c87fe`（Web）。
- 当前配置说明：[packages/core/src/config/README.md](../../packages/core/src/config/README.md)。
