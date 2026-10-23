// 会话管理器遥测接线测试：注入假 fetch 捕获上报请求体。
// 覆盖 create/attach 的 session_start、每回合的 turn_end（含 worker 用量结算）、
// close 的 session_end，以及遥测关闭/endpoint 为空时的完全旁路。
// 全程不触网：会话与安装 ID 都落在临时 home，adapter 为脚本化录制。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ModelInfo, type StreamEvent, scriptedAdapter } from "@hotpot/ai";
import type { Settings } from "@hotpot/core";
import { type TelemetryEvent, telemetryBatchSchema } from "@hotpot/telemetry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionManager } from "../src/session-manager.ts";
import type { WireEvent } from "../src/wire.ts";

let home: string;
let proj: string;
let oldEnvEndpoint: string | undefined;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-server-telemetry-"));
	proj = await mkdtemp(join(tmpdir(), "hotpot-server-telemetry-proj-"));
	await writeFile(join(proj, "note.txt"), "hello hotpot\n", "utf8");
	// endpoint 解析会读环境变量，测试期间清掉，避免宿主环境改变断言
	oldEnvEndpoint = process.env.HOTPOT_TELEMETRY_ENDPOINT;
	delete process.env.HOTPOT_TELEMETRY_ENDPOINT;
});

afterEach(async () => {
	if (oldEnvEndpoint === undefined) {
		delete process.env.HOTPOT_TELEMETRY_ENDPOINT;
	} else {
		process.env.HOTPOT_TELEMETRY_ENDPOINT = oldEnvEndpoint;
	}
	await rm(home, { recursive: true, force: true });
	await rm(proj, { recursive: true, force: true });
});

const MODEL: ModelInfo = {
	id: "test-high",
	provider: "test-provider",
	api: "openai-completions",
	contextWindow: 128000,
	maxTokens: 8192,
	cost: { input: 0, output: 0 },
};

const USER_PROMPT = "看一下 note.txt 并总结";
const WORKER_TEXT = "note.txt 有一行：hello hotpot";
const ASSISTANT_TEXT = "已看完，文件只有一行问候语";

async function writeSettings(telemetry?: Settings["telemetry"]): Promise<void> {
	const settings: Settings = {
		models: {
			high: { provider: "test-provider", model: "test-high", apiKey: "hk" },
			medium: { provider: "test-provider", model: "test-medium", apiKey: "mk" },
			low: { provider: "test-provider", model: "test-low", apiKey: "lk" },
		},
		permission: { mode: "full" },
		...(telemetry === undefined ? {} : { telemetry }),
	};
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify(settings),
		"utf8",
	);
}

// 每轮 usage 单独给定，便于断言 turn_end 的 token 汇总是整棵 agent 树的和
function toolCallRound(
	name: string,
	id: string,
	inputJson: string,
	usage: { input: number; output: number },
): StreamEvent[] {
	return [
		{ type: "tool_call_start", id, name },
		{ type: "tool_call_delta", id, inputDelta: inputJson },
		{ type: "tool_call_end", id },
		{ type: "usage", usage },
		{ type: "finish", reason: "tool_calls" },
	];
}

function textRound(
	text: string,
	usage: { input: number; output: number },
): StreamEvent[] {
	return [
		{ type: "text_delta", delta: text },
		{ type: "usage", usage },
		{ type: "finish", reason: "stop" },
	];
}

// main spawn_workers(simple) → worker 读文件 → worker 总结 → main 收尾
function oneTurnScript(): StreamEvent[][] {
	return [
		toolCallRound(
			"spawn_workers",
			"m-tc-1",
			JSON.stringify({
				workers: [{ task: "读取 note.txt 并总结内容", modelTier: "low" }],
			}),
			{ input: 100, output: 20 },
		),
		toolCallRound("read", "w-tc-1", '{"path":"note.txt"}', {
			input: 30,
			output: 10,
		}),
		textRound(WORKER_TEXT, { input: 2000, output: 400 }),
		textRound(ASSISTANT_TEXT, { input: 120, output: 30 }),
	];
}

const EXPECTED_INPUT_TOKENS = 100 + 30 + 2000 + 120;
const EXPECTED_OUTPUT_TOKENS = 20 + 10 + 400 + 30;

