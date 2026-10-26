# 权限档位 workspace 改名为 ask-on-dangerous

- 日期：2026-10-26
- 状态：进行中（工作区未提交）

## 背景与动机

`workspace` 容易被理解为文件系统边界或沙箱，但该档位实际语义是“只在工具内建危险判定时询问”。改名为 `ask-on-dangerous` 后，配置、API 和界面内部状态直接表达审批行为，减少对工作区隔离能力的误解。

## 变更内容

- core 的 `PermissionMode` 改为 `readonly | ask-on-dangerous | full`，默认档由 `workspace` 改为 `ask-on-dangerous`。
- CLI、server runtime、REST 创建/切换参数、内置 `/permission`、durable `permission/changed`、wire `permission` 和 Web 初始状态统一使用新值。
- `readonly` 与 `full` 名称不变；新档仍是装饰器透传，只由工具内建危险判定询问，审批行为不变。
- 旧 `workspace` settings 和 REST 输入明确拒绝，不设置别名；旧会话日志不做映射或迁移。
- 工作区实体、`workspaceId`、workspace CRUD、目录选择器与侧栏分组不受影响。

## 影响面

涉及 `core`、`orchestrator`、`cli`、`server`、`web` 及相关测试、当前文档和官网配置说明。用户需要将 settings 中的旧值手工改为 `ask-on-dangerous`；依赖旧 REST 枚举的调用方也需同步。

## 验证

- 定向回归先确认旧实现失败，再完成实现；最终 7 个测试文件、157 个测试通过。
- 全量 `pnpm check`、`pnpm typecheck`、`pnpm build` 与官网构建通过；`pnpm test` 为 75 个文件、685 个测试通过。
- 真实打包服务与浏览器验证：默认档与权限选择器、REST 切换、斜杠命令、旧值 400、durable 日志先于 wire 事件及 attach 恢复均符合新契约；临时服务与目录已清理。
- 覆盖旧 settings/API 值拒绝、三档审批行为、默认档位、REST/SSE、`permission/changed`、attach 恢复、Web reducer 与工作区既有功能。

## 相关链接

- 配置说明：[packages/core/src/config/README.md](../../packages/core/src/config/README.md)。
- 运行时实现：[packages/orchestrator/src/runtime/README.md](../../packages/orchestrator/src/runtime/README.md)。
- 回归测试：[packages/orchestrator/test/permission-modes.test.ts](../../packages/orchestrator/test/permission-modes.test.ts)、[packages/server/test/api.test.ts](../../packages/server/test/api.test.ts)。
