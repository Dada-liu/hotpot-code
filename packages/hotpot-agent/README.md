# hotpot-agent（npm 发布包）

这是 `hotpot` 命令的 npm 发布包，把 `@hotpot/cli`、`@hotpot/server` 与 Web 产物打包成一个可安装产物。包名是 `hotpot-agent`（npm 上的 `hotpot` 已被无关项目占用），安装后的命令名是 `hotpot`。

## 安装

```bash
npm install -g hotpot-agent
```

要求 Node >= 22，并在 `~/.hotpot/settings.json` 配置模型（格式见仓库根 README）。

## 命令

```bash
hotpot                                   # 启动终端对话
hotpot chat [--session <path>] [--tier high|medium|low]
hotpot web [--port <n>] [--host <addr>] [--no-open]
hotpot --version
hotpot --help
```

`hotpot web` 默认监听 `127.0.0.1:4573`，每次启动生成 API token，并自动打开带 `?token=` 的地址；浏览器将 token 存入会话存储后清理地址栏，刷新仍可访问。`--no-open` 用于脚本或远程环境，此时使用终端打印的完整地址。端口可用 `HOTPOT_PORT` 指定，非空 `HOTPOT_API_TOKEN` 可固定启动 token。

## 构建与发布

从仓库根执行：

```bash
pnpm build       # 构建 Web，再打包出 dist/bin.js 与 dist/web
pnpm pack:npm    # 在 artifacts/ 生成 npm tarball
pnpm publish:npm # 发布 tarball（需要 npm 登录）
```

GitHub Actions 在推送 `v*` tag 时自动完成校验、构建、打包和发布，详见仓库根 README 的「发布」一节。

## 目录

- `src/bin.ts`：`hotpot` 入口（thin wrapper）
- `src/cli.ts`：命令路由、帮助、版本
- `src/web.ts`：`hotpot web` 的参数解析与 server 启动
- `src/open-browser.ts`：跨平台打开浏览器
- `tsup.config.ts`：单文件打包 + Web 产物复制
- `dist/`：构建产物（不提交）
