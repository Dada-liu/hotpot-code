# CLI

`hotpot chat` 是行式交互入口：它只做终端 IO 与渲染，agent 逻辑全部在 core / orchestrator 中。

## 启动

```bash
hotpot chat [--session <会话文件路径>] [--tier high|medium|low]
```

- `--session`：恢复历史会话（`~/.hotpot/sessions/` 下的 JSONL 文件），追加续聊。
- `--tier`：主 agent 档位，默认取 `settings.mainAgentTier`，再默认 `high`。

## 事件流

对话过程中，终端会流式打印编排事件：

```text
[tool] read(path=src/index.ts)          # main 的工具调用
[tool_result] ...                        # 工具结果
[spawn] worker-1 (tier=low): <任务>      # 子 agent 诞生
[plan] drafted                           # 计划已起草，等待审批
[plan] approved                          # 计划已批准
```

worker / task 的内部事件不透出主流，其结果经 `spawn_workers` 的 tool_result 摘要回到终端。

## 审批交互

- **工具审批**：高危命令与覆盖写会询问 `y/n`，默认 `n`（fail-closed）。CLI 从用户级 `permission.mode` 读取权限档位，见[配置](/guide/configuration)。
- **plan 审批**：复杂任务首轮产出计划，打印全文后：
  - `y` 批准执行
  - `n` 拒绝
  - 其他非空行 = 批注，进入修订循环（上限 `planMaxRevisions` 轮）
  - 空行 / EOF = 拒绝（fail-closed）

批准前不会有任何文件改动。每次询问的 asked / decided 都会落盘会话日志，可审计。

## 回合控制

| 操作 | 效果 |
|------|------|
| `/exit` | 退出对话 |
| Ctrl-C | abort 当前回合（同时取消 steer/queue 队列），进程不退出 |

回合结束后，queued 消息按序补发为新用户消息；回合进行中可随时发送 steer 消息，在下一个 step 顶部注入模型历史。

## 斜杠命令（prompt templates）

启动时扫描 `settings.promptsDirs`、`<home>/prompts`、`<cwd>/.hotpot/prompts` 下的模板。输入 `/name args` 命中模板即展开（支持 `$ARGUMENTS` 与 `$1..$9` 占位）再跑回合；未命中会列出可用模板。

模板就是一个 Markdown 文件，例如 `~/.hotpot/prompts/review.md`：

```markdown
---
description: 审查当前改动的代码质量
---
请审查当前工作区的未提交改动，关注 $ARGUMENTS。
```

## 其他 M4 能力

以下能力在会话装配时自动接入，CLI 无额外操作：

- **skills**：启动扫描 `<home>/skills`、`<cwd>/.hotpot/skills`，清单渐进式注入提示词，模型按需 read 加载。
- **hooks**：按用户级 `settings.hooks`（Claude Code 格式）构造生命周期链，支持 `session_start` / pre/post tool / `turn_end`。
- **MCP**：按 `settings.mcpServers` 连接 stdio / streamable HTTP server，工具桥接为 `mcp__<server>__<tool>`。

功能开关集中在 `settings.features.*`（todo / hooks / skills / promptTemplates / webSearch / webFetch / mcp）。
