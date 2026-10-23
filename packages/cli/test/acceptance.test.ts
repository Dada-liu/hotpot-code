// M1 验收场景的多层编排迁移版（docs/archive/04-roadmap.md 验收标准 1/2，M2 三层流重跑）：
// 场景 A：「找出 src 下所有 .ts 文件，统计行数写入 report.txt」——main 首轮 spawn_workers(simple) 派 worker，
//   worker 完成 bash 统计 → write 报告 → 摘要回传，main 收尾；断言 report.txt 真实生成、
//   会话文件含完整事件链（spawn + worker 工具步 + usage 记录）
// 场景 B：模拟进程重启——同一会话文件经 resumeSession + deriveMessages 恢复后续聊一轮，
//   断言新一轮请求的 messages 携带 main 的完整历史（worker 事件按 agentId 过滤不进 main 历史）
// worker 事件不外传（M2 计划决定 #3），工具步断言经会话文件（tool_result 带 agentId）完成。

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChatRequest,
	type LlmAdapter,
	type ModelInfo,
	type StreamEvent,
	scriptedAdapter,
} from "@hotpot/ai";
import {
	listSessions,
	loadSession,
	type SessionEvent,
	type Settings,
} from "@hotpot/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ChatInput, type ChatOutput, runChat } from "../src/chat.ts";

// home 放会话文件，workdir 是 agent 的工作目录（里面造 src/*.ts 供统计）
let home: string;
let workdir: string;
let oldEnvHome: string | undefined;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-acc-home-"));
	workdir = await mkdtemp(join(tmpdir(), "hotpot-acc-work-"));
	oldEnvHome = process.env.HOTPOT_HOME;
	process.env.HOTPOT_HOME = home;
	await mkdir(join(workdir, "src"));
	await writeFile(join(workdir, "src", "alpha.ts"), "a1\na2\na3\n");
	await writeFile(join(workdir, "src", "beta.ts"), "b1\nb2\nb3\nb4\nb5\n");
});

afterEach(async () => {
	if (oldEnvHome === undefined) {
		delete process.env.HOTPOT_HOME;
	} else {
		process.env.HOTPOT_HOME = oldEnvHome;
	}
	await rm(home, { recursive: true, force: true });
	await rm(workdir, { recursive: true, force: true });
});

const SETTINGS: Settings = {
	models: {
		high: { provider: "test", model: "test-model", apiKey: "test-key" },
		medium: { provider: "test", model: "test-model-medium", apiKey: "k" },
		low: { provider: "test", model: "test-model-low", apiKey: "k" },
	},
};

const TEST_MODEL: ModelInfo = {
	id: "test-model",
	provider: "test",
	api: "openai-completions",
	contextWindow: 100000,
	maxTokens: 4096,
	cost: { input: 0, output: 0 },
};

class ScriptedInput implements ChatInput {
	private lines: string[];

	constructor(lines: string[]) {
		this.lines = [...lines];
	}

	readLine(): Promise<string | null> {
		return Promise.resolve(this.lines.shift() ?? null);
	}

	setInterruptHandler(_cb: (() => void) | null): void {}

	close(): void {}
}

class CollectedOutput implements ChatOutput {
	text = "";

	write(s: string): void {
		this.text += s;
	}
}

function toolCallRound(
	id: string,
	name: string,
	inputJson: string,
): StreamEvent[] {
	return [
		{ type: "tool_call_start", id, name },
		{ type: "tool_call_delta", id, inputDelta: inputJson },
		{ type: "tool_call_end", id },
		{ type: "usage", usage: { input: 10, output: 5 } },
		{ type: "finish", reason: "tool_calls" },
	];
}

function textRound(text: string): StreamEvent[] {
	return [
		{ type: "text_delta", delta: text },
		{ type: "usage", usage: { input: 20, output: 8 } },
		{ type: "finish", reason: "stop" },
	];
}

