# 本地 API 认证、凭证掩码与项目权限收敛

- 日期：2026-10-26
- 状态：进行中（工作区未提交）

## 背景与动机

本地 Web 服务此前缺少认证，设置接口会返回 apiKey 原文；不可信仓库的项目配置还可覆盖 `permission.mode`。这些默认值可能暴露会话与凭证，或绕过危险操作审批。审查证据见改进报告 P0-1、P0-2。

## 变更内容

- `startServer` 默认绑定 `127.0.0.1`，每次启动生成随机 API token，也可通过非空配置固定。
- REST 统一要求 Bearer token；仅 events SSE 额外接受 `access_token` 查询参数，静态资源保持免认证。
- Web 从初始 `?token=` 取出令牌写入 sessionStorage 并清理地址栏，所有 REST 与 SSE 重连继续携带认证。
- 设置读取只返回 apiKey 掩码；原样保存掩码时保留磁盘原密钥，只有新的非空值才替换。
- 项目配置白名单移除 `permission`，只保留 `mainAgentTier`、`maxParallelTasks`、`planMaxRevisions`，仓库不能把用户权限提升为 `full`。
- 开发脚本、独立 server bin 与发布包 `hotpot web` 共用 token 接线并打印实际访问地址。

## 影响面

涉及 `core` 配置、`server` 启动和设置、`web` 认证初始化与请求、发布 CLI、开发脚本及对应文档。真实服务始终认证；`createApp` 的无 token 默认仅保留给单元测试。

## 验证

- 定向回归覆盖配置、server 启动与 API、Web 认证和 SSE、发布 CLI，共 8 个文件、80 个测试通过。
- 全量 `pnpm check`、`pnpm typecheck`、`pnpm build` 通过；`pnpm test` 为 75 个文件、684 个测试通过。
- 真实打包服务经浏览器验证：三档 apiKey 均为掩码，原样保存不改变磁盘密钥；刷新后 REST/SSE 正常，无 token 请求返回 401，地址栏令牌已清理。

## 相关链接

- 改进报告：[P0-1](../improvement-report-2026-10-26.md#p0-1开发服务可能对外暴露且管理-api-无认证)、[P0-2](../improvement-report-2026-10-26.md#p0-2项目级配置可以直接提升为-full-权限)。
- 操作说明：[packages/server/README.md](../../packages/server/README.md)、[packages/web/README.md](../../packages/web/README.md)。
