# Web 端

`hotpot web` 一键启动本地 Web 服务，浏览器里完成全部操作：会话列表、流式对话、工具卡片、plan 审查、审批、steer / 中断、用量展示。

## 启动

```bash
hotpot web
```

- 默认监听 http://127.0.0.1:4573，每次启动生成 API token，就绪后自动打开带 `?token=` 的地址；手动访问时使用终端打印的完整地址。
- 浏览器将 token 存入会话存储并清理地址栏，刷新后 REST/SSE 仍携带认证。
- 端口可用参数或环境变量 `HOTPOT_PORT` 覆盖。
- 与 CLI 使用同一份 settings 配置与同一份 `~/.hotpot/sessions/` 会话存储——CLI 里创建的会话，Web 端同样能打开，两边可以同时观察同一会话。

源码仓库开发态运行 `pnpm dev web`；只改前端时另开 `pnpm --filter @hotpot/web dev`（Vite 将 `/api` 代理到 4573）。Vite 与后端是不同 origin，需把后端终端打印的同一 token 拼到 Vite 地址（如 `http://localhost:5173/?token=...`），不能直接打开无 token 的 Vite 页面。

## 界面

三栏布局：

- **左栏**：会话列表，可归档、删除。
- **中栏**：对话流。assistant 消息流式渲染；工具调用以卡片展示参数与结果；plan 以卡片展示全文并就地审批。
- **右栏**：agent 状态面板——spawn 出的 worker / task 树、运行状态、队列（steer / queue 两列）与用量统计。

## 可靠性

- 服务层是 REST + SSE：事件流按会话内单调 `seq` 排序广播。
- 断线重连时携带已消费偏移，服务端从 JSONL 日志补发 missed 事件，**不丢序、不丢事件**。
- 运行中删除会话会返回 409；归档会先等回合落定（日志与遥测全部落盘）再摘托管，随时可重新打开。

## 与 CLI 的互通

会话的唯一事实源是磁盘上的 JSONL 日志（见[会话日志](/advanced/session-log)）。Web 的会话管理器在内存未命中时会降级为 `attachById` 恢复磁盘会话，因此 CLI 创建的会话同样可打开；反过来，Web 端发起的会话在 CLI 里用 `--session` 也能恢复。审批操作在任意一端完成，另一端同步可见。
