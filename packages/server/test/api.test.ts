// HTTP API 集成测试（M3）：真实端口 + fetch + SSE 流式消费。
// 夹具与 session-manager.test.ts 同款（mkdtemp home/proj、三档 settings、scriptedAdapter 不触网），
// 每用例独立 manager + 独立 home + 独立端口，避免串扰。
// SSE 连接用 AbortController 中断模拟断线；重连经 Last-Event-ID / ?after= 补发。

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import {
	type LlmAdapter,
	type ModelInfo,
	type StreamEvent,
	scriptedAdapter,
	type Usage,
} from "@hotpot/ai";
import type * as CoreMod from "@hotpot/core";
import {
	createSession as createDiskSession,
	loadSession,
	type Settings,
} from "@hotpot/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import {
	createSessionManager,
	type SessionManager,
} from "../src/session-manager.ts";
import type { WireEvent } from "../src/wire.ts";

// loadSession 闸：只在 miss 重放用例里 armed。测试据此把「包装 sink 已注册、
// loadSession 尚未返回」的窗口拉开到确定性长度——窗口内发出的 live 事件
// 必须经 pending 泄洪到达重连连接（否则永久丢失）。
const gate = vi.hoisted(() => {
	let enteredResolve: (() => void) | null = null;
	return {
		armed: false as boolean,
		entered: new Promise<void>((resolve) => {
			enteredResolve = resolve;
		}),
		release: null as (() => void) | null,
		markEntered(): void {
			enteredResolve?.();
		},
	};
});

vi.mock("@hotpot/core", async (importOriginal) => {
	const mod = await importOriginal<typeof CoreMod>();
	// 只闸住第一个 armed 调用者（SSE 重放的 loadSession）。turn 收尾时遥测采集器
	// 也会经本模块读会话日志折叠 turn_end（collector.ts），不能让它一起被闸住，
	// 否则窗口内回合无法结束、turn(end) 永远广播不出去
	let held = false;
	return {
		...mod,
		loadSession: async (filePath: string) => {
			if (gate.armed && !held) {
				held = true;
				gate.markEntered();
				await new Promise<void>((resolve) => {
					gate.release = resolve;
				});
			}
			return mod.loadSession(filePath);
		},
	};
});

// llm 注入模式共用的模型信息（scriptedAdapter 只看 adapter，model 仅作记账）
const MODEL: ModelInfo = {
	id: "test-high",
	provider: "test-provider",
	api: "openai-completions",
	contextWindow: 128000,
	maxTokens: 8192,
	cost: { input: 0, output: 0 },
};

// ---- 服务端 harness：manager + app + 真实端口 ----

interface ApiFixture {
	home: string;
	proj: string;
	manager: SessionManager;
	base: string;
	close: () => Promise<void>;
}

const fixtures: ApiFixture[] = [];

// 每用例一套：home 写三档 settings（policy 按场景），端口 0 由系统分配
async function startApi(
	adapter: LlmAdapter,
	policy?: "ask-on-dangerous" | "always" | "never",
): Promise<ApiFixture> {
	const home = await mkdtemp(join(tmpdir(), "hotpot-api-home-"));
	const proj = await mkdtemp(join(tmpdir(), "hotpot-api-proj-"));
	await writeFile(join(proj, "note.txt"), "hello hotpot\n", "utf8");
	const settings: Settings = {
		models: {
			high: { provider: "test-provider", model: "test-high", apiKey: "hk" },
			medium: { provider: "test-provider", model: "test-medium", apiKey: "mk" },
			low: { provider: "test-provider", model: "test-low", apiKey: "lk" },
		},
		...(policy === undefined ? {} : { approval: { policy } }),
	};
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify(settings),
		"utf8",
	);

	const manager = createSessionManager({
		home,
		llm: { adapter, model: MODEL },
	});
	// settings 路由指向同一 home（测试注入临时目录，避免读写真实 ~/.hotpot）
	const app = createApp(manager, { home });
	const server = serve({ fetch: app.fetch, port: 0 });
	// address() 仅在 listening 后可用；挂在 listening 事件上取系统分配的实际端口
	const port = await new Promise<number>((resolve, reject) => {
		server.on("listening", () => {
			const addr = server.address();
			if (typeof addr === "object" && addr !== null) resolve(addr.port);
			else reject(new Error("server 地址不可用"));
		});
	});
	// 关服：先掐断所有连接（含挂起的 SSE），再等 server 关闭回调
	const fx: ApiFixture = {
		home,
		proj,
		manager,
		base: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>((resolveClose) => {
				server.closeAllConnections();
				server.close(() => resolveClose());
			}),
	};
	fixtures.push(fx);
	return fx;
}

afterEach(async () => {
	while (fixtures.length > 0) {
		const fx = fixtures.pop();
		if (fx === undefined) break;
		await fx.close();
		await rm(fx.home, { recursive: true, force: true });
		await rm(fx.proj, { recursive: true, force: true });
	}
});

// ---- HTTP 小工具 ----

