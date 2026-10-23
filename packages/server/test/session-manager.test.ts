// 会话管理器集成测试：turn 串行化、审批桥（parked promise）、seq/订阅广播、usage 统计。
// 全部 scriptedAdapter 不触网；settings 用 mkdtemp home 下的三档夹具（provider 为不存在的
// 测试值，resolveModel 兜底告警但 llm 注入模式下不真正解析）。审批场景用 ask-on-dangerous，
// 无审批场景用 policy:"never" 且脚本不触发需要审批的工具。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type LlmAdapter,
	type ModelInfo,
	type StreamEvent,
	scriptedAdapter,
	type Usage,
} from "@hotpot/ai";
import { loadSession, type SessionEvent, type Settings } from "@hotpot/core";
import type {
	McpClientFactory,
	McpClientHandle,
	McpToolCallResult,
} from "@hotpot/orchestrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionManager } from "../src/session-manager.ts";
import type { WireEvent } from "../src/wire.ts";

let home: string;
let proj: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-server-home-"));
	proj = await mkdtemp(join(tmpdir(), "hotpot-server-proj-"));
	await writeFile(join(proj, "note.txt"), "hello hotpot\n", "utf8");
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
	await rm(proj, { recursive: true, force: true });
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

// 用户级 settings 夹具：三档指向不存在的 provider（resolveModel 会兜底并给 warning，
// 但本测试一律注入 llm，不真正解析）；approval.policy 按场景传入；
// extra 可带 mcpServers/features（MCP 挂载用例）
async function writeSettings(
	policy?: "ask-on-dangerous" | "always" | "never",
	extra?: {
		mcpServers?: Settings["mcpServers"];
		features?: Settings["features"];
	},
): Promise<void> {
	const settings: Settings = {
		models: {
			high: { provider: "test-provider", model: "test-high", apiKey: "hk" },
			medium: { provider: "test-provider", model: "test-medium", apiKey: "mk" },
			low: { provider: "test-provider", model: "test-low", apiKey: "lk" },
		},
		...(policy === undefined ? {} : { approval: { policy } }),
		...(extra?.mcpServers === undefined
			? {}
			: { mcpServers: extra.mcpServers }),
		...(extra?.features === undefined ? {} : { features: extra.features }),
	};
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify(settings),
		"utf8",
	);
}

// ---- 订阅收集与断言辅助 ----

function makeSink(): { events: WireEvent[]; sink: (e: WireEvent) => void } {
	const events: WireEvent[] = [];
	return {
		events,
		sink: (e: WireEvent) => {
			events.push(e);
		},
	};
}

function isLog(e: WireEvent): e is Extract<WireEvent, { kind: "log" }> {
	return e.kind === "log";
}

function isTurnEnd(e: WireEvent): boolean {
	return e.kind === "turn" && e.phase === "end";
}

// 事件的一句话描述（kind + 关键区分字段），用于顺序断言
function describeEvent(e: WireEvent): string {
	if (e.kind === "turn") return `turn:${e.phase}`;
	if (e.kind === "log") return `log:${e.event.type}`;
	if (e.kind === "plan") return `plan:${e.phase}`;
	return e.kind;
}

function logEvents(
	events: WireEvent[],
	type: SessionEvent["type"],
): SessionEvent[] {
	return events
		.filter(isLog)
		.filter((e) => e.event.type === type)
		.map((e) => e.event);
}

// tailer 走 fs.watch/轮询异步推送，统一用条件轮询等待
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("waitFor 超时");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

// ---- 脚本轮辅助（与 orchestrator m2 验收测试同款） ----

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

