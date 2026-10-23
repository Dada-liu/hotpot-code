// steer/queue 双队列：next-turn（followup，turn 结束消费）与 next-step（steer/inject，step 顶部经
// LoopConfig.pollInbox 注入）。设计见 docs/archive/03-agent-orchestration.md 第 7 节。
// 每次变更动词先更新内存队列，再追加一条 inbox/spliced 事件（queue + 该队列全量快照）；
// foldInbox 从持久化事件流顺序转换出两队列最终状态，供崩溃恢复重建内存队列
// （createInbox 的 seed 选项直接消费 foldInbox 的返回，播种不追加新快照）。
// foldInbox 是纯函数、无 IO；变更动词的落盘走 createInbox 闭包的 session 句柄，append 本身带 fsync。

import { randomUUID } from "node:crypto";
import type {
	InboxMessage,
	InboxQueue,
	Session,
	SessionEvent,
} from "@hotpot/core";

export interface Inbox {
	// next-turn 排队（FIFO，turn 结束后消费）
	followup(content: string): Promise<void>;
	// next-step 排队并唤醒（经 pollInbox 下步注入）
	steer(content: string): Promise<void>;
	// next-step 排队不唤醒
	inject(content: string): Promise<void>;
	// 把 next-turn 中指定 id 的消息移入 next-step（web 队列条「转为 steer」）；
	// 未命中返回 false（调用方转 404），命中则两队列各落一条全量快照
	steerQueued(id: string): Promise<boolean>;
	// 移除 next-turn 中指定 id 的排队消息；未命中返回 false（调用方转 404），
	// 命中则落一条 next-turn 全量快照
	removeNextTurn(id: string): Promise<boolean>;
	// 调 opts.onCancel（CLI 侧接 AbortController）
	cancel(): void;
	// 取出并清空 next-turn
	drainNextTurn(): Promise<InboxMessage[]>;
	// 取出并清空 next-step（供 LoopConfig.pollInbox）
	pollNextStep(): Promise<string[]>;
	// 当前两队列快照（只读拷贝，供 web 展示；不改变队列、不落盘）
	snapshot(): InboxState;
}

export interface InboxState {
	nextTurn: InboxMessage[];
	nextStep: InboxMessage[];
}

// 按消息 id 去重：同 id 重复出现不重复入队，保留首次出现的位置（FIFO 次序稳定）
function dedupeById(messages: InboxMessage[]): InboxMessage[] {
	const seen = new Set<string>();
	const out: InboxMessage[] = [];
	for (const m of messages) {
		if (seen.has(m.id)) {
			continue;
		}
		seen.add(m.id);
		out.push(m);
	}
	return out;
}

export function createInbox(
	session: Session,
	agentId: string,
	opts?: { onCancel?: () => void; seed?: InboxState },
): Inbox {
	// seed 存在时以 foldInbox 的结果初始化两队列（崩溃恢复路径）：快照代表的
	// 意图已在上次变更动词时落盘，播种只重建内存队列，不追加 inbox/spliced。
	// 拷贝数组避免与调用方共享引用（drain 会整体替换队列）
	const state: InboxState = opts?.seed
		? {
				nextTurn: [...opts.seed.nextTurn],
				nextStep: [...opts.seed.nextStep],
			}
		: { nextTurn: [], nextStep: [] };

	// 变更动词共用路径：入队（同 id 去重）→ 落盘该队列全量快照
	async function splice(queue: InboxQueue, content: string): Promise<void> {
		const target = queue === "next-turn" ? state.nextTurn : state.nextStep;
		const message: InboxMessage = { id: randomUUID(), content };
		if (!target.some((m) => m.id === message.id)) {
			target.push(message);
		}
		await persistSnapshot(queue);
	}

	// 落盘指定队列的全量快照：foldInbox 按队列 last-write-wins 恢复，快照必须完整
	async function persistSnapshot(queue: InboxQueue): Promise<void> {
		const target = queue === "next-turn" ? state.nextTurn : state.nextStep;
		await session.append({
			type: "inbox/spliced",
			id: randomUUID(),
			ts: new Date().toISOString(),
			agentId,
			queue,
			messages: [...target],
		});
	}

	// steer 与 inject 的数据路径完全一致（都进 next-step，都落盘快照）；
	// 区别仅在于唤醒语义——steer 期望打断当前等待、让主 agent 尽快消费 next-step。
	// M2 不做进程内唤醒，唤醒由 CLI 在 turn 空闲时处理（Task 11），故两者实现相同。
	return {
		followup(content: string): Promise<void> {
			return splice("next-turn", content);
		},
		steer(content: string): Promise<void> {
			return splice("next-step", content);
		},
		inject(content: string): Promise<void> {
			return splice("next-step", content);
		},
		async steerQueued(id: string): Promise<boolean> {
			const message = state.nextTurn.find((m) => m.id === id);
			if (message === undefined) {
				return false;
			}
			state.nextTurn = state.nextTurn.filter((m) => m.id !== id);
			state.nextStep.push(message);
			// 两个队列都变了：各落一条全量快照，foldInbox last-write-wins 恢复才不会
			// 让已移走的消息在 next-turn 里复活
			await persistSnapshot("next-turn");
			await persistSnapshot("next-step");
			return true;
		},
		async removeNextTurn(id: string): Promise<boolean> {
			const message = state.nextTurn.find((m) => m.id === id);
			if (message === undefined) {
				return false;
			}
			state.nextTurn = state.nextTurn.filter((m) => m.id !== id);
			await persistSnapshot("next-turn");
			return true;
		},
		cancel(): void {
			// 不做队列变更：cancel 语义是中断当前 turn（CLI 侧 AbortController），
			// 已排队的消息是否保留由调用方决定
			opts?.onCancel?.();
		},
		async drainNextTurn(): Promise<InboxMessage[]> {
			const drained = state.nextTurn;
			if (drained.length === 0) {
				return drained;
			}
			state.nextTurn = [];
			// 消费即落盘：drain 是显式消费点，快照必须反映消费后的空队列。
			// 否则崩溃恢复/会话重开会把已执行的消息复活到队列里，下一个回合结束时
			// 再次被执行（重复执行比极小窗口内的消息丢失更严重）
			await persistSnapshot("next-turn");
			return drained;
		},
		async pollNextStep(): Promise<string[]> {
			const drained = state.nextStep;
			if (drained.length === 0) {
				return [];
			}
			state.nextStep = [];
			// 消费即落盘，理由同 drainNextTurn
			await persistSnapshot("next-step");
			return drained.map((m) => m.content);
		},
		// 快照返回拷贝：调用方（REST/UI）不得改写内部队列
		snapshot(): InboxState {
			return {
				nextTurn: [...state.nextTurn],
				nextStep: [...state.nextStep],
			};
		},
	};
}

// 从持久化事件流转换出两队列最终状态（崩溃恢复用）。
// 逐条处理 inbox/spliced：以快照整体替换对应队列（last write wins），并按消息 id 去重。
// 无 agentId 参数：转换全部 inbox 事件，不过滤——按 agent 隔离是调用方的职责
// （调用方只会把自己会话的事件传进来）；非 inbox 事件直接忽略。
export function foldInbox(events: SessionEvent[]): InboxState {
	const state: InboxState = { nextTurn: [], nextStep: [] };
	for (const e of events) {
		if (e.type !== "inbox/spliced") {
			continue;
		}
		if (e.queue === "next-turn") {
			state.nextTurn = dedupeById(e.messages);
		} else {
			state.nextStep = dedupeById(e.messages);
		}
	}
	return state;
}
