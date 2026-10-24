# @hotpot/core

agent 内核，不依赖任何 UI。

## 架构

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ 【agent 循环】                                                                     │
│   agent/loop.ts   runTurn：turn/step 两级循环                                      │
│   agent/types.ts  LoopConfig 收拢入参（adapter / registry / approval / pollInbox） │
├────────────────────────────────────────────────────────────────────────────────────┤
│ 【能力组件】                                                                       │
│   prompt/    section 注册表（name + order 拼接系统提示词）                         │
│   tools/     tool.ts 三面 execute/render/present + registry + bash/read/write/edit │
│   approval/  chain.ts 审批 waterfall；audit.ts 审计包装（asked/decided 落盘）      │
├────────────────────────────────────────────────────────────────────────────────────┤
│ 【会话存储：唯一事实源】                                                           │
│   events.ts  事件联合（v1 定稿）                                                   │
│   store.ts   JSONL append + fsync、坏行跳过、resumeSession                         │
│   derive.ts  转换出模型可见历史（按 agentId 过滤）                                 │
└────────────────────────────────────────────────────────────────────────────────────┘
```

独立特性 `config/`：`loadSettings` 双层配置（用户级必填 + 项目级白名单覆盖），经 `resolveHome` 复用 session 的 home 规则。

数据流：`runTurn` 每个 step 由 `deriveMessages` 从日志转换历史 → adapter 流式输出 → 工具批次执行（`ToolContext` 携带 `ApprovalChain`）→ 事件 append 回会话日志。不变量：模型可见 ⟺ 已记录。

职责（M1 计划）：

- 会话事件日志：append-only JSONL 为唯一事实源，`deriveMessages` 转换历史；加载跳过末尾损坏行。
- 系统提示词 section 注册表（按 order 拼接，prompt 文案全英文）。
- 工具框架：`execute`/`render`/`present` 三面分离；bash、read、write、edit 四个基础工具。
- 审批 waterfall：`ApprovalChain` 顺序询问，全部 next 时默认 deny（fail-closed）；`createAuditedApprovalChain` 包装层把 asked/decided 事件落盘会话日志（编排层 command/write/plan 审批的审计通道）。
- turn/step 两级循环 `runTurn`；含 max_tokens 截断防御与 abort 落盘语义。
- 配置加载 `loadSettings`（双层：用户级 `~/.hotpot/settings.json` 必填，含三档模型与凭证；项目级 `.hotpot/settings.json` 自 cwd 向上查找、可选，只覆盖非凭证白名单字段；zod 校验，apiKey 支持 `$ENV` 引用且仅用户级）。

当前状态：会话事件日志（`src/session/`，含 `resumeSession` 续聊恢复）、section 注册表（`src/prompt/`）、工具框架与审批链（`src/tools/`、`src/approval/`，含 bash/read/write/edit）、turn/step 循环 `runTurn`（`src/agent/`）、配置加载 `loadSettings`（`src/config/config.ts`）已完成；`src/index.ts` 为包入口（仅 re-export）。M2 增补：assistant_msg 落盘 tier/model、tool_result 归属 agentId（derive 按 agent 过滤）、审批 asked/decided 落盘、`pollInbox` step 顶部注入钩子。新增事件变体 `internal_msg`：编排层内部延续提示，`deriveMessages` 按 user 角色折入模型历史，UI 不渲染。架构依据：`docs/archive/02-architecture.md`。

## M4 扩展能力

- **todo 工具**（`src/tools/todo.ts` + `src/session/todos.ts`）：全量替换语义的任务清单；每次调用落 `todo/set` 快照，`foldTodos` 从日志重建（last-write-wins，按 agentId 隔离），供 orchestrator 注入提示词段。
- **web 工具**（`src/tools/web-fetch.ts`、`src/tools/web-search.ts`）：`web_fetch` 仅 http/https、30s 超时、512KB 上限、HTML 轻量剥离；`web_search` 后端可换（duckduckgo 默认 / custom JSON 接口），两者只读且并发安全。
- **hooks**（`src/hooks/hooks.ts`）：Claude Code 配置格式（SessionStart/PreToolUse/PostToolUse/Stop）；命令经 stdin 收 JSON、env 带 `HOTPOT_HOOK_EVENT`、60s 超时；PreToolUse 非零退出阻断工具，每条命令落 `hook/fired`。
- **skill**（`src/skills/skills.ts`）：递归扫描 `SKILL.md`，最小 frontmatter 解析（`src/frontmatter/frontmatter.ts`，与 prompt templates 共用），只产出 name/description/path 清单。
- **prompt templates**（`src/prompt-templates/prompt-templates.ts`）：`*.md` → `/命令`，支持 `$ARGUMENTS`/`$1..$9`；展开由 CLI / server 负责，落 `prompt/invoked`。
- **设置扩展**（`src/config/config.ts`）：`features.*` 开关、`hooks`、`webSearch`、`mcpServers`、`skillsDirs`、`promptsDirs` 均仅用户级（安全理由见 schema 注释）；`featureEnabled` 为统一读取口（默认全开）。

## M6 工作区注册表

- **workspace**（`src/workspace/workspace.ts`）：`openWorkspaceRegistry({ home })` 读 `<home>/workspaces.json`（`{ version: 1, workspaces }`，缺文件为空态，损坏报 `invalid-storage`），写盘 tmp + rename 原子替换。
- 工作区是持久化实体（UUID、canonical `realpath`、默认标题取目录名、有序 `sessionIds`）；创建按 canonical 路径去重并插到列表头部，`reorder` 只接受完整排列。
- 会话归属单值：`attachSession` 先移出其它工作区再追加，`detachSession` 全局移除；`findByPath`/`workspaceForSession` 提供归属查询。错误统一为带 `code` 的 `WorkspaceError`。

