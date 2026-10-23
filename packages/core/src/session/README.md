# src/session/

`index.ts` 是本特性的对外出口；内部文件之间按具体路径导入。

会话事件日志：append-only JSONL，**日志即唯一事实源**。UI 与 LLM 历史都由日志转换得出，不存在并行的可变状态。

- `events.ts` — `SessionEvent` 联合类型（v1 定稿）。字段对齐 `docs/archive/02-architecture.md` 第 5 节；M1 只写入 meta/user_msg/assistant_msg/tool_call/tool_result/error，M2 起 agent_spawn、approval/*、inbox/spliced 由编排层（packages/orchestrator）产出；agent_end（下层 agent turn 收尾）同由编排层产出，web 面板卡片状态的数据源，不进模型历史；permission/changed（权限模式切换审计，M1）同样不进模型历史，由 reducer 忽略渲染。
- `store.ts` — 读写：`createSession`（建目录、写 meta 首行）、`Session.append`（追加一行并 fsync，崩溃最多丢最后一行）、`loadSession`（按行解析，坏行跳过，meta 缺失抛错）、`listSessions`（读各文件 meta 出摘要）、`resumeSession`（校验 meta 后恢复 append 句柄，供 `--session` 续聊）、`resolveHome`（home 解析，导出供 `config.ts` 复用）。
- `derive.ts` — `deriveMessages(events, agentId)`：转换出 ai 包的 `Message[]`。tool_result 转换为 role:"user" 消息，连续 tool_result 合并为一条，且按 agentId 过滤（无 agentId 的旧日志视为 "main"）；其余事件类型不进历史。
- `todos.ts` — `foldTodos(events, agentId)`：重建某 agent 的当前 todo 清单。只认该 agentId 的 `todo/set` 事件，last-write-wins（快照即全量列表）；无记录返回空数组。`todo/set` 不进模型历史，清单状态由本 fold 纯函数重建。

路径规则：`$HOTPOT_HOME/sessions/<cwd 编码（/ 与 : 替换为 -）>/<yyyymmdd-hhmmss>_<session-id>.jsonl`；home 优先级为参数 > `HOTPOT_HOME` 环境变量 > `~/.hotpot`。