// main 的首轮 spawn_workers 轮：simple 直派一个 low 档 worker，task 复用原用户消息
function spawnWorkersRound(task: string): StreamEvent[] {
	return toolCallRound(
		"m-tc-1",
		"spawn_workers",
		JSON.stringify({ workers: [{ task, modelTier: "low" }] }),
	);
}

const TASK = "找出 src 下所有 .ts 文件，统计行数写入 report.txt";
const REPORT_CONTENT = "alpha.ts: 3 行\nbeta.ts: 5 行\n合计: 8 行\n";
const WORKER_SUMMARY =
	"统计完成：alpha.ts 3 行，beta.ts 5 行，合计 8 行，已写入 report.txt";
const FINAL_ANSWER = "已找到 2 个 .ts 文件，共 8 行，结果已写入 report.txt。";

// 场景 A 脚本（全局调用序）：main 首轮 spawn_workers → worker bash 统计 → worker write 报告
// → worker 摘要收尾 → main 文本收尾
const SCENARIO_A_SCRIPT: StreamEvent[][] = [
	spawnWorkersRound(TASK),
	toolCallRound("tc-1", "bash", '{"command":"wc -l src/alpha.ts src/beta.ts"}'),
	toolCallRound(
		"tc-2",
		"write",
		JSON.stringify({ path: "report.txt", content: REPORT_CONTENT }),
	),
	textRound(WORKER_SUMMARY),
	textRound(FINAL_ANSWER),
];

