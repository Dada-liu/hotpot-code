// runAgentInline 收尾落盘 agent_end 测试（web 右侧面板卡片状态的数据源）：
// - 正常收尾：outcome=done，agentId 归属正确，落在该 agent 最后一条 assistant_msg 之后
// - 流失效（runTurn 归一为 error 事件）：outcome=failed
// - abort（signal 贯穿）：outcome=failed
// - 无 summary（finish=stop 但零文本块）：outcome=failed
// - runTurn 抛错（会话文件被换成目录，step 内 loadSession EISDIR）：原异常照常
//   上抛，但 agent_end(failed) 仍经 finally 落盘（append spy 记录为证）
// 驱动方式与 todo-flow 同款：createRuntime + 自定义适配器，turn 经 runAgentInline。

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type LlmAdapter,
	type StreamEvent,
	scriptedAdapter,
	type Usage,
} from "@hotpot/ai";
import {
	ApprovalChain,
	createSession,
	loadSession,
	type ModelTier,
	type SessionEvent,
	type Settings,
} from "@hotpot/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createRuntime,
	type OrchestrationRuntime,
} from "../src/runtime/runtime.ts";
import { runAgentInline } from "../src/tools/run-worker.ts";

let home: string;
let proj: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-run-worker-home-"));
	proj = await mkdtemp(join(tmpdir(), "hotpot-run-worker-proj-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
	await rm(proj, { recursive: true, force: true });
});

const MODELS: Settings["models"] = {
	high: { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "hk" },
	medium: { provider: "openai", model: "gpt-4.1", apiKey: "mk" },
	low: { provider: "deepseek", model: "deepseek-chat", apiKey: "lk" },
};

async function makeRuntime(
	adapter: LlmAdapter,
	features?: Settings["features"],
): Promise<OrchestrationRuntime> {
	const session = await createSession(proj, home);
	const base = createRuntime({
		session,
		cwd: proj,
		approval: new ApprovalChain(),
		models: MODELS,
		features,
	});
	return {
		...base,
		resolveModel(tier: ModelTier) {
			return { ...base.resolveModel(tier), adapter };
		},
	};
}

// 纯文本收尾轮
function textRound(delta: string, usage: Usage): StreamEvent[] {
	return [
		{ type: "text_delta", delta },
		{ type: "usage", usage },
		{ type: "finish", reason: "stop" },
	];
}

// 流一进入就抛错的适配器（runTurn 归一为 error 事件，不向上抛）
function streamErrorAdapter(error: Error): LlmAdapter {
	return {
		api: "recording",
		streamChat() {
			// biome-ignore lint/correctness/useYield: 纯抛错流——进入即抛错，无事件可产出
			return (async function* (): AsyncGenerator<StreamEvent> {
				throw error;
			})();
		},
	};
}

// 首个 text_delta 后触发 onFirst（用于 abort 主流），再抛 AbortError
function abortingAdapter(onFirst: () => void): LlmAdapter {
	return {
		api: "recording",
		streamChat() {
			return (async function* (): AsyncGenerator<StreamEvent> {
				onFirst();
				yield { type: "text_delta", delta: "半截" };
				throw new DOMException("The operation was aborted", "AbortError");
			})();
		},
	};
}

function agentEndEvents(events: SessionEvent[], agentId: string) {
	return events.filter(
		(e): e is Extract<SessionEvent, { type: "agent_end" }> =>
			e.type === "agent_end" && e.agentId === agentId,
	);
}

