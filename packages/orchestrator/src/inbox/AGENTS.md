# Working in src/inbox/

- Two queues with different semantics: next-turn (`followup`) is consumed after a turn ends; next-step (`steer`/`inject`) is injected at the top of a step through `LoopConfig.pollInbox`.
- Queue mutators `steerQueued(id)` (move a message from next-turn to next-step) and `removeNextTurn(id)` return `false` without persisting when the id is not found; callers map that to 404. A cross-queue move (steerQueued) must persist one full snapshot per affected queue — appending only the next-step snapshot would resurrect the message in next-turn after `foldInbox` recovery.
- Every mutation updates the in-memory queue first, then appends one `inbox/spliced` event carrying the queue name and a full snapshot of that queue. Keep the snapshot complete — `foldInbox` relies on last-write-wins per queue.
- Consumption is durable too: `drainNextTurn` and `pollNextStep` append an empty snapshot when they actually consume something (no-op on empty queues). Without it, recovery resurrects already-executed messages and the next turn end re-runs them. The tradeoff is a tiny crash window where a drained-but-not-yet-appended message is lost; duplicate execution is the worse failure.
- `foldInbox` is a pure function with no IO. Do not make it read sessions or mutate input.
- `createInbox({ seed })` restores from `foldInbox` and must not append a new snapshot while seeding.
- Deduplicate by message id while preserving first-occurrence FIFO order.
- `snapshot()` is read-only: it must not change queues or persist anything.
- Export the feature's public surface through `index.ts`; cross-feature imports target this file directly.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