describe("M1 验收（M2 编排流迁移）", () => {
	it("场景 A：多步工具调用生成 report.txt，会话文件含完整事件链与 usage", async () => {
		const input = new ScriptedInput([TASK, "/exit"]);
		const output = new CollectedOutput();
		await runChat({
			cwd: workdir,
			home,
			settings: SETTINGS,
			llm: { adapter: scriptedAdapter(SCENARIO_A_SCRIPT), model: TEST_MODEL },
			input,
			output,
		});

		// report.txt 真实生成且内容正确
		const report = await readFile(join(workdir, "report.txt"), "utf8");
		expect(report).toBe(REPORT_CONTENT);
		expect(output.text).toContain(FINAL_ANSWER);

		// 会话文件事件链：meta → main(user→spawn_workers) → spawn → worker(user→bash→result→write→result→摘要→agent_end)
		//   → main(spawn_workers 结果) → main 收尾
		const sessions = await listSessions(home);
		expect(sessions).toHaveLength(1);
		const { events } = await loadSession(sessions[0]?.filePath ?? "");
		expect(events.map((e) => e.type)).toEqual([
			"meta",
			"user_msg",
			"assistant_msg",
			"agent_spawn",
			"user_msg",
			"assistant_msg",
			"tool_result",
			"assistant_msg",
			"tool_result",
			"assistant_msg",
			"agent_end",
			"tool_result",
			"assistant_msg",
		]);

		const assistantMsgs = events.filter(
			(e): e is Extract<SessionEvent, { type: "assistant_msg" }> =>
				e.type === "assistant_msg",
		);
		// 每个 assistant_msg 都带 usage 记录与模型 id
		for (const msg of assistantMsgs) {
			expect(msg.usage.input).toBeGreaterThan(0);
			expect(msg.usage.output).toBeGreaterThan(0);
			expect(msg.model).toBe("test-model");
		}
		// worker 的前两条 assistant 消息各携带一个 tool_call 块（bash → write）
		const workerMsgs = assistantMsgs.filter((m) => m.agentId === "worker-1");
		expect(workerMsgs[0]?.content).toEqual([
			{
				type: "tool_call",
				id: "tc-1",
				name: "bash",
				input: { command: "wc -l src/alpha.ts src/beta.ts" },
			},
		]);
		expect(workerMsgs[1]?.content).toEqual([
			{
				type: "tool_call",
				id: "tc-2",
				name: "write",
				input: { path: "report.txt", content: REPORT_CONTENT },
			},
		]);
		// tool_result 记录真实工具输出：wc 的行数统计与 write 的写入确认
		const toolResults = events.filter(
			(e): e is Extract<SessionEvent, { type: "tool_result" }> =>
				e.type === "tool_result",
		);
		expect(
			toolResults.some(
				(r) => r.agentId === "worker-1" && r.content.includes("8 total"),
			),
		).toBe(true);
		expect(
			toolResults.some(
				(r) =>
					r.agentId === "worker-1" && r.content.includes("Wrote report.txt"),
			),
		).toBe(true);
	});

	it("场景 B：同一会话文件恢复后续聊，新一轮请求携带完整历史", async () => {
		// 先跑完场景 A，留下带完整事件链的会话文件
		await runChat({
			cwd: workdir,
			home,
			settings: SETTINGS,
			llm: { adapter: scriptedAdapter(SCENARIO_A_SCRIPT), model: TEST_MODEL },
			input: new ScriptedInput([TASK, "/exit"]),
			output: new CollectedOutput(),
		});
		const sessions = await listSessions(home);
		const sessionPath = sessions[0]?.filePath ?? "";

		// 模拟进程重启：新一次 runChat 经 --session 走 resumeSession，
		// runTurn 内部 loadSession + deriveMessages 重建历史；记录适配器捕获真实请求
		const requests: ChatRequest[] = [];
		const inner = scriptedAdapter([
			spawnWorkersRound("这些文件一共多少行？"),
			textRound("两个文件合计 8 行。"),
			textRound("两个文件合计 8 行。"),
		]);
		const recording: LlmAdapter = {
			api: inner.api,
			streamChat(req, signal) {
				requests.push(req);
				return inner.streamChat(req, signal);
			},
		};
		const output = new CollectedOutput();
		await runChat({
			cwd: workdir,
			home,
			sessionPath,
			settings: SETTINGS,
			llm: { adapter: recording, model: TEST_MODEL },
			input: new ScriptedInput(["这些文件一共多少行？", "/exit"]),
			output,
		});

		expect(output.text).toContain("两个文件合计 8 行。");
		// 续聊写回同一文件，不新建会话
		expect(await listSessions(home)).toHaveLength(1);

		// 新一轮请求携带 main 的完整历史（worker 事件按 agentId 过滤，不进 main 上下文）：
		// 任务 → spawn_workers 调用 → spawn_workers 结果（含 worker 摘要）→ 收尾回答 → 新问题
		const messages = requests[0]?.messages ?? [];
		expect(messages).toHaveLength(5);
		expect(messages[0]).toEqual({
			role: "user",
			content: [{ type: "text", text: TASK }],
		});
		expect(messages[1]?.role).toBe("assistant");
		expect(messages[1]?.content[0]).toMatchObject({
			type: "tool_call",
			name: "spawn_workers",
		});
		expect(messages[2]?.role).toBe("user");
		expect(messages[2]?.content[0]).toMatchObject({
			type: "tool_result",
			toolCallId: "m-tc-1",
		});
		expect(messages[3]).toEqual({
			role: "assistant",
			content: [{ type: "text", text: FINAL_ANSWER }],
		});
		expect(messages[4]).toEqual({
			role: "user",
			content: [{ type: "text", text: "这些文件一共多少行？" }],
		});

		// 会话文件追加完整：场景 A 的 13 事件 + 新一轮 8 事件（main user→spawn_workers→结果 + spawn + worker 摘要→agent_end + main 收尾）
		const { events } = await loadSession(sessionPath);
		expect(events.map((e) => e.type)).toEqual([
			"meta",
			"user_msg",
			"assistant_msg",
			"agent_spawn",
			"user_msg",
			"assistant_msg",
			"tool_result",
			"assistant_msg",
			"tool_result",
			"assistant_msg",
			"agent_end",
			"tool_result",
			"assistant_msg",
			"user_msg",
			"assistant_msg",
			"agent_spawn",
			"user_msg",
			"assistant_msg",
			"agent_end",
			"tool_result",
			"assistant_msg",
		]);
	});
});