describe("runAgentInline 收尾落盘 agent_end", () => {
	it("正常收尾：outcome=done，字段齐全，落在该 agent 最后一条 assistant_msg 之后", async () => {
		const adapter = scriptedAdapter([
			textRound("干完了。", { input: 50, output: 10 }),
		]);
		const runtime = await makeRuntime(adapter);

		const outcome = await runAgentInline(
			runtime,
			"worker-1",
			"worker",
			"low",
			new AbortController().signal,
		);
		expect(outcome).toEqual({
			summary: "干完了。",
			failures: [],
			aborted: false,
		});

		const { events } = await loadSession(runtime.session.filePath);
		const ends = agentEndEvents(events, "worker-1");
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({ type: "agent_end", outcome: "done" });
		expect(ends[0]?.id).toBeTruthy();
		expect(ends[0]?.ts).toBeTruthy();
		// 收尾事件落在该 agent 的 assistant_msg 之后（meta 无 id，先投影出 id 序列）
		const assistantIds = events
			.filter(
				(e): e is Extract<SessionEvent, { type: "assistant_msg" }> =>
					e.type === "assistant_msg" && e.agentId === "worker-1",
			)
			.map((e) => e.id);
		const lastAssistantId = assistantIds[assistantIds.length - 1] ?? "";
		const ids = events.map((e) => (e.type === "meta" ? "" : e.id));
		expect(ids.indexOf(ends[0]?.id ?? "")).toBeGreaterThan(
			ids.indexOf(lastAssistantId),
		);
	});

	it("流失效：runTurn 归一为 error 事件，agent_end outcome=failed", async () => {
		const adapter = streamErrorAdapter(new Error("scripted stream failure"));
		const runtime = await makeRuntime(adapter);

		const outcome = await runAgentInline(
			runtime,
			"worker-1",
			"worker",
			"low",
			new AbortController().signal,
		);
		expect(outcome.failures).toEqual(["stream_error: scripted stream failure"]);

		const { events } = await loadSession(runtime.session.filePath);
		const ends = agentEndEvents(events, "worker-1");
		expect(ends).toHaveLength(1);
		expect(ends[0]?.outcome).toBe("failed");
	});

	it("abort：主流 signal 贯穿，agent_end outcome=failed", async () => {
		const controller = new AbortController();
		const adapter = abortingAdapter(() => {
			controller.abort();
		});
		const runtime = await makeRuntime(adapter);

		const outcome = await runAgentInline(
			runtime,
			"worker-1",
			"worker",
			"low",
			controller.signal,
		);
		expect(outcome.aborted).toBe(true);

		const { events } = await loadSession(runtime.session.filePath);
		const ends = agentEndEvents(events, "worker-1");
		expect(ends).toHaveLength(1);
		expect(ends[0]?.outcome).toBe("failed");
	});

	it("无 summary（finish=stop 但零文本块）：agent_end outcome=failed", async () => {
		// 一轮只有 usage/finish、没有 text_delta：assistant_msg 无文本块，摘要缺失
		const adapter = scriptedAdapter([
			[
				{ type: "usage", usage: { input: 10, output: 5 } },
				{ type: "finish", reason: "stop" },
			],
		]);
		const runtime = await makeRuntime(adapter);

		const outcome = await runAgentInline(
			runtime,
			"worker-1",
			"worker",
			"low",
			new AbortController().signal,
		);
		expect(outcome.summary).toBeUndefined();

		const { events } = await loadSession(runtime.session.filePath);
		const ends = agentEndEvents(events, "worker-1");
		expect(ends).toHaveLength(1);
		expect(ends[0]?.outcome).toBe("failed");
	});

	it("runTurn 抛错（日志路径被换成目录）：原异常上抛，agent_end(failed) 仍落盘", async () => {
		const adapter = scriptedAdapter([
			textRound("不会走到。", { input: 50, output: 10 }),
		]);
		// todo=false：跳过 runAgentInline 构建 prompt 前的 foldTodos 读日志，
		// 让 EISDIR 发生在 runTurn 的 step 内（finally 的保障路径）
		const runtime = await makeRuntime(adapter, { todo: false });
		// step 内 loadSession 按路径读文件：换成目录后 EISDIR，抛错点在
		// per-step try/catch 之外，runTurn 迭代器原样上抛（finally 的保障路径）
		await rm(runtime.session.filePath);
		await mkdir(runtime.session.filePath);

		// append spy：委托 append 因句柄/路径异常可能写不进日志，但调用记录
		// 足以证明 finally 里落盘动作已执行
		const appended: SessionEvent[] = [];
		const baseAppend = runtime.session.append.bind(runtime.session);
		const spyRuntime: OrchestrationRuntime = {
			...runtime,
			session: {
				...runtime.session,
				append: async (e: SessionEvent) => {
					appended.push(e);
					await baseAppend(e);
				},
			},
		};

		await expect(
			runAgentInline(
				spyRuntime,
				"worker-1",
				"worker",
				"low",
				new AbortController().signal,
			),
		).rejects.toThrow();
		const end = appended.find(
			(e): e is Extract<SessionEvent, { type: "agent_end" }> =>
				e.type === "agent_end" && e.agentId === "worker-1",
		);
		expect(end?.outcome).toBe("failed");
	});
});