interface CapturedRequest {
	url: string;
	body: unknown;
}

// 假 fetch：只记录 URL 与 JSON 请求体，永远 200，绝不出网
function createFakeFetch(): {
	fetchImpl: typeof fetch;
	requests: CapturedRequest[];
} {
	const requests: CapturedRequest[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		requests.push({
			url: String(input),
			body: JSON.parse(String(init?.body)) as unknown,
		});
		return new Response("{}", { status: 200 });
	};
	return { fetchImpl, requests };
}

// 把已捕获的批次逐个按 schema 解析后摊平成事件列表（任何非法形状都会直接抛错）
function capturedEvents(requests: CapturedRequest[]): TelemetryEvent[] {
	return requests
		.map((request) => telemetryBatchSchema.parse(request.body))
		.flatMap((batch) => batch.events);
}

function isTurnEnd(e: WireEvent): boolean {
	return e.kind === "turn" && e.phase === "end";
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("waitFor 超时");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function makeSink(): { events: WireEvent[]; sink: (e: WireEvent) => void } {
	const events: WireEvent[] = [];
	return {
		events,
		sink: (e: WireEvent) => {
			events.push(e);
		},
	};
}

describe("server telemetry", () => {
	it("每回合上报匿名 turn_end（含 worker 用量），close 上报 session_end", async () => {
		await writeSettings({
			enabled: true,
			endpoint: "https://telemetry.example",
		});
		const { fetchImpl, requests } = createFakeFetch();
		const sm = createSessionManager({
			home,
			llm: { adapter: scriptedAdapter(oneTurnScript()), model: MODEL },
			telemetryFetch: fetchImpl,
		});
		const rec = await sm.create(proj);
		const { events, sink } = makeSink();
		sm.subscribe(rec.id, null, sink);

		await sm.send(rec.id, USER_PROMPT);
		await waitFor(() => events.some(isTurnEnd));
		await waitFor(() =>
			capturedEvents(requests).some((e) => e.type === "turn_end"),
		);

		expect(requests.length).toBeGreaterThan(0);
		const batches = requests.map((request) =>
			telemetryBatchSchema.parse(request.body),
		);
		for (const batch of batches) {
			expect(batch.kind).toBe("user");
		}
		const telemetryEvents = batches.flatMap((batch) => batch.events);

		// create 的会话开始事件：resumed=false
		const starts = telemetryEvents.filter((e) => e.type === "session_start");
		expect(starts).toHaveLength(1);
		const start = starts[0];
		if (start?.type !== "session_start") throw new Error("session_start 缺失");
		expect(start.resumed).toBe(false);

		const turnEnds = telemetryEvents.filter((e) => e.type === "turn_end");
		expect(turnEnds).toHaveLength(1);
		const turnEnd = turnEnds[0];
		if (turnEnd?.type !== "turn_end") throw new Error("turn_end 缺失");
		expect(turnEnd.outcome).toBe("success");
		expect(turnEnd.workerCount).toBe(1);
		// token 汇总覆盖 main + worker 的整棵 agent 树
		expect(turnEnd.inputTokens).toBe(EXPECTED_INPUT_TOKENS);
		expect(turnEnd.outputTokens).toBe(EXPECTED_OUTPUT_TOKENS);
		expect(turnEnd.byModel["test-high"]).toEqual({
			inputTokens: EXPECTED_INPUT_TOKENS,
			outputTokens: EXPECTED_OUTPUT_TOKENS,
		});

		// 线路上没有任何对话文本
		const wire = JSON.stringify(requests.map((request) => request.body));
		expect(wire).not.toContain(USER_PROMPT);
		expect(wire).not.toContain(WORKER_TEXT);
		expect(wire).not.toContain(ASSISTANT_TEXT);

		// session_end 只在 close 时上报
		expect(telemetryEvents.some((e) => e.type === "session_end")).toBe(false);
		await sm.close(rec.id);
		await waitFor(() =>
			capturedEvents(requests).some((e) => e.type === "session_end"),
		);
		const sessionEnd = capturedEvents(requests).find(
			(e) => e.type === "session_end",
		);
		if (sessionEnd?.type !== "session_end") {
			throw new Error("session_end 缺失");
		}
		expect(sessionEnd.sessionId).toBe(rec.id);
		expect(sessionEnd.turns).toBe(1);
		expect(sessionEnd.errors).toBe(0);
	});

	it("attachById 上报 session_start(resumed: true)", async () => {
		await writeSettings({
			enabled: true,
			endpoint: "https://telemetry.example",
		});
		const { fetchImpl, requests } = createFakeFetch();
		const sm = createSessionManager({
			home,
			llm: { adapter: scriptedAdapter([]), model: MODEL },
			telemetryFetch: fetchImpl,
		});
		const rec = await sm.create(proj);
		await sm.close(rec.id);
		await waitFor(() =>
			capturedEvents(requests).some((e) => e.type === "session_end"),
		);
		requests.length = 0;

		const attached = await sm.attachById(rec.id);
		expect(attached).not.toBeNull();
		// session_start 只入队，不单独触发 flush：再 close 一次让 session_start 与 session_end 一起发出
		await sm.close(rec.id);
		await waitFor(() =>
			capturedEvents(requests).some((e) => e.type === "session_start"),
		);
		const start = capturedEvents(requests).find(
			(e) => e.type === "session_start",
		);
		if (start?.type !== "session_start") {
			throw new Error("session_start 缺失");
		}
		expect(start.resumed).toBe(true);
		expect(start.sessionId).toBe(rec.id);
		expect(capturedEvents(requests).some((e) => e.type === "session_end")).toBe(
			true,
		);
	});

	it("settings.telemetry.enabled 为 false 时全程不发请求", async () => {
		await writeSettings({
			enabled: false,
			endpoint: "https://telemetry.example",
		});
		const { fetchImpl, requests } = createFakeFetch();
		const sm = createSessionManager({
			home,
			llm: {
				adapter: scriptedAdapter([
					textRound(ASSISTANT_TEXT, { input: 10, output: 5 }),
				]),
				model: MODEL,
			},
			telemetryFetch: fetchImpl,
		});
		const rec = await sm.create(proj);
		const { events, sink } = makeSink();
		sm.subscribe(rec.id, null, sink);
		await sm.send(rec.id, USER_PROMPT);
		await waitFor(() => events.some(isTurnEnd));
		await sm.close(rec.id);

		expect(requests).toEqual([]);
	});

	it("endpoint 为空时全程不发请求", async () => {
		// settings 里的空 endpoint 会回退到环境变量；环境变量同样置空即视为未配置
		await writeSettings({ enabled: true, endpoint: "" });
		process.env.HOTPOT_TELEMETRY_ENDPOINT = "";
		const { fetchImpl, requests } = createFakeFetch();
		const sm = createSessionManager({
			home,
			llm: {
				adapter: scriptedAdapter([
					textRound(ASSISTANT_TEXT, { input: 10, output: 5 }),
				]),
				model: MODEL,
			},
			telemetryFetch: fetchImpl,
		});
		const rec = await sm.create(proj);
		const { events, sink } = makeSink();
		sm.subscribe(rec.id, null, sink);
		await sm.send(rec.id, USER_PROMPT);
		await waitFor(() => events.some(isTurnEnd));
		await sm.close(rec.id);

		expect(requests).toEqual([]);
	});

	it("上报 fetch 抛错时回合仍成功", async () => {
		await writeSettings({
			enabled: true,
			endpoint: "https://telemetry.example",
		});
		const telemetryFetch: typeof fetch = async () => {
			throw new Error("telemetry endpoint down");
		};
		const sm = createSessionManager({
			home,
			llm: {
				adapter: scriptedAdapter([
					textRound(ASSISTANT_TEXT, { input: 10, output: 5 }),
				]),
				model: MODEL,
			},
			telemetryFetch,
		});
		const rec = await sm.create(proj);
		const { events, sink } = makeSink();
		sm.subscribe(rec.id, null, sink);

		await sm.send(rec.id, USER_PROMPT);
		await waitFor(() => events.some(isTurnEnd));
		await sm.close(rec.id);

		const turnEnd = events.find(
			(e): e is Extract<WireEvent, { kind: "turn" }> =>
				e.kind === "turn" && e.phase === "end",
		);
		if (turnEnd === undefined) {
			throw new Error("turn end 缺失");
		}
		// 遥测失败不改变回合结果
		expect(turnEnd.stopReason).toBe("stop");
	});
});
