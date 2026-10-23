# src/approval/

`index.ts` 是本特性的对外出口；内部文件之间按具体路径导入。

审批 waterfall：`ApprovalChain` 按注册顺序询问各 handler，任一返回 allow/deny 即短路；全部返回 next（或未注册 handler）时默认 deny —— fail-closed，安全关键路径。

- `chain.ts` — `ApprovalRequest` / `ApprovalDecision` / `ApprovalHandler` / `ApprovalChain` / `allowAllHandler`。`use` 追加 handler，`ask` 顺序询问并短路。决策落 `approval/asked`、`approval/decided` 会话事件由上层（turn 循环）负责，本目录只实现链。
- `allowAllHandler`（M1）：full 权限模式的链头处理器，任何请求直接 allow、永不打断用户；只应作为链头注册，其后的 handler 因短路永远执行不到。经审计包装层落盘时仍留 asked/decided(approved) 审计对。
