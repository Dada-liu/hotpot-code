# src/config/

settings.json 双层加载与功能开关。

- `config.ts` — zod schema（models/permission/features/hooks/webSearch/mcpServers/skillsDirs/promptsDirs/telemetry 等）、`loadSettings({ home, cwd })`、`featureEnabled(features, name)`。
- `permission.mode` 三档（M1，替代旧 `approval.policy`）：`readonly`（read 类自动放行，其余一切 worker 工具逐个经用户审批）/`ask-on-dangerous`（仅危险操作询问，默认档，缺省由调用侧 `?? "ask-on-dangerous"` 应用）/`full`（全部自动放行，链头 `allowAllHandler`，永不打断）。仅用户级可配置，项目级 `permission` 作为未知字段剥离。
- `PermissionMode` 类型从本特性导出（`"readonly" | "ask-on-dangerous" | "full"`）。
- 用户级 `<home>/settings.json` 必填，含三档模型与凭证；`apiKey` 支持整串 `$ENV` 引用（仅用户级）。
- 项目级 `.hotpot/settings.json` 自 cwd 向上逐级查找，可选；只覆盖非凭证白名单字段，未知字段静默剥离。
- home 解析复用 `session/store.ts` 的 `resolveHome`（参数 > `HOTPOT_HOME` > `~/.hotpot`）。
- 模块级字段（`hooks`、`webSearch`、`mcpServers`、`skillsDirs`、`promptsDirs`、`telemetry`、`features.*`）仅来自用户级，避免恶意仓库注入命令或重定向凭证。
- `telemetry`（`enabled`/`endpoint`/`token`/`flushIntervalMs`）是 M5 匿名上报配置：`token` 支持整串 `$ENV`。endpoint/token 若可由项目级覆盖，会把上报数据与凭证导向攻击者，因此不在项目级白名单内。`endpoint` 允许空串/空白（运行时回退到环境变量与源码常量），`flushIntervalMs` 允许 `0`（不定时 flush）：遥测是旁路，这类配置不应让 `loadSettings` 抛错拖垮启动。
- `index.ts` 是本特性的对外出口。
