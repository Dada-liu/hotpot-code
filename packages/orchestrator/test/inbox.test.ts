// inbox 双队列测试：followup（next-turn FIFO）/ steer / inject（next-step）、
// 每个动词落盘一条 inbox/spliced 全量快照、foldInbox 从事件流转换恢复（模拟 kill 重启）、
// 消息 id 去重、cancel 调 onCancel。drain/poll 消费即落盘一条空快照
// （防止恢复后已执行消息复活、被下个回合重复执行）。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, loadSession, type SessionEvent } from "@hotpot/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInbox, foldInbox } from "../src/inbox/inbox.ts";

let home: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-inbox-home-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

// 从会话文件读出全部事件（drain 后复查落盘条数用）
async function loadEvents(filePath: string): Promise<SessionEvent[]> {
	const { events } = await loadSession(filePath);
	return events;
}

describe("createInbox 双队列语义", () => {
	it("followup×2 + steer×1：drainNextTurn FIFO 且清空，pollNextStep 取 steer 内容", async () => {
		const session = await createSession("/tmp/proj", home);
		const inbox = createInbox(session, "main");

		await inbox.followup("第一条");
		await inbox.followup("第二条");
		await inbox.steer("中途转向");

		const nextTurn = await inbox.drainNextTurn();
		expect(nextTurn.map((m) => m.content)).toEqual(["第一条", "第二条"]);
		expect(
			nextTurn.every((m) => typeof m.id === "string" && m.id.length > 0),
		).toBe(true);

		// 取空：再次 drain 返回空数组
		expect(await inbox.drainNextTurn()).toEqual([]);

		// next-step 不受影响；pollNextStep 返回字符串内容并清空
		expect(await inbox.pollNextStep()).toEqual(["中途转向"]);
		expect(await inbox.pollNextStep()).toEqual([]);
		expect(await inbox.drainNextTurn()).toEqual([]);
	});

	it("inject 与 steer 数据路径一致：进入 next-step 并可被 pollNextStep 取出", async () => {
		const session = await createSession("/tmp/proj", home);
		const inbox = createInbox(session, "main");

		await inbox.inject("静默补充");
		expect(await inbox.pollNextStep()).toEqual(["静默补充"]);
	});

	it("每个动词各落盘一条 inbox/spliced，messages 为该队列全量快照", async () => {
		const session = await createSession("/tmp/proj", home);
		const inbox = createInbox(session, "main");

		await inbox.followup("a");
		await inbox.followup("b");
		await inbox.steer("c");

		const events = await loadEvents(session.filePath);
		const spliced = events.filter((e) => e.type === "inbox/spliced");
		expect(spliced).toHaveLength(3);

		const [s1, s2, s3] = spliced;
		if (
			s1.type !== "inbox/spliced" ||
			s2.type !== "inbox/spliced" ||
			s3.type !== "inbox/spliced"
		) {
			throw new Error("unreachable: filtered above");
		}
		expect(s1.queue).toBe("next-turn");
		expect(s1.messages.map((m) => m.content)).toEqual(["a"]);
		expect(s2.queue).toBe("next-turn");
		expect(s2.messages.map((m) => m.content)).toEqual(["a", "b"]);
		expect(s3.queue).toBe("next-step");
		expect(s3.messages.map((m) => m.content)).toEqual(["c"]);
		for (const e of [s1, s2, s3]) {
			expect(e.agentId).toBe("main");
			expect(typeof e.id).toBe("string");
			expect(typeof e.ts).toBe("string");
		}
	});

	it("drain/poll 清空内存队列并各追加一条空快照（消费即落盘，防复活）", async () => {
		const session = await createSession("/tmp/proj", home);
		const inbox = createInbox(session, "main");

		await inbox.followup("a");
		await inbox.followup("b");
		await inbox.steer("c");
		expect(
			(await loadEvents(session.filePath)).filter(
				(e) => e.type === "inbox/spliced",
			),
		).toHaveLength(3);

		await inbox.drainNextTurn();
		await inbox.pollNextStep();
		const spliced = (await loadEvents(session.filePath)).filter(
			(e) => e.type === "inbox/spliced",
		);
		expect(spliced).toHaveLength(5);
		expect(
			spliced.slice(3).map((e) => (e.type === "inbox/spliced" ? e.queue : "")),
		).toEqual(["next-turn", "next-step"]);
		// 空快照 = foldInbox 恢复后队列为空（已消费消息不复活）
		expect(foldInbox(await loadEvents(session.filePath))).toEqual({
			nextTurn: [],
			nextStep: [],
		});
	});

	it("foldInbox 从事件流转换出两队列最终状态（模拟 kill 后恢复）", async () => {
		const session = await createSession("/tmp/proj", home);
		const inbox = createInbox(session, "main");

		await inbox.followup("a");
		await inbox.followup("b");
		await inbox.steer("c");
		// 模拟 kill：不落新事件，直接从文件重新转换
		const folded = foldInbox(await loadEvents(session.filePath));
		expect(folded.nextTurn.map((m) => m.content)).toEqual(["a", "b"]);
		expect(folded.nextStep.map((m) => m.content)).toEqual(["c"]);
	});

	it("foldInbox 忽略非 inbox 事件", async () => {
		const events: SessionEvent[] = [
			{
				type: "meta",
				sessionId: "s",
				createdAt: "2026-10-16T00:00:00.000Z",
				cwd: "/tmp",
				formatVersion: 1,
			},
			{
				type: "user_msg",
				id: "u1",
				ts: "2026-10-16T00:00:00.000Z",
				agentId: "main",
				content: "hi",
			},
			{
				type: "inbox/spliced",
				id: "i1",
				ts: "2026-10-16T00:00:01.000Z",
				agentId: "main",
				queue: "next-turn",
				messages: [{ id: "m1", content: "x" }],
			},
		];
		const folded = foldInbox(events);
		expect(folded.nextTurn).toEqual([{ id: "m1", content: "x" }]);
		expect(folded.nextStep).toEqual([]);
	});

	it("消息 id 去重：同 id 消息重复 splice 不重复入队", async () => {
		const ts = "2026-10-16T00:00:00.000Z";
		const mk = (queue: "next-turn" | "next-step"): SessionEvent => ({
			type: "inbox/spliced",
			id: `ev-${queue}`,
			ts,
			agentId: "main",
			queue,
			messages: [
				{ id: "m1", content: "first" },
				{ id: "m1", content: "first" },
				{ id: "m2", content: "second" },
			],
		});
		const folded = foldInbox([mk("next-turn"), mk("next-step")]);
		expect(folded.nextTurn).toEqual([
			{ id: "m1", content: "first" },
			{ id: "m2", content: "second" },
		]);
		expect(folded.nextStep).toEqual([
			{ id: "m1", content: "first" },
			{ id: "m2", content: "second" },
		]);
	});

	it("seed 播种恢复：两队列初始化为 foldInbox 形状，播种本身不落盘；消费与后续变更照常落快照", async () => {
		const session = await createSession("/tmp/proj", home);
		const seed = {
			nextTurn: [{ id: "f1", content: "followup-1" }],
			nextStep: [
				{ id: "s1", content: "steer-1" },
				{ id: "s2", content: "steer-2" },
			],
		};
		const inbox = createInbox(session, "main", { seed });

		// 播种本身不追加 inbox/spliced（快照只由变更动词/消费落盘）
		expect(
			(await loadEvents(session.filePath)).filter(
				(e) => e.type === "inbox/spliced",
			),
		).toHaveLength(0);

		// 播种内容可直接消费，顺序保持
		expect(await inbox.pollNextStep()).toEqual(["steer-1", "steer-2"]);
		expect(await inbox.pollNextStep()).toEqual([]);
		const nextTurn = await inbox.drainNextTurn();
		expect(nextTurn.map((m) => m.content)).toEqual(["followup-1"]);
		expect(await inbox.drainNextTurn()).toEqual([]);

		// 两次消费各落一条空快照；随后变更动词照常落该队列全量快照（只含新消息）
		await inbox.followup("新 followup");
		const spliced = (await loadEvents(session.filePath)).filter(
			(e) => e.type === "inbox/spliced",
		);
		expect(spliced).toHaveLength(3);
		const first = spliced[0];
		if (first.type !== "inbox/spliced") throw new Error("unreachable");
		const last = spliced[2];
		if (last.type !== "inbox/spliced") throw new Error("unreachable");
		expect(last.messages.map((m) => m.content)).toEqual(["新 followup"]);
	});

	it("cancel：每次调用触发一次 onCancel，不做队列变更、不落盘", async () => {
		const session = await createSession("/tmp/proj", home);
		const onCancel = vi.fn();
		const inbox = createInbox(session, "main", { onCancel });

		await inbox.followup("a");
		inbox.cancel();
		inbox.cancel();
		expect(onCancel).toHaveBeenCalledTimes(2);

		// cancel 不动队列、不落盘（在消费前断言，避免 drain 的空快照干扰）
		expect(inbox.snapshot().nextTurn).toHaveLength(1);
		expect(
			(await loadEvents(session.filePath)).filter(
				(e) => e.type === "inbox/spliced",
			),
		).toHaveLength(1);
		// 消费照常可取出（消费本身会追加空快照，见 drain 用例）
		expect(await inbox.drainNextTurn()).toHaveLength(1);
	});

	it("cancel 未提供 onCancel 时不抛错", async () => {
		const session = await createSession("/tmp/proj", home);
		const inbox = createInbox(session, "main");
		expect(() => inbox.cancel()).not.toThrow();
	});

	it("snapshot 返回两队列当前状态拷贝；drain/poll 后快照为空", async () => {
		const session = await createSession("/tmp/proj", home);
		const inbox = createInbox(session, "main");
		await inbox.followup("later");
		await inbox.steer("now");

		const snap = inbox.snapshot();
		expect(snap.nextTurn.map((m) => m.content)).toEqual(["later"]);
		expect(snap.nextStep.map((m) => m.content)).toEqual(["now"]);

		// 拷贝语义：调用方改写快照不影响内部队列
		snap.nextTurn.push({ id: "fake", content: "外部注入" });
		snap.nextStep.length = 0;
		expect(inbox.snapshot().nextTurn.map((m) => m.content)).toEqual(["later"]);
		expect(inbox.snapshot().nextStep.map((m) => m.content)).toEqual(["now"]);

		await inbox.drainNextTurn();
		await inbox.pollNextStep();
		expect(inbox.snapshot()).toEqual({ nextTurn: [], nextStep: [] });
	});
});