async function postJson(url: string, body?: unknown): Promise<Response> {
	return fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

async function createSession(
	fx: ApiFixture,
	cwd?: string,
): Promise<{ id: string }> {
	const res = await postJson(
		`${fx.base}/api/sessions`,
		cwd === undefined ? {} : { cwd },
	);
	expect(res.status).toBe(201);
	return (await res.json()) as { id: string };
}

// ---- SSE 客户端：逐帧解析（id/data），事件 JSON 化后入 events ----

interface SseFrame {
	id: string | null;
	data: string;
}

interface SseHandle {
	controller: AbortController;
	frames: SseFrame[];
	events: WireEvent[];
	close: () => void;
	waitFor: (pred: () => boolean, timeoutMs?: number) => Promise<void>;
}

// 增量式分帧：按空行切帧，忽略注释行（: ping），取 id: 与 data: 行
function createFrameParser(
	onFrame: (f: SseFrame) => void,
): (chunk: string) => void {
	let pending = "";
	return (chunk) => {
		pending += chunk;
		for (;;) {
			const sep = pending.indexOf("\n\n");
			if (sep < 0) return;
			const raw = pending.slice(0, sep);
			pending = pending.slice(sep + 2);
			let id: string | null = null;
			const data: string[] = [];
			for (const line of raw.split("\n")) {
				if (line === "" || line.startsWith(":")) continue;
				if (line.startsWith("id: ")) id = line.slice(4);
				else if (line.startsWith("data: ")) data.push(line.slice(6));
			}
			if (id !== null || data.length > 0)
				onFrame({ id, data: data.join("\n") });
		}
	};
}

async function openSse(
	base: string,
	sessionId: string,
	opts?: { after?: number; lastEventId?: string },
): Promise<SseHandle> {
	const url = new URL(`${base}/api/sessions/${sessionId}/events`);
	if (opts?.after !== undefined)
		url.searchParams.set("after", String(opts.after));
	const headers: Record<string, string> = {};
	if (opts?.lastEventId !== undefined)
		headers["Last-Event-ID"] = opts.lastEventId;
	const controller = new AbortController();
	const res = await fetch(url, { headers, signal: controller.signal });
	if (!res.ok || res.body === null) {
		throw new Error(`SSE 连接失败: ${res.status}`);
	}
	const frames: SseFrame[] = [];
	const events: WireEvent[] = [];
	const parse = createFrameParser((f) => {
		frames.push(f);
		if (f.data !== "") events.push(JSON.parse(f.data) as WireEvent);
	});
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	void (async () => {
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				parse(decoder.decode(value, { stream: true }));
			}
		} catch {
			// 断线（AbortError 等）噪音：已收到的部分已解析入帧
		}
	})();
	const waitFor = async (pred: () => boolean, timeoutMs = 10000) => {
		const deadline = Date.now() + timeoutMs;
		while (!pred()) {
			if (Date.now() > deadline) throw new Error("SSE waitFor 超时");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	return {
		controller,
		frames,
		events,
		close: () => controller.abort(),
		waitFor,
	};
}

// ---- 断言辅助 ----

// 条件轮询（观察哨等 SSE 句柄之外的等待点）
async function waitUntil(
	cond: () => boolean,
	timeoutMs = 10000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("waitUntil 超时");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function isLog(e: WireEvent): e is Extract<WireEvent, { kind: "log" }> {
	return e.kind === "log";
}

function isTurnEnd(e: WireEvent): boolean {
	return e.kind === "turn" && e.phase === "end";
}

function describeEvent(e: WireEvent): string {
	if (e.kind === "turn") return `turn:${e.phase}`;
	if (e.kind === "log") return `log:${e.event.type}`;
	if (e.kind === "plan") return `plan:${e.phase}`;
	return e.kind;
}

// ---- 脚本轮辅助（与 session-manager.test.ts 同款） ----

function toolCallRound(
	name: string,
	id: string,
	inputJson: string,
): StreamEvent[] {
	return [
		{ type: "tool_call_start", id, name },
		{ type: "tool_call_delta", id, inputDelta: inputJson },
		{ type: "tool_call_end", id },
		{ type: "usage", usage: { input: 100, output: 20 } },
		{ type: "finish", reason: "tool_calls" },
	];
}

function textRound(delta: string, usage: Usage): StreamEvent[] {
	return [
		{ type: "text_delta", delta },
		{ type: "usage", usage },
		{ type: "finish", reason: "stop" },
	];
}

function spawnWorkersRound(inputJson: string): StreamEvent[] {
	return toolCallRound("spawn_workers", "m-tc-2", inputJson);
}

// main 首轮的 spawn_workers 轮：simple 直派一个 low 档 worker
function spawnSimpleRound(task: string): StreamEvent[] {
	return toolCallRound(
		"spawn_workers",
		"m-tc-1",
		JSON.stringify({ workers: [{ task, modelTier: "low" }] }),
	);
}

describe("HTTP API", () => {
	it("完整回合：建会话→发消息→SSE 按序 log(meta)/turn(start)/log(user_msg)/delta/log(assistant_msg)/turn(end)，id 单调", async () => {
		const fx = await startApi(
			scriptedAdapter([textRound("脚本回答", { input: 10, output: 5 })]),
			"never",
		);
		const { id } = await createSession(fx, fx.proj);

		// 列表/详情：turn 空闲态
		const list = (await (await fetch(`${fx.base}/api/sessions`)).json()) as {
			sessions: { id: string; cwd: string; createdAt: string; turn: string }[];
		};
		const mine = list.sessions.find((s) => s.id === id);
		expect(mine).toMatchObject({ id, cwd: fx.proj, turn: "idle" });
		expect(typeof mine?.createdAt).toBe("string");

		const sse = await openSse(fx.base, id);
		const msgRes = await postJson(`${fx.base}/api/sessions/${id}/messages`, {
			content: "你好",
		});
		expect(msgRes.status).toBe(202);
		expect(await msgRes.json()).toEqual({});

		await sse.waitFor(() => sse.events.some(isTurnEnd));
		sse.close();

		expect(sse.events.map(describeEvent)).toEqual([
			"log:meta",
			"turn:start",
			"log:user_msg",
			"delta",
			"log:assistant_msg",
			"turn:end",
		]);
		// seq 单调递增，且 SSE 帧 id 与事件 seq 一致
		const seqs = sse.events.map((e) => e.seq);
		expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
		expect(sse.frames.length).toBe(sse.events.length);
		for (let i = 0; i < sse.frames.length; i++) {
			expect(Number(sse.frames[i]?.id)).toBe(sse.events[i]?.seq);
		}

		// 详情/usage 在回合结束后
		const detail = (await (
			await fetch(`${fx.base}/api/sessions/${id}`)
		).json()) as {
			id: string;
			cwd: string;
			createdAt: string;
			filePath: string;
			turn: string;
			usage: { total: { input: number; output: number } };
		};
		expect(detail).toMatchObject({ id, cwd: fx.proj, turn: "idle" });
		expect(typeof detail.filePath).toBe("string");
		expect(detail.usage.total).toEqual({ input: 10, output: 5 });

		const usage = (await (
			await fetch(`${fx.base}/api/sessions/${id}/usage`)
		).json()) as { total: { input: number; output: number } };
		expect(usage.total).toEqual({ input: 10, output: 5 });
	}, 20000);

	it("断线重连：Last-Event-ID 增量补发不丢序；query after 优先于头；超大 after 回退全量日志重放", async () => {
		const fx = await startApi(
			scriptedAdapter([
				textRound("回答一", { input: 10, output: 5 }),
				textRound("回答二", { input: 10, output: 5 }),
			]),
			"never",
		);
		const { id } = await createSession(fx, fx.proj);
		const sse1 = await openSse(fx.base, id);
		await postJson(`${fx.base}/api/sessions/${id}/messages`, {
			content: "第一条",
		});
		await sse1.waitFor(() => sse1.events.some(isTurnEnd));
		const turn1StartSeq = sse1.events.find(
			(e) => e.kind === "turn" && e.phase === "start",
		)?.seq;
		const lastId = sse1.frames[sse1.frames.length - 1]?.id;
		if (
			turn1StartSeq === undefined ||
			lastId === null ||
			lastId === undefined
		) {
			throw new Error("第一回合事件缺失");
		}
		sse1.close();

		// 断线期间发出第二条消息（turn 串行执行完）
		await postJson(`${fx.base}/api/sessions/${id}/messages`, {
			content: "第二条",
		});
		await new Promise((resolve) => setTimeout(resolve, 500));

		// 增量补发：断线期间事件一条不丢，seq 从 lastId+1 起连续
		const sse2 = await openSse(fx.base, id, { lastEventId: lastId });
		await sse2.waitFor(() => sse2.events.filter(isTurnEnd).length === 1);
		sse2.close();
		expect(sse2.events.map(describeEvent)).toEqual([
			"turn:start",
			"log:user_msg",
			"delta",
			"log:assistant_msg",
			"turn:end",
		]);
		const firstSeq = sse2.events[0]?.seq ?? 0;
		expect(firstSeq).toBe(Number(lastId) + 1);
		expect(sse2.events.map((e) => e.seq)).toEqual([
			firstSeq,
			firstSeq + 1,
			firstSeq + 2,
			firstSeq + 3,
			firstSeq + 4,
		]);
		const userMsg = sse2.events.find(
			(e) => isLog(e) && e.event.type === "user_msg",
		);
		if (userMsg?.kind !== "log" || userMsg.event.type !== "user_msg") {
			throw new Error("user_msg 缺失");
		}
		expect(userMsg.event.content).toBe("第二条");
		expect(
			sse2.events
				.filter((e) => e.kind === "delta")
				.map((e) => (e.kind === "delta" ? e.text : ""))
				.join(""),
		).toBe("回答二");

		// query 优先于 Last-Event-ID：after 取更早的 turn1StartSeq-1，
		// 首帧应是第一回合的 turn(start)
		const sseQ = await openSse(fx.base, id, {
			after: turn1StartSeq - 1,
			lastEventId: lastId,
		});
		await sseQ.waitFor(() => sseQ.events.filter(isTurnEnd).length === 2);
		sseQ.close();
		expect(sseQ.events[0]?.seq).toBe(turn1StartSeq);

		// 超大 after（掉出留存窗口）：回退全量日志重放——
		// 只收 log 事件、覆盖完整历史、id 重新连续；空闲会话不再补发合成 turn(end)
		// （agent 状态由 durable 的 agent_end 驱动，纯 main 回合的日志里没有该事件）
		const sseR = await openSse(fx.base, id, { after: 999999 });
		await sseR.waitFor(() => sseR.events.filter(isLog).length >= 5, 10000);
		sseR.close();
		expect(sseR.events.every((e) => e.kind === "log")).toBe(true);
		const replayLogs = sseR.events.filter(isLog);
		expect(replayLogs.map((e) => e.event.type)).toEqual([
			"meta",
			"user_msg",
			"assistant_msg",
			"user_msg",
			"assistant_msg",
		]);
		const r0 = replayLogs[0]?.seq ?? 0;
		expect(replayLogs.map((e) => e.seq)).toEqual([
			r0,
			r0 + 1,
			r0 + 2,
			r0 + 3,
			r0 + 4,
		]);
		const contents = replayLogs
			.filter((e) => e.event.type === "user_msg")
			.map((e) => (e.event.type === "user_msg" ? e.event.content : ""));
		expect(contents).toEqual(["第一条", "第二条"]);
	}, 20000);

	it("miss 重放不丢窗口内事件：loadSession 期间到达的 live 事件经 pending 泄洪补发，先历史后 live 且不重复", async () => {
		const fx = await startApi(
			scriptedAdapter([
				textRound("历史回答", { input: 10, output: 5 }),
				textRound("回答二", { input: 10, output: 5 }),
			]),
			"never",
		);
		const { id } = await createSession(fx, fx.proj);
		// 观察哨（直接 manager 订阅）：判定 live 事件已广播——即重连连接的包装 sink 已收到
		const observed: WireEvent[] = [];
		fx.manager.subscribe(id, null, (e) => {
			observed.push(e);
		});
		await postJson(`${fx.base}/api/sessions/${id}/messages`, {
			content: "第一条",
		});
		await waitUntil(() => observed.filter(isTurnEnd).length === 1);

		// 武装闸并发起 miss 重连：服务端注册包装 sink 后进入被闸住的 loadSession
		gate.armed = true;
		const ssePromise = openSse(fx.base, id, { after: 999999 });
		try {
			await gate.entered;
			// 窗口内发出第二条消息：整个第二回合（turn 瞬态 + durable 日志）
			// 都只广播给已注册订阅者（包装 sink 收进 pending）
			await postJson(`${fx.base}/api/sessions/${id}/messages`, {
				content: "第二条",
			});
			await waitUntil(() => observed.filter(isTurnEnd).length === 2);
		} finally {
			gate.release?.();
			gate.armed = false;
		}

		const sse = await ssePromise;
		await sse.waitFor(() => sse.events.filter(isTurnEnd).length === 1);
		sse.close();

		// 重放（文件历史，含窗口内第二回合的 durable——快照在放闸后读取）在前；
		// 瞬态 turn(start)/delta/turn(end) 不在日志里，只能经 pending 泄洪到达。
		// 旧实现无包装 sink，窗口内这 3 个瞬态事件会永久丢失
		expect(sse.events.map(describeEvent)).toEqual([
			"log:meta",
			"log:user_msg",
			"log:assistant_msg",
			"log:user_msg",
			"log:assistant_msg",
			"turn:start",
			"delta",
			"turn:end",
		]);
		const durableIds = sse.events
			.filter(isLog)
			.map((e) => (e.event.type === "meta" ? "meta" : e.event.id));
		expect(new Set(durableIds).size).toBe(durableIds.length);
		const secondMsg = sse.events.filter(
			(e) =>
				isLog(e) && e.event.type === "user_msg" && e.event.content === "第二条",
		);
		expect(secondMsg.length).toBe(1);
	}, 20000);

	it("审批全流程：bash 高危→SSE 收 approval→turn running→allow→log(approval/decided)+turn(end)→idle；未知 requestId→404", async () => {
		const fx = await startApi(
			scriptedAdapter([
				spawnSimpleRound("清理临时目录 x"),
				toolCallRound("bash", "w-tc-1", '{"command":"rm -rf x"}'),
				textRound("清理完成。", { input: 50, output: 10 }),
				textRound("临时目录已清理。", { input: 20, output: 5 }),
			]),
			"ask-on-dangerous",
		);
		const { id } = await createSession(fx, fx.proj);
		const sse = await openSse(fx.base, id);
		const msgRes = await postJson(`${fx.base}/api/sessions/${id}/messages`, {
			content: "清理临时目录",
		});
		expect(msgRes.status).toBe(202);

		await sse.waitFor(() => sse.events.some((e) => e.kind === "approval"));
		const approval = sse.events.find((e) => e.kind === "approval");
		if (approval?.kind !== "approval") throw new Error("approval 事件缺失");
		expect(approval.approvalType).toBe("tool");
		expect(approval.summary).toContain("rm -rf x");
		expect(typeof approval.requestId).toBe("string");

		// 未应答期间回合挂起：详情为 running
		await new Promise((resolve) => setTimeout(resolve, 300));
		const runningDetail = (await (
			await fetch(`${fx.base}/api/sessions/${id}`)
		).json()) as { turn: string };
		expect(runningDetail.turn).toBe("running");
		expect(sse.events.some(isTurnEnd)).toBe(false);

		// 未知 requestId → 404
		const unknownRes = await postJson(
			`${fx.base}/api/sessions/${id}/approvals/no-such-request`,
			{ decision: "allow" },
		);
		expect(unknownRes.status).toBe(404);
		const unknownBody = (await unknownRes.json()) as { error: string };
		expect(typeof unknownBody.error).toBe("string");

		const allowRes = await postJson(
			`${fx.base}/api/sessions/${id}/approvals/${approval.requestId}`,
			{ decision: "allow" },
		);
		expect(allowRes.status).toBe(200);

		await sse.waitFor(() => sse.events.some(isTurnEnd));
		sse.close();
		const askedIdx = sse.events.findIndex(
			(e) => isLog(e) && e.event.type === "approval/asked",
		);
		const decidedIdx = sse.events.findIndex(
			(e) => isLog(e) && e.event.type === "approval/decided",
		);
		const endIdx = sse.events.findIndex(isTurnEnd);
		expect(askedIdx).toBeGreaterThan(-1);
		expect(decidedIdx).toBeGreaterThan(askedIdx);
		expect(endIdx).toBeGreaterThan(decidedIdx);

		const idleDetail = (await (
			await fetch(`${fx.base}/api/sessions/${id}`)
		).json()) as { turn: string };
		expect(idleDetail.turn).toBe("idle");
	}, 20000);

	it("plan 全流程：drafted→POST plan approve→approved→turn(end)；无 pending plan→404", async () => {
		const planV1 = `# Plan

## Steps
1. add auth routes
2. add login page

## Files
auth.ts, login.tsx

## Acceptance criteria
tests pass
`;
		const fx = await startApi(
			scriptedAdapter([
				textRound(planV1, { input: 200, output: 60 }),
				spawnWorkersRound(
					'{"workers":[{"task":"实现后端 auth 路由","modelTier":"high"}]}',
				),
				toolCallRound(
					"write",
					"w-tc-1",
					'{"path":"auth.ts","content":"export const auth = true;\\n"}',
				),
				textRound("auth 路由已完成。", { input: 500, output: 100 }),
				textRound("用户认证已按计划实现。", { input: 100, output: 20 }),
			]),
			"ask-on-dangerous",
		);
		const { id } = await createSession(fx, fx.proj);

		// 无 pending plan → 404
		const noPlanRes = await postJson(`${fx.base}/api/sessions/${id}/plan`, {
			decision: "approve",
		});
		expect(noPlanRes.status).toBe(404);

		const sse = await openSse(fx.base, id);
		await postJson(`${fx.base}/api/sessions/${id}/messages`, {
			content: "给项目加用户认证",
		});
		await sse.waitFor(() =>
			sse.events.some((e) => e.kind === "plan" && e.phase === "drafted"),
		);
		const drafted = sse.events.find((e) => e.kind === "plan");
		if (drafted?.kind !== "plan") throw new Error("plan 事件缺失");
		expect(drafted.plan).toBe(planV1);
		await sse.waitFor(() =>
			sse.events.some(
				(e) => e.kind === "approval" && e.approvalType === "plan",
			),
		);
		expect(
			sse.events.some((e) => e.kind === "plan" && e.phase === "approved"),
		).toBe(false);

		const approveRes = await postJson(`${fx.base}/api/sessions/${id}/plan`, {
			decision: "approve",
		});
		expect(approveRes.status).toBe(200);

		await sse.waitFor(() =>
			sse.events.some((e) => e.kind === "plan" && e.phase === "approved"),
		);
		await sse.waitFor(() => sse.events.some(isTurnEnd));
		sse.close();

		const draftedIdx = sse.events.findIndex(
			(e) => e.kind === "plan" && e.phase === "drafted",
		);
		const approvalIdx = sse.events.findIndex((e) => e.kind === "approval");
		const approvedIdx = sse.events.findIndex(
			(e) => e.kind === "plan" && e.phase === "approved",
		);
		const endIdx = sse.events.findIndex(isTurnEnd);
		expect(draftedIdx).toBeLessThan(approvalIdx);
		expect(approvalIdx).toBeLessThan(approvedIdx);
		expect(approvedIdx).toBeLessThan(endIdx);
		expect(
			sse.events.some(
				(e) =>
					isLog(e) &&
					e.event.type === "agent_spawn" &&
					e.event.agentId === "worker-1",
			),
		).toBe(true);
	}, 20000);

	it("404/400 分支与 cwd 默认", async () => {
		const fx = await startApi(
			scriptedAdapter([textRound("回答", { input: 10, output: 5 })]),
			"never",
		);
		const { id } = await createSession(fx, fx.proj);

		// 未知会话：GET 详情/usage/messages/steer/cancel/plan/events 一律 404
		expect((await fetch(`${fx.base}/api/sessions/nope`)).status).toBe(404);
		expect((await fetch(`${fx.base}/api/sessions/nope/usage`)).status).toBe(
			404,
		);
		expect(
			(
				await postJson(`${fx.base}/api/sessions/nope/messages`, {
					content: "hi",
				})
			).status,
		).toBe(404);
		expect(
			(
				await postJson(`${fx.base}/api/sessions/nope/steer`, {
					content: "hi",
				})
			).status,
		).toBe(404);
		expect((await postJson(`${fx.base}/api/sessions/nope/cancel`)).status).toBe(
			404,
		);
		expect(
			(
				await postJson(`${fx.base}/api/sessions/nope/plan`, {
					decision: "approve",
				})
			).status,
		).toBe(404);
		expect(
			(
				await postJson(`${fx.base}/api/sessions/nope/approvals/r1`, {
					decision: "deny",
				})
			).status,
		).toBe(404);
		expect((await fetch(`${fx.base}/api/sessions/nope/events`)).status).toBe(
			404,
		);

		// 缺字段/非法 body → 400
		expect(
			(await postJson(`${fx.base}/api/sessions/${id}/messages`, {})).status,
		).toBe(400);
		expect(
			(
				await postJson(`${fx.base}/api/sessions/${id}/messages`, {
					content: 123,
				})
			).status,
		).toBe(400);
		const badJson = await fetch(`${fx.base}/api/sessions/${id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "not-json",
		});
		expect(badJson.status).toBe(400);
		const badAfter = await fetch(
			`${fx.base}/api/sessions/${id}/events?after=abc`,
		);
		expect(badAfter.status).toBe(400);

		// 已知会话：steer/cancel → 202
		expect(
			(
				await postJson(`${fx.base}/api/sessions/${id}/steer`, {
					content: "补充",
				})
			).status,
		).toBe(202);
		expect(
			(await postJson(`${fx.base}/api/sessions/${id}/cancel`)).status,
		).toBe(202);

		// cwd 默认 process.cwd()
		const res = await postJson(`${fx.base}/api/sessions`);
		expect(res.status).toBe(201);
		const { id: defaultId } = (await res.json()) as { id: string };
		const detail = (await (
			await fetch(`${fx.base}/api/sessions/${defaultId}`)
		).json()) as { cwd: string };
		expect(detail.cwd).toBe(process.cwd());

		// 列表同时包含两个会话
		const list = (await (await fetch(`${fx.base}/api/sessions`)).json()) as {
			sessions: { id: string }[];
		};
		const ids = list.sessions.map((s) => s.id);
		expect(ids).toContain(id);
		expect(ids).toContain(defaultId);
	}, 20000);

	it("磁盘上已有会话（不经 HTTP create，等价 CLI 创建后由本 server 打开）：详情 200、events 可订阅；不存在 id 仍 404", async () => {
		// 回归：listSessions 列磁盘会话，而单会话路由原只查内存 managed 表——
		// CLI 创建的会话在 web 列表可见却打不开（404）。requireSession 降级
		// attachById 后，此处直接经 core 写磁盘会话文件（不经 HTTP create 路由），
		// 模拟「非本 server 进程托管」的现存会话
		const fx = await startApi(scriptedAdapter([]), "never");
		const disk = await createDiskSession(fx.proj, fx.home);

		// 列表可见（listSessions 读磁盘）
		const list = (await (await fetch(`${fx.base}/api/sessions`)).json()) as {
			sessions: { id: string; cwd: string; turn: string }[];
		};
		const mine = list.sessions.find((s) => s.id === disk.id);
		expect(mine).toMatchObject({ id: disk.id, cwd: fx.proj, turn: "idle" });

		// 详情：get 未命中 → attachById 恢复 → 200
		const detail = (await (
			await fetch(`${fx.base}/api/sessions/${disk.id}`)
		).json()) as { id: string; cwd: string; turn: string };
		expect(detail).toMatchObject({ id: disk.id, cwd: fx.proj, turn: "idle" });

		// events：SSE 可订阅；attach 时 tailer 补读历史，至少重放出 log:meta
		const sse = await openSse(fx.base, disk.id);
		await sse.waitFor(() =>
			sse.events.some((e) => isLog(e) && e.event.type === "meta"),
		);
		sse.close();

		// 不存在的 id：get 与 attach 双双未命中，仍 404
		expect((await fetch(`${fx.base}/api/sessions/no-such-id`)).status).toBe(
			404,
		);
		expect(
			(await fetch(`${fx.base}/api/sessions/no-such-id/events`)).status,
		).toBe(404);
	}, 20000);

	it("prompt templates：GET 列表；/命令展开为模板正文并落 prompt/invoked；未知命令 400", async () => {
		const fx = await startApi(
			scriptedAdapter([textRound("已执行", { input: 3, output: 2 })]),
			"never",
		);
		await mkdir(join(fx.home, "prompts"), { recursive: true });
		await writeFile(
			join(fx.home, "prompts", "commit.md"),
			"---\nname: commit\ndescription: Commit helper\n---\nCommit task: $ARGUMENTS\n",
			"utf8",
		);
		const { id } = await createSession(fx, fx.proj);

		// 模板清单（web 端 `/` 补全的数据源）
		const listRes = await fetch(`${fx.base}/api/sessions/${id}/prompts`);
		expect(listRes.status).toBe(200);
		expect(await listRes.json()).toEqual({
			prompts: [{ name: "commit", description: "Commit helper" }],
		});

		// 未知斜杠命令：400，且消息不进入回合
		const bad = await postJson(`${fx.base}/api/sessions/${id}/messages`, {
			content: "/nope",
		});
		expect(bad.status).toBe(400);
		const badBody = (await bad.json()) as { error: string };
		expect(badBody.error).toContain("unknown prompt template");

		// 命中模板：user_msg 为展开后的正文，日志有 prompt/invoked
		const sse = await openSse(fx.base, id);
		const ok = await postJson(`${fx.base}/api/sessions/${id}/messages`, {
			content: "/commit  fix   lint",
		});
		expect(ok.status).toBe(202);
		await sse.waitFor(() => sse.events.some(isTurnEnd));
		sse.close();

		const detail = (await (
			await fetch(`${fx.base}/api/sessions/${id}`)
		).json()) as { filePath: string };
		const { events } = await loadSession(detail.filePath);
		const user = events.find(
			(e) => e.type === "user_msg" && e.content.includes("Commit task:"),
		);
		expect(user?.type === "user_msg" ? user.content : undefined).toBe(
			"Commit task: fix lint\n",
		);
		const invoked = events.find((e) => e.type === "prompt/invoked");
		expect(invoked).toMatchObject({
			name: "commit",
			args: "fix lint",
			content: "Commit task: fix lint\n",
		});
	}, 20000);

	it("inbox 快照：空队列、POST steer 后 next-step 出现消息；未知会话 404", async () => {
		const fx = await startApi(scriptedAdapter([]), "never");
		const { id } = await createSession(fx, fx.proj);

		const empty = (await (
			await fetch(`${fx.base}/api/sessions/${id}/inbox`)
		).json()) as { nextTurn: unknown[]; nextStep: unknown[] };
		expect(empty).toEqual({ nextTurn: [], nextStep: [] });

		// 空闲会话 steer：消息进入 next-step 并落盘快照，等待下一个回合消费
		const steerRes = await postJson(`${fx.base}/api/sessions/${id}/steer`, {
			content: "转向",
		});
		expect(steerRes.status).toBe(202);

		const after = (await (
			await fetch(`${fx.base}/api/sessions/${id}/inbox`)
		).json()) as {
			nextTurn: { id: string; content: string }[];
			nextStep: { id: string; content: string }[];
		};
		expect(after.nextTurn).toEqual([]);
		expect(after.nextStep.map((m) => m.content)).toEqual(["转向"]);
		expect(typeof after.nextStep[0]?.id).toBe("string");

		expect((await fetch(`${fx.base}/api/sessions/nope/inbox`)).status).toBe(
			404,
		);
	}, 20000);

	it("删除会话：DELETE 204 后列表/详情 404、磁盘日志移除；运行中 409；未知会话 404", async () => {
		const fx = await startApi(
			scriptedAdapter([
				spawnSimpleRound("清理临时目录 x"),
				toolCallRound("bash", "w-tc-1", '{"command":"rm -rf x"}'),
				textRound("清理完成。", { input: 50, output: 10 }),
				textRound("临时目录已清理。", { input: 20, output: 5 }),
			]),
			"ask-on-dangerous",
		);
		const { id } = await createSession(fx, fx.proj);

		// 未知会话 → 404
		expect(
			(await fetch(`${fx.base}/api/sessions/nope`, { method: "DELETE" }))
				.status,
		).toBe(404);

		// 回合挂起（等审批）期间 running：DELETE → 409
		const sse = await openSse(fx.base, id);
		const msgRes = await postJson(`${fx.base}/api/sessions/${id}/messages`, {
			content: "清理临时目录",
		});
		expect(msgRes.status).toBe(202);
		await sse.waitFor(() => sse.events.some((e) => e.kind === "approval"));
		const blocked = await fetch(`${fx.base}/api/sessions/${id}`, {
			method: "DELETE",
		});
		expect(blocked.status).toBe(409);
		const blockedBody = (await blocked.json()) as { error: string };
		expect(blockedBody.error).toContain("运行中");

		// 放行后回合收尾（idle）→ DELETE 204：列表/详情 404，磁盘日志移除
		const approval = sse.events.find((e) => e.kind === "approval");
		if (approval?.kind !== "approval") throw new Error("approval 事件缺失");
		const allowRes = await postJson(
			`${fx.base}/api/sessions/${id}/approvals/${approval.requestId}`,
			{ decision: "allow" },
		);
		expect(allowRes.status).toBe(200);
		await sse.waitFor(() => sse.events.some(isTurnEnd));
		sse.close();

		const summaries = await fx.manager.list();
		const filePath = summaries.find((s) => s.id === id)?.filePath;
		expect(filePath).toBeDefined();
		expect(existsSync(filePath ?? "")).toBe(true);

		const del = await fetch(`${fx.base}/api/sessions/${id}`, {
			method: "DELETE",
		});
		expect(del.status).toBe(204);

		const list = (await (await fetch(`${fx.base}/api/sessions`)).json()) as {
			sessions: { id: string }[];
		};
		expect(list.sessions.map((s) => s.id)).not.toContain(id);
		expect((await fetch(`${fx.base}/api/sessions/${id}`)).status).toBe(404);
		expect(existsSync(filePath ?? "")).toBe(false);

		// 纯磁盘会话（不经 HTTP create，等价 CLI 创建）同样可删
		const disk = await createDiskSession(fx.proj, fx.home);
		const diskDel = await fetch(`${fx.base}/api/sessions/${disk.id}`, {
			method: "DELETE",
		});
		expect(diskDel.status).toBe(204);
		expect(existsSync(disk.filePath)).toBe(false);
	}, 20000);

	it("归档会话：运行中归档→回合中止收尾、会话保留在列表且日志落盘，之后可删除", async () => {
		const fx = await startApi(
			scriptedAdapter([
				spawnSimpleRound("清理临时目录 x"),
				toolCallRound("bash", "w-tc-1", '{"command":"rm -rf x"}'),
				textRound("清理完成。", { input: 50, output: 10 }),
				textRound("临时目录已清理。", { input: 20, output: 5 }),
			]),
			"ask-on-dangerous",
		);
		const { id } = await createSession(fx, fx.proj);

		// 未知会话 → 404
		expect(
			(await postJson(`${fx.base}/api/sessions/nope/archive`)).status,
		).toBe(404);

		// 回合挂起（等审批）期间归档：abort + 拒决未决审批 → 回合照常收尾
		const sse = await openSse(fx.base, id);
		const msgRes = await postJson(`${fx.base}/api/sessions/${id}/messages`, {
			content: "清理临时目录",
		});
		expect(msgRes.status).toBe(202);
		await sse.waitFor(() => sse.events.some((e) => e.kind === "approval"));

		const res = await postJson(`${fx.base}/api/sessions/${id}/archive`);
		expect(res.status).toBe(200);
		await sse.waitFor(() => sse.events.some(isTurnEnd));
		sse.close();

		// 归档后：idle、仍在列表、磁盘日志保留（所有内容已落盘）
		const detail = (await (
			await fetch(`${fx.base}/api/sessions/${id}`)
		).json()) as { turn: string };
		expect(detail.turn).toBe("idle");
		const list = (await (await fetch(`${fx.base}/api/sessions`)).json()) as {
			sessions: { id: string }[];
		};
		expect(list.sessions.map((s) => s.id)).toContain(id);
		const summaries = await fx.manager.list();
		const filePath = summaries.find((s) => s.id === id)?.filePath;
		expect(existsSync(filePath ?? "")).toBe(true);

		// 归档后即可删除（204）
		const del = await fetch(`${fx.base}/api/sessions/${id}`, {
			method: "DELETE",
		});
		expect(del.status).toBe(204);
	}, 20000);
});

// ---- 模型设置路由（web 设置弹窗）：只读写用户级 settings.json 的 models/mainAgentTier ----

describe("settings 路由", () => {
	it("GET 返回 models 与 mainAgentTier，$ENV 引用原文不插值", async () => {
		const fx = await startApi(scriptedAdapter([]));
		// 覆盖写：apiKey 用 $ENV 引用 + mainAgentTier
		await writeFile(
			join(fx.home, "settings.json"),
			JSON.stringify({
				models: {
					high: {
						provider: "openai",
						model: "gpt-5",
						apiKey: "$OPENAI_API_KEY",
						baseUrl: "https://api.openai.com/v1",
					},
					medium: { provider: "deepseek", model: "ds", apiKey: "mk" },
					low: { provider: "deepseek", model: "ds-lite", apiKey: "lk" },
				},
				mainAgentTier: "medium",
			}),
			"utf8",
		);

		const res = await fetch(`${fx.base}/api/settings`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			models: Record<string, { apiKey: string; baseUrl?: string }>;
			mainAgentTier?: string;
		};
		// $ENV 引用原样返回（编辑器要看到引用文本，不做插值）
		expect(body.models.high?.apiKey).toBe("$OPENAI_API_KEY");
		expect(body.models.high?.baseUrl).toBe("https://api.openai.com/v1");
		expect(body.mainAgentTier).toBe("medium");
	});

	it("PUT 更新 models/mainAgentTier，文件其余字段原样保留", async () => {
		const fx = await startApi(scriptedAdapter([]));
		// 预置无关字段：PUT 后必须原样保留
		await writeFile(
			join(fx.home, "settings.json"),
			JSON.stringify({
				models: {
					high: { provider: "p", model: "h", apiKey: "hk" },
					medium: { provider: "p", model: "m", apiKey: "mk" },
					low: { provider: "p", model: "l", apiKey: "lk" },
				},
				mainAgentTier: "high",
				maxParallelTasks: 6,
				features: { webSearch: false },
			}),
			"utf8",
		);

		const res = await fetch(`${fx.base}/api/settings`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				models: {
					high: { provider: "openai", model: "gpt-5", apiKey: "sk-new" },
					medium: { provider: "p", model: "m", apiKey: "mk" },
					low: { provider: "p", model: "l", apiKey: "lk" },
				},
				mainAgentTier: "low",
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			models: { high: { model: string } };
			mainAgentTier: string;
		};
		expect(body.models.high.model).toBe("gpt-5");
		expect(body.mainAgentTier).toBe("low");

		// 文件级校验：未触及的键保留、写入是合法 JSON
		const raw = JSON.parse(
			await readFile(join(fx.home, "settings.json"), "utf8"),
		) as {
			models: { high: { apiKey: string } };
			mainAgentTier: string;
			maxParallelTasks: number;
			features: { webSearch: boolean };
		};
		expect(raw.models.high.apiKey).toBe("sk-new");
		expect(raw.mainAgentTier).toBe("low");
		expect(raw.maxParallelTasks).toBe(6);
		expect(raw.features.webSearch).toBe(false);
	});

	it("PUT 非法 body → 400", async () => {
		const fx = await startApi(scriptedAdapter([]));
		const res = await fetch(`${fx.base}/api/settings`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ models: { high: { provider: "p" } } }),
		});
		expect(res.status).toBe(400);
	});

	it("settings.json 缺失 → GET 500 带路径错误", async () => {
		const fx = await startApi(scriptedAdapter([]));
		await rm(join(fx.home, "settings.json"));
		const res = await fetch(`${fx.base}/api/settings`);
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("settings.json");
	});
});
