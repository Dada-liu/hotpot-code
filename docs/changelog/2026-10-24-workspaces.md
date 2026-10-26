# 持久化工作区与原生目录选择器

- 日期：2026-10-24
- 状态：已合入 main（`e108389`、`c38c335`、`11fd803`）

## 背景与动机

会话此前主要按 cwd 隐式组织，用户无法稳定管理工作区名称、顺序和会话归属。Web 需要一等工作区实体及跨平台目录选择流程，减少手填路径和侧栏分组成本。

## 变更内容

- core 新增 `~/.hotpot/workspaces.json` 持久化注册表，记录 canonical 路径、标题、会话归属与顺序。
- server 增加工作区 CRUD、排序、会话归属和原生目录选择器 API；macOS、Windows、Linux 分别使用系统可用后端，失败时支持手动路径降级。
- Web 侧栏按工作区分组，支持组内新建、重命名、删除和拖拽排序；删除工作区只解除注册，不删除会话。

## 影响面

涉及 `core` 新 workspace 特性、`server` 工作区与目录选择路由、`web` 侧栏及 API。显式 cwd 命中已注册路径时自动归属，归档保留归属，删除会话后解除归属。

## 验证

- `core/test/workspace.test.ts` 覆盖注册表持久化和路径、标题、顺序规则。
- `server/test/api.test.ts` 覆盖工作区 REST 与会话归属。
- `server/test/directory-picker.test.ts` 覆盖平台分支、取消、回退和超时。
- `web/test/workspaces.test.ts` 覆盖分组与排序投影。

## 相关链接

- 提交：`e108389`（注册表）、`c38c335`（服务端）、`11fd803`（Web）。
- 实现说明：[packages/core/src/workspace/README.md](../../packages/core/src/workspace/README.md)。
