# src/inbox/

steer/queue 双队列：next-turn（followup，turn 结束后消费）与 next-step（steer/inject，step 顶部经 `LoopConfig.pollInbox` 注入）。

- `createInbox(session, agentId, opts?)` 返回 `Inbox`：
  - `followup(content)`：next-turn 入队（FIFO）。
  - `steer(content)`：next-step 入队并唤醒。
  - `inject(content)`：next-step 入队不唤醒。
  - `steerQueued(id)`：把 next-turn 中指定 id 的消息移入 next-step（web 队列条「转为 steer」）；未命中返回 false（调用方转 404）。跨队列移动会各落一条全量快照，foldInbox 恢复才不会让消息在 next-turn 里复活。
  - `removeNextTurn(id)`：移除 next-turn 中指定 id 的排队消息；未命中返回 false，命中落 next-turn 全量快照。
  - `cancel()`：调用 `opts.onCancel`（CLI 侧接 AbortController）。
  - `drainNextTurn()` / `pollNextStep()`：取出并清空对应队列；实际取到内容时追加一条空快照（消费即落盘），空队列调用为无操作。
  - `snapshot()`：两队列只读快照，不改变队列、不落盘。
- 每次变更先更新内存队列，再 append 一条 `inbox/spliced`（queue + 该队列全量快照）；跨队列变更（steerQueued）对两个队列各落一条。消费（drain/poll）也落空快照——否则崩溃恢复后已执行消息会复活，并被下个回合重复执行；代价是 drain 与 message 落盘之间极小窗口的丢失，重复执行是更严重的失败。
- `foldInbox(events)` 是纯函数、无 IO，按事件顺序重建 `InboxState`；`createInbox({ seed })` 直接消费它播种，不追加新快照。
- `index.ts` 是本特性的对外出口。