// M1 队列变更动词：steerQueued（next-turn → next-step）与 removeNextTurn（删排队消息）。
// 两者都按「先内存、后落盘全量快照」的纪律走，foldInbox 崩溃恢复必须与内存状态一致；
// 未命中返回 false（server 层转 404）且不落盘
describe("createInbox 队列变更动词（M1）", () => {
	it("steerQueued：消息从 next-turn 移入 next-step，两队列各落一条全量快照", async () => {
		const session = await createSession("/tmp/proj", home);
		const inbox = createInbox(session, "main");
		await inbox.followup("a");
		await inbox.followup("b");
		await inbox.steer("c");

		const queued = inbox.snapshot().nextTurn;
		expect(await inbox.steerQueued(queued[1]?.id ?? "")).toBe(true);

		// 内存队列：b 移入 next-step（排在 c 之后），next-turn 剩 a
		expect(inbox.snapshot().nextTurn.map((m) => m.content)).toEqual(["a"]);
		expect(inbox.snapshot().nextStep.map((m) => m.content)).toEqual(["c", "b"]);

		const events = await loadEvents(session.filePath);
		const spliced = events.filter((e) => e.type === "inbox/spliced");
		// followup×2 + steer×1 + steerQueued 落的 next-turn/next-step 两条 = 5
		expect(spliced).toHaveLength(5);
		const turnSnapshots = spliced.filter(
			(e) => e.type === "inbox/spliced" && e.queue === "next-turn",
		);
		const stepSnapshots = spliced.filter(
			(e) => e.type === "inbox/spliced" && e.queue === "next-step",
		);
		const lastTurn = turnSnapshots[turnSnapshots.length - 1];
		const lastStep = stepSnapshots[stepSnapshots.length - 1];
		if (
			lastTurn?.type !== "inbox/spliced" ||
			lastStep?.type !== "inbox/spliced"
		) {
			throw new Error("unreachable: filtered above");
		}
		expect(lastTurn.messages.map((m) => m.content)).toEqual(["a"]);
		expect(lastStep.messages.map((m) => m.content)).toEqual(["c", "b"]);
	});

	it("steerQueued 的 foldInbox 恢复：移走的消息不会在 next-turn 里复活", async () => {
		const session = await createSession("/tmp/proj", home);
		const inbox = createInbox(session, "main");
		await inbox.followup("a");
		await inbox.followup("b");
		const queued = inbox.snapshot().nextTurn;
		expect(await inbox.steerQueued(queued[0]?.id ?? "")).toBe(true);

		// 模拟 kill：直接从文件重新转换
		const folded = foldInbox(await loadEvents(session.filePath));
		expect(folded.nextTurn.map((m) => m.content)).toEqual(["b"]);
		expect(folded.nextStep.map((m) => m.content)).toEqual(["a"]);
	});

	it("steerQueued 未命中：返回 false，队列与落盘都不变", async () => {
		const session = await createSession("/tmp/proj", home);
		const inbox = createInbox(session, "main");
		await inbox.followup("a");

		expect(await inbox.steerQueued("no-such-id")).toBe(false);
		expect(inbox.snapshot().nextTurn.map((m) => m.content)).toEqual(["a"]);
		expect(inbox.snapshot().nextStep).toEqual([]);
		expect(
			(await loadEvents(session.filePath)).filter(
				(e) => e.type === "inbox/spliced",
			),
		).toHaveLength(1);
	});

	it("removeNextTurn：移除指定排队消息并落 next-turn 全量快照", async () => {
		const session = await createSession("/tmp/proj", home);
		const inbox = createInbox(session, "main");
		await inbox.followup("a");
		await inbox.followup("b");

		const queued = inbox.snapshot().nextTurn;
		expect(await inbox.removeNextTurn(queued[0]?.id ?? "")).toBe(true);
		expect(inbox.snapshot().nextTurn.map((m) => m.content)).toEqual(["b"]);

		// foldInbox 恢复与内存一致
		const folded = foldInbox(await loadEvents(session.filePath));
		expect(folded.nextTurn.map((m) => m.content)).toEqual(["b"]);

		const spliced = (await loadEvents(session.filePath)).filter(
			(e) => e.type === "inbox/spliced",
		);
		const last = spliced[spliced.length - 1];
		if (last?.type !== "inbox/spliced") throw new Error("unreachable");
		expect(last.queue).toBe("next-turn");
		expect(last.messages.map((m) => m.content)).toEqual(["b"]);
	});

	it("removeNextTurn 未命中：返回 false，队列与落盘都不变", async () => {
		const session = await createSession("/tmp/proj", home);
		const inbox = createInbox(session, "main");
		await inbox.followup("a");

		expect(await inbox.removeNextTurn("no-such-id")).toBe(false);
		expect(inbox.snapshot().nextTurn.map((m) => m.content)).toEqual(["a"]);
		expect(
			(await loadEvents(session.filePath)).filter(
				(e) => e.type === "inbox/spliced",
			),
		).toHaveLength(1);
	});
});