describe("createSessionManager", () => {
	it("send 后 sink 顺序：log(meta) → turn(start) → log(user_msg) → delta… → log(assistant_msg) → turn(end)", async () => {
		await writeSettings("never");
		const adapter: LlmAdapter = scriptedAdapter([
			[
				{ type: "text_delta", delta: "你好" },
				{ type: "text_delta", delta: "，世界" },
				{ type: "usage", usage: { input: 10, output: 5 } },
				{ type: "finish", reason: "stop" },
			],
		]);
		const sm = createSessionManager({ home, llm: { adapter, model: MODEL } });
		const rec = await sm.create(proj);
		const { events, sink } = makeSink();
		sm.subscribe(rec.id, null, sink);

		await sm.send(rec.id, "第一条消息");
		await waitFor(() => events.some(isTurnEnd));

		expect(events.map(describeEvent)).toEqual([
			"log:meta",
			"turn:start",
			"log:user_msg",
			"delta",
			"delta",
			"log:assistant_msg",
			"turn:end",
		]);
		const deltas = events.filter((e) => e.kind === "delta");
		expect(deltas.map((e) => (e.kind === "delta" ? e.text : "")).join("")).toBe(
			"你好，世界",
		);
		// seq 全会话单调递增
		const seqs = events.map((e) => e.seq);
		expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
	});

	it("spawn→simple：收到 spawn 瞬态事件；子 agent 事件只经 log 路径到达（迭代器未转发 tool_call）", async () => {
		await writeSettings("never");
		const adapter = scriptedAdapter([
			spawnSimpleRound("读取 note.txt 并总结内容"),
			toolCallRound("read", "w-tc-1", '{"path":"note.txt"}'),
			textRound("note.txt 有一行：hello hotpot。", {
				input: 2000,
				output: 400,
			}),
			textRound("worker 已读完并总结。", { input: 120, output: 30 }),
		]);
		const sm = createSessionManager({ home, llm: { adapter, model: MODEL } });
		const rec = await sm.create(proj);
		const { events, sink } = makeSink();
		sm.subscribe(rec.id, null, sink);

		await sm.send(rec.id, "看一下 note.txt");
		await waitFor(() => events.some(isTurnEnd));

		// 瞬态 spawn 事件（parentAgentId 固定 main）
		const spawn = events.find((e) => e.kind === "spawn");
		if (spawn?.kind !== "spawn") throw new Error("spawn 事件缺失");
		expect(spawn).toMatchObject({
			agentId: "worker-1",
			role: "worker",
			tier: "low",
			parentAgentId: "main",
			task: "读取 note.txt 并总结内容",
		});

		// 子 agent 的 durable 事件经 tailer 的 log 路径到达。
		// 注意：core 的 runTurn 不落独立的 tool_call 会话事件（tool_call 只存在于
		// assistant_msg 内容块与瞬态事件里），故「tool_call 只来自 log 路径」以
		// worker assistant_msg 的内容块 + tool_result 事件断言
		const spawns = logEvents(events, "agent_spawn");
		expect(
			spawns.some((e) => e.type === "agent_spawn" && e.agentId === "worker-1"),
		).toBe(true);
		expect(
			logEvents(events, "assistant_msg").some(
				(e) =>
					e.type === "assistant_msg" &&
					e.agentId === "worker-1" &&
					e.content.some((b) => b.type === "tool_call" && b.name === "read"),
			),
		).toBe(true);
		expect(
			logEvents(events, "tool_result").some(
				(e) => e.type === "tool_result" && e.agentId === "worker-1",
			),
		).toBe(true);

		// 迭代器未转发 durable 事件：非 log 事件的 kind 只允许瞬态 turn/spawn/delta
		const nonLogKinds = events
			.filter((e) => e.kind !== "log")
			.map((e) => e.kind);
		expect(new Set(nonLogKinds)).toEqual(new Set(["turn", "spawn", "delta"]));
	});

	it("bash 高危命令：sink 收到 approval；未应答期间 turn 不结束；allow 后收到 log(approval/asked→decided) 与 turn(end)", async () => {
		await writeSettings("ask-on-dangerous");
		const adapter = scriptedAdapter([
			spawnSimpleRound("清理临时目录 x"),
			toolCallRound("bash", "w-tc-1", '{"command":"rm -rf x"}'),
			textRound("清理完成。", { input: 50, output: 10 }),
			textRound("临时目录已清理。", { input: 20, output: 5 }),
		]);
		const sm = createSessionManager({ home, llm: { adapter, model: MODEL } });
		const rec = await sm.create(proj);
		const { events, sink } = makeSink();
		sm.subscribe(rec.id, null, sink);

		await sm.send(rec.id, "清理临时目录");
		await waitFor(() => events.some((e) => e.kind === "approval"));

		const approval = events.find((e) => e.kind === "approval");
		if (approval?.kind !== "approval") throw new Error("approval 事件缺失");
		expect(approval.approvalType).toBe("tool");
		expect(approval.summary).toContain("rm -rf x");

		// 未应答期间 turn 不结束（parked promise 挂起 spawn_workers → worker 的 bash 执行）
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(events.some(isTurnEnd)).toBe(false);
		expect(sm.answerToolApproval(rec.id, approval.requestId, "allow")).toBe(
			true,
		);

		await waitFor(() => events.some(isTurnEnd));
		const askedIdx = events.findIndex(
			(e) => isLog(e) && e.event.type === "approval/asked",
		);
		const decidedIdx = events.findIndex(
			(e) => isLog(e) && e.event.type === "approval/decided",
		);
		const endIdx = events.findIndex(isTurnEnd);
		expect(askedIdx).toBeGreaterThan(-1);
		expect(decidedIdx).toBeGreaterThan(askedIdx);
		expect(endIdx).toBeGreaterThan(decidedIdx);

		// id 统一：广播 approval 事件的 requestId 与落盘 asked/decided 的 id 相同，
		// 前端 decided 日志才能按 requestId 清除 pending 审批
		const asked = events[askedIdx];
		const decided = events[decidedIdx];
		if (asked?.kind !== "log" || asked.event.type !== "approval/asked") {
			throw new Error("approval/asked 日志缺失");
		}
		if (decided?.kind !== "log" || decided.event.type !== "approval/decided") {
			throw new Error("approval/decided 日志缺失");
		}
		expect(asked.event.id).toBe(approval.requestId);
		expect(decided.event.requestId).toBe(approval.requestId);
	});

	it("complex：plan(drafted) → answerPlan approve → plan(approved) → 执行 turn 完成", async () => {
		await writeSettings("ask-on-dangerous");
		const planV1 = `# Plan

## Steps
1. add auth routes
2. add login page

## Files
auth.ts, login.tsx

## Acceptance criteria
tests pass
`;
		const adapter = scriptedAdapter([
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
		]);
		const sm = createSessionManager({ home, llm: { adapter, model: MODEL } });
		const rec = await sm.create(proj);
		const { events, sink } = makeSink();
		sm.subscribe(rec.id, null, sink);

		await sm.send(rec.id, "给项目加用户认证");
		await waitFor(() =>
			events.some((e) => e.kind === "plan" && e.phase === "drafted"),
		);
		const drafted = events.find((e) => e.kind === "plan");
		if (drafted?.kind !== "plan") throw new Error("plan 事件缺失");
		expect(drafted.phase).toBe("drafted");
		expect(drafted.plan).toBe(planV1);

		// plan 审批询问经桥广播为 approval(approvalType:"plan")，parked 等应答
		await waitFor(() =>
			events.some((e) => e.kind === "approval" && e.approvalType === "plan"),
		);
		const approval = events.find(
			(e) => e.kind === "approval" && e.approvalType === "plan",
		);
		if (approval?.kind !== "approval") throw new Error("plan approval 缺失");
		expect(approval.plan).toBe(planV1);
		expect(
			events.some((e) => e.kind === "plan" && e.phase === "approved"),
		).toBe(false);

		expect(sm.answerPlan(rec.id, { kind: "approve" })).toBe(true);
		await waitFor(() =>
			events.some((e) => e.kind === "plan" && e.phase === "approved"),
		);
		await waitFor(() => events.some(isTurnEnd));

		const draftedIdx = events.findIndex(
			(e) => e.kind === "plan" && e.phase === "drafted",
		);
		const approvalIdx = events.findIndex((e) => e.kind === "approval");
		const approvedIdx = events.findIndex(
			(e) => e.kind === "plan" && e.phase === "approved",
		);
		const endIdx = events.findIndex(isTurnEnd);
		expect(draftedIdx).toBeLessThan(approvalIdx);
		expect(approvalIdx).toBeLessThan(approvedIdx);
		expect(approvedIdx).toBeLessThan(endIdx);

		// 执行阶段确有 worker 诞生并落盘执行记录
		expect(
			logEvents(events, "agent_spawn").some(
				(e) => e.type === "agent_spawn" && e.agentId === "worker-1",
			),
		).toBe(true);
	});

	it("两个 send 连发：turn 串行，第二回合的 user_msg 推送/落盘都在第一回合 turn(end) 之后", async () => {
		await writeSettings("never");
		const adapter = scriptedAdapter([
			textRound("回答一", { input: 10, output: 5 }),
			textRound("回答二", { input: 10, output: 5 }),
		]);
		const sm = createSessionManager({ home, llm: { adapter, model: MODEL } });
		const rec = await sm.create(proj);
		const { events, sink } = makeSink();
		sm.subscribe(rec.id, null, sink);

		await sm.send(rec.id, "第一条");
		await sm.send(rec.id, "第二条");
		await waitFor(() => events.filter(isTurnEnd).length === 2);

		const end1Idx = events.findIndex(isTurnEnd);
		const start2Idx = events.findIndex(
			(e, i) => i > end1Idx && e.kind === "turn" && e.phase === "start",
		);
		const msg2Idx = events.findIndex(
			(e) =>
				isLog(e) &&
				e.event.type === "user_msg" &&
				e.event.agentId === "main" &&
				e.event.content === "第二条",
		);
		expect(end1Idx).toBeGreaterThan(-1);
		expect(start2Idx).toBeGreaterThan(end1Idx);
		expect(msg2Idx).toBeGreaterThan(start2Idx);

		// 落盘顺序同理（tailer 按文件序推送，sink 顺序即文件顺序）
		const { events: fileEvents } = await loadSession(rec.filePath);
		const idxOf = (pred: (e: SessionEvent) => boolean): number =>
			fileEvents.findIndex(pred);
		const msg1File = idxOf(
			(e) =>
				e.type === "user_msg" && e.agentId === "main" && e.content === "第一条",
		);
		const answer1File = idxOf(
			(e) => e.type === "assistant_msg" && e.agentId === "main",
		);
		const msg2File = idxOf(
			(e) =>
				e.type === "user_msg" && e.agentId === "main" && e.content === "第二条",
		);
		expect(msg1File).toBeGreaterThan(-1);
		expect(msg1File).toBeLessThan(answer1File);
		expect(answer1File).toBeLessThan(msg2File);
	});

	it("attachById：close 后恢复会话，tailer 补读历史经 buffer 重放拿到旧 assistant_msg，且可继续对话", async () => {
		await writeSettings("never");
		const sm = createSessionManager({
			home,
			llm: {
				adapter: scriptedAdapter([
					textRound("旧回答", { input: 10, output: 5 }),
				]),
				model: MODEL,
			},
		});
		const rec = await sm.create(proj);
		const first = makeSink();
		sm.subscribe(rec.id, null, first.sink);
		await sm.send(rec.id, "旧问题");
		await waitFor(() => first.events.some(isTurnEnd));
		expect(
			first.events.some((e) => isLog(e) && e.event.type === "assistant_msg"),
		).toBe(true);
		sm.close(rec.id);
		expect(sm.get(rec.id)).toBeNull();

		// 新 manager 实例按 id 恢复（web 打开/CLI 创建过的会话）
		const sm2 = createSessionManager({
			home,
			llm: {
				adapter: scriptedAdapter([
					textRound("新回答", { input: 10, output: 5 }),
				]),
				model: MODEL,
			},
		});
		const attached = await sm2.attachById(rec.id);
		if (attached === null) throw new Error("attachById 未命中");
		expect(attached.filePath).toBe(rec.filePath);

		const second = makeSink();
		sm2.subscribe(attached.id, null, second.sink);
		// 补读的历史直接经 buffer 重放（tailer 初始批已入 hub）
		expect(
			second.events.some(
				(e) =>
					isLog(e) &&
					e.event.type === "user_msg" &&
					e.event.agentId === "main" &&
					e.event.content === "旧问题",
			),
		).toBe(true);
		expect(
			second.events.some((e) => isLog(e) && e.event.type === "assistant_msg"),
		).toBe(true);

		await sm2.send(attached.id, "新问题");
		await waitFor(() => second.events.some(isTurnEnd));
		expect(second.events.some((e) => e.kind === "delta")).toBe(true);
	});

	it("空闲会话恢复订阅：agent_end 随日志重放到达，不再补发合成 turn(end)", async () => {
		await writeSettings("never");
		const adapter = scriptedAdapter([
			spawnSimpleRound("读取 note.txt 并总结内容"),
			toolCallRound("read", "w-tc-1", '{"path":"note.txt"}'),
			textRound("worker 已读完并总结。", { input: 120, output: 30 }),
		]);
		const sm = createSessionManager({ home, llm: { adapter, model: MODEL } });
		const rec = await sm.create(proj);
		const first = makeSink();
		sm.subscribe(rec.id, null, first.sink);
		await sm.send(rec.id, "看一下 note.txt");
		await waitFor(() => first.events.some(isTurnEnd));
		sm.close(rec.id);

		// 新 manager 恢复（web 刷新后重新 attach）：卡片状态由 durable 的
		// agent_end 随日志重放送达，不再需要合成 turn(end) 兜底
		const sm2 = createSessionManager({ home });
		const attached = await sm2.attachById(rec.id);
		if (attached === null) throw new Error("attachById 未命中");
		const second = makeSink();
		await sm2.subscribeResuming(attached.id, null, second.sink);
		// agent_spawn 与 agent_end 均随重放到达（worker 完成态的数据源），数量对齐
		const spawns = second.events.filter(
			(e) => isLog(e) && e.event.type === "agent_spawn",
		);
		const ends = second.events.filter(
			(e) => isLog(e) && e.event.type === "agent_end",
		);
		expect(spawns.length).toBeGreaterThan(0);
		expect(ends.length).toBe(spawns.length);
		expect(
			ends.every(
				(e) =>
					isLog(e) &&
					e.event.type === "agent_end" &&
					e.event.outcome === "done",
			),
		).toBe(true);
		// 空闲会话不再补发合成 turn(end)：瞬态不落盘，缓冲重放里没有 turn 事件
		expect(second.events.some(isTurnEnd)).toBe(false);
	});

	it("usage()：折叠 assistant_msg.usage，total/byTier/byAgent 正确", async () => {
		await writeSettings("never");
		const adapter = scriptedAdapter([
			spawnSimpleRound("读取 note.txt 并总结内容"),
			toolCallRound("read", "w-tc-1", '{"path":"note.txt"}'),
			textRound("note.txt 有一行：hello hotpot。", {
				input: 2000,
				output: 400,
			}),
			textRound("worker 已读完并总结。", { input: 120, output: 30 }),
		]);
		const sm = createSessionManager({ home, llm: { adapter, model: MODEL } });
		const rec = await sm.create(proj);
		const { events, sink } = makeSink();
		sm.subscribe(rec.id, null, sink);

		await sm.send(rec.id, "看一下 note.txt");
		await waitFor(() => events.some(isTurnEnd));
		const { events: fileEvents } = await loadSession(rec.filePath);
		expect(
			fileEvents.some(
				(e) => e.type === "assistant_msg" && e.agentId === "worker-1",
			),
		).toBe(true);

		const usage = await sm.usage(rec.id);
		// main 两轮（spawn_workers 100/20 + 收尾 120/30），worker 两轮（read 100/20 + 摘要 2000/400）
		expect(usage.total).toEqual({ input: 2320, output: 470 });
		expect(usage.byTier.high).toEqual({ input: 220, output: 50, count: 2 });
		expect(usage.byTier.low).toEqual({ input: 2100, output: 420, count: 2 });
		expect(usage.byAgent.main).toEqual({ input: 220, output: 50 });
		expect(usage.byAgent["worker-1"]).toEqual({ input: 2100, output: 420 });
	});
});

