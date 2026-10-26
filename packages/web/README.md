# @hotpot/web

hotpot-agent 的 Web UI（React SPA）。M3 产物：通过 server 的 REST + SSE API 观察与驱动会话。

## 定位

- 纯前端包，不依赖 `@hotpot/core` 等 node 包；与服务端的契约镜像在 `src/protocol.ts`（改动需与 `packages/server/src/wire.ts` 双侧同步）。
- 状态归约是纯函数（`src/state/reducer.ts`），UI 只是它的投影。

## 样式体系

- Tailwind CSS v4（CSS-first 配置，无 `tailwind.config.js`）：`src/styles.css` 里 `@import "tailwindcss"` + `@theme inline` 把语义变量映射为 utility；`vite.config.ts` 接入 `@tailwindcss/vite`。
- 组件库为 shadcn/ui（`components.json`，style=new-york）：基础组件生成在 `src/components/ui/`（入库即归本仓库维护，勿直接升级覆盖；新增用 `pnpm dlx shadcn@latest add <名>` 后跑 `biome check --write` 规范化）。图标用 `lucide-react`。
- 主题三色：黑（`--primary` #17171a，主按钮/激活态/正文）、白（`--background`）、橙（`--brand` #ff5c00，强调/运行态；`--ring` 焦点环）；灰阶为黑白中性过渡；失败/危险收敛到深橙 `--destructive` #d94800。语义变量集中定义在 `src/styles.css` 的 `:root`。
- `@` 路径别名指向 `src/`（`vite.config.ts` 的 `resolve.alias` 与 `tsconfig.json` 的 `paths` 同步维护）。
- 仓库根 `biome.json` 开启了 `css.parser.tailwindDirectives` 以支持 Tailwind v4 的 `@theme` 等指令。

## 命令

```bash
pnpm --filter @hotpot/web dev    # 开发服务器（/api 代理到 http://localhost:4573）
pnpm --filter @hotpot/web build  # 产物输出到 packages/web/dist
```

Vite 与 4573 后端是不同 origin，不共享 sessionStorage。开发时需把后端终端打印的同一 token 拼到 Vite 页面地址（如 `http://localhost:5173/?token=...`）；页面会将 token 存入当前 origin 的会话存储并清理地址栏，随后 REST 使用 Bearer、SSE 使用 `access_token`。

## 静态资产

`vite.config.ts` 的 `publicDir` 指向仓库根 `public/`：logo 与各 agent 形象图（`logo.png`、`main_agent.png`、`work_agent*.webp`、`task_agent*.webp`）不搬迁、直接复用，构建时复制进 `dist/`。

## M4 增量

- **steer/queue 队列展示**：reducer 折叠 `inbox/spliced` 事件维护 `state.inbox`（next-step = steer、next-turn = 排队），输入框上方的队列条可展开查看消息正文；回合结束与发送 steer 后经 `GET /api/sessions/:id/inbox` 拉快照修正已消费条目（drain/poll 不落事件）。
- **prompt templates 补全**：输入 `/` 前缀时列出 `GET /api/sessions/:id/prompts` 返回的模板，点击补全为 `/name `；展开由 server 统一完成，web 不复制参数替换逻辑。
- **plan 卡片去重**：`plan(drafted)` 携带 `messageIds`（计划正文所在的 assistant 消息 id），reducer 移除对应正文气泡并记录该 id 集合；后到的日志同样不渲染，计划只在卡片中展示。编排层内部提示 `internal_msg` 不进入主对话投影。
- **协议镜像**：`protocol.ts` 已补齐 M4 五个事件变体（todo/set、hook/fired、skill/loaded、prompt/invoked、mcp/attached），reducer 对它们幂等忽略（不进入主对话投影）。