// ---- M4 Feature⑦ MCP 挂载 ----
// 连接层全部打桩（mcpCreateClient 注入 stub client），不触真实 MCP server；
// 钉死：装配期 attach + mcp/attached 落盘、失败 server 不阻塞、开关关闭不连接、
// 桥接工具经 runtime.mcpTools 进 worker 注册表并可被回合真实调用

interface StubMcpClient extends McpClientHandle {
	calls: { name: string; args: unknown }[];
	closeCalls: number;
}

function mcpStubClient(
	tools: { name: string; description?: string; inputSchema?: unknown }[],
	callImpl?: (name: string, args: unknown) => Promise<McpToolCallResult>,
): StubMcpClient {
	const client: StubMcpClient = {
		calls: [],
		closeCalls: 0,
		async listTools() {
			return tools;
		},
		async callTool(name, args) {
			client.calls.push({ name, args });
			return callImpl
				? callImpl(name, args)
				: { content: [{ type: "text", text: "pong" }] };
		},
		async close() {
			client.closeCalls += 1;
		},
	};
	return client;
}

describe("MCP 挂载（mcpServers 配置）", () => {
	it("attach 成功逐个落盘 mcp/attached（server/transport/桥接工具名），close 关闭连接", async () => {
		await writeSettings("never", {
			mcpServers: {
				demo: { command: "demo-cmd", args: ["--fast"] },
				web: {
					url: "https://mcp.example.com/mcp",
					headers: { authorization: "Bearer t" },
				},
			},
		});
		const clients = new Map<string, StubMcpClient>();
		const factory: McpClientFactory = async (name) => {
			const client = mcpStubClient([
				{
					name: `t-${name}`,
					description: `tool of ${name}`,
					inputSchema: { type: "object" },
				},
			]);
			clients.set(name, client);
			return client;
		};
		const sm = createSessionManager({
			home,
			llm: { adapter: scriptedAdapter([]), model: MODEL },
			mcpCreateClient: factory,
		});
		const rec = await sm.create(proj);

		const { events: fileEvents } = await loadSession(rec.filePath);
		const attached = fileEvents.filter(
			(e): e is Extract<SessionEvent, { type: "mcp/attached" }> =>
				e.type === "mcp/attached",
		);
		expect(attached.map((a) => a.server)).toEqual(["demo", "web"]);
		expect(attached[0]).toMatchObject({
			transport: "stdio",
			tools: ["mcp__demo__t-demo"],
		});
		expect(attached[1]).toMatchObject({
			transport: "http",
			tools: ["mcp__web__t-web"],
		});

		await sm.close(rec.id);
		expect(clients.get("demo")?.closeCalls).toBe(1);
		expect(clients.get("web")?.closeCalls).toBe(1);
	});

	it("失败 server warn + 跳过，成功 server 仍 attach，装配不阻塞", async () => {
		await writeSettings("never", {
			mcpServers: {
				bad: { command: "bad-cmd" },
				good: { command: "good-cmd" },
			},
		});
		const warnings: string[] = [];
		const factory: McpClientFactory = async (name) => {
			if (name === "bad") {
				throw new Error("spawn failed");
			}
			return mcpStubClient([{ name: "up" }]);
		};
		const sm = createSessionManager({
			home,
			llm: { adapter: scriptedAdapter([]), model: MODEL },
			warn: (t) => warnings.push(t),
			mcpCreateClient: factory,
		});
		const rec = await sm.create(proj);
		// 失败 server 不阻塞：会话正常建立、好 server 落盘
		expect(sm.get(rec.id)?.filePath).toBe(rec.filePath);
		const { events: fileEvents } = await loadSession(rec.filePath);
		const attached = fileEvents.filter(
			(e): e is Extract<SessionEvent, { type: "mcp/attached" }> =>
				e.type === "mcp/attached",
		);
		expect(attached.map((a) => a.server)).toEqual(["good"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('"bad"');
		expect(warnings[0]).toContain("spawn failed");
		await sm.close(rec.id);
	});

	it("features.mcp=false：不连接（工厂不被调用），无 mcp/attached 事件", async () => {
		await writeSettings("never", {
			features: { mcp: false },
			mcpServers: { demo: { command: "demo-cmd" } },
		});
		let factoryCalls = 0;
		const factory: McpClientFactory = async () => {
			factoryCalls += 1;
			return mcpStubClient([{ name: "x" }]);
		};
		const sm = createSessionManager({
			home,
			llm: { adapter: scriptedAdapter([]), model: MODEL },
			mcpCreateClient: factory,
		});
		const rec = await sm.create(proj);
		expect(factoryCalls).toBe(0);
		const { events: fileEvents } = await loadSession(rec.filePath);
		expect(fileEvents.some((e) => e.type === "mcp/attached")).toBe(false);
		await sm.close(rec.id);
	});

	it("桥接工具进 worker 注册表：回合内经 mcp__<server>__<tool> 真实调用 stub", async () => {
		await writeSettings("never", {
			mcpServers: { demo: { command: "demo-cmd" } },
		});
		const demoClient = mcpStubClient([
			{
				name: "ping",
				description: "ping the demo server",
				inputSchema: {
					type: "object",
					properties: { target: { type: "string" } },
					required: ["target"],
				},
			},
		]);
		const adapter = scriptedAdapter([
			spawnSimpleRound("用 ping 工具探测 demo"),
			toolCallRound("mcp__demo__ping", "w-tc-1", '{"target":"demo"}'),
			textRound("pong 已收到。", { input: 20, output: 5 }),
			textRound("worker 已用 ping 完成探测。", { input: 30, output: 8 }),
		]);
		const sm = createSessionManager({
			home,
			llm: { adapter, model: MODEL },
			mcpCreateClient: async () => demoClient,
		});
		const rec = await sm.create(proj);
		const { events, sink } = makeSink();
		sm.subscribe(rec.id, null, sink);

		await sm.send(rec.id, "探测 demo");
		await waitFor(() => events.some(isTurnEnd));

		// stub 收到的是 MCP 原始工具名 + parse 后的入参；结果落盘为 worker 的 tool_result
		expect(demoClient.calls).toEqual([
			{ name: "ping", args: { target: "demo" } },
		]);
		const results = logEvents(events, "tool_result");
		expect(
			results.some(
				(e) =>
					e.type === "tool_result" &&
					e.agentId === "worker-1" &&
					e.content === "pong",
			),
		).toBe(true);
		await sm.close(rec.id);
	});
});
