// runChat 测试（M2 编排流）：每个场景脚本前补 main 的首轮 spawn_workers 轮（simple，
// 单 worker 任务复用原用户消息），worker 轮做实际工具工作，main 文本轮收尾。
// worker 事件不外传（M2 计划决定 #3）：工具调用/结果不落终端渲染，可经会话文件
//（tool_result 带 agentId）与 spawn_workers 摘要 tool_result 断言；
// 审批询问仍走终端 handler（在 worker 工具执行内触发），交互断言不变。
// 脚本化适配器按全局 streamChat 调用序回放：1=main 首轮步，2..N=worker 各步，末位=main 收尾。

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
	createSession,
	listSessions,
	loadSession,
	type SessionEvent,
	type Settings,
} from "@hotpot/core";
import { resolveModel } from "@hotpot/orchestrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ChatInput,
	type ChatOutput,
	parseChatArgs,
	runChat,
} from "../src/chat.ts";

// 每个用例一个临时 home（同时写进 HOTPOT_HOME，贴近真实运行条件）
let home: string;
let oldEnvHome: string | undefined;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-cli-test-"));
	oldEnvHome = process.env.HOTPOT_HOME;
	process.env.HOTPOT_HOME = home;
});

afterEach(async () => {
	if (oldEnvHome === undefined) {
		delete process.env.HOTPOT_HOME;
	} else {
		process.env.HOTPOT_HOME = oldEnvHome;
	}
	await rm(home, { recursive: true, force: true });
});

const TS = "2026-10-10T08:00:00.000Z";

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

// 脚本化输入：按队列逐行返回，耗尽后返回 null（EOF）；interrupt 模拟 Ctrl-C
class ScriptedInput implements ChatInput {
	private lines: string[];
	private handler: (() => void) | null = null;

	constructor(lines: string[]) {
		this.lines = [...lines];
	}

	readLine(): Promise<string | null> {
		return Promise.resolve(this.lines.shift() ?? null);
	}

	setInterruptHandler(cb: (() => void) | null): void {
		this.handler = cb;
	}

	interrupt(): void {
		this.handler?.();
	}

	close(): void {}
}

// 收集输出为字符串；onWrite 钩子供「输出出现某文本时中断」类用例使用
class CollectedOutput implements ChatOutput {
	text = "";
	onWrite?: (s: string) => void;

	write(s: string): void {
		this.text += s;
		this.onWrite?.(s);
	}
}

// 一轮「调用单个工具」的脚本：tool_call_start/delta/end + usage + finish
function toolCallRound(
	id: string,
	name: string,
	inputJson: string,
): StreamEvent[] {
	return [
		{ type: "tool_call_start", id, name },
		{ type: "tool_call_delta", id, inputDelta: inputJson },
		{ type: "tool_call_end", id },
		{ type: "usage", usage: { input: 5, output: 3 } },
		{ type: "finish", reason: "tool_calls" },
	];
}

function textRound(text: string): StreamEvent[] {
	return [
		{ type: "text_delta", delta: text },
		{ type: "usage", usage: { input: 2, output: 1 } },
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

describe("runChat", () => {
	it("问→答→/exit：输出含回答文本，且生成了会话文件", async () => {
		const input = new ScriptedInput(["你好", "/exit"]);
		const output = new CollectedOutput();
		await runChat({
			cwd: home,
			home,
			settings: SETTINGS,
			llm: {
				adapter: scriptedAdapter([
					spawnWorkersRound("你好"),
					textRound("worker 已处理：你好"),
					textRound("你好，世界"),
				]),
				model: TEST_MODEL,
			},
			input,
			output,
		});

		expect(output.text).toContain("你好，世界");
		// 渲染扩展：agent_spawn 以 [spawn] 行展示（task 截断到 80 字符，这里短任务原样展示）
		expect(output.text).toContain("[spawn] worker-1 (tier=low): 你好");
		const sessions = await listSessions(home);
		expect(sessions).toHaveLength(1);
		const { events } = await loadSession(sessions[0]?.filePath ?? "");
		// 编排流完整事件链：main(user→spawn_workers→结果) + spawn + worker(user→摘要→agent_end) + main 收尾
		expect(events.map((e) => e.type)).toEqual([
			"meta",
			"user_msg",
			"assistant_msg",
			"agent_spawn",
			"user_msg",
			"assistant_msg",
			"agent_end",
			"tool_result",
			"assistant_msg",
		]);
		const spawn = events.find((e) => e.type === "agent_spawn");
		expect(spawn).toMatchObject({
			agentId: "worker-1",
			parentAgentId: "main",
			role: "worker",
			tier: "low",
			task: "你好",
		});
	});

	it("危险命令触发审批：回答 n 拒绝执行，deny 落盘到 worker 的 tool_result", async () => {
		const script: StreamEvent[][] = [
			spawnWorkersRound("清理临时目录"),
			toolCallRound(
				"tc-1",
				"bash",
				'{"command":"rm -rf /tmp/hotpot-cli-test-target"}',
			),
			textRound("已取消操作"),
			textRound("好的，已跳过该操作"),
		];
		const input = new ScriptedInput(["清理临时目录", "n", "/exit"]);
		const output = new CollectedOutput();
		await runChat({
			cwd: home,
			home,
			settings: SETTINGS,
			llm: { adapter: scriptedAdapter(script), model: TEST_MODEL },
			input,
			output,
		});

		// 审批交互仍走终端 handler（worker 的 bash 执行内触发），命令原文进 detail
		expect(output.text).toContain("[approval]");
		expect(output.text).toContain("rm -rf");
		expect(output.text).toContain("已拒绝");
		// worker 摘要经 spawn_workers 的 tool_result 渲染回终端
		expect(output.text).toContain("已取消操作");
		expect(output.text).toContain("好的，已跳过该操作");

		// worker 的 bash deny 路径落盘：isError tool_result（worker 事件不外传，改查会话文件）
		const sessions = await listSessions(home);
		const { events } = await loadSession(sessions[0]?.filePath ?? "");
		const denied = events.find(
			(e): e is Extract<SessionEvent, { type: "tool_result" }> =>
				e.type === "tool_result" &&
				e.agentId === "worker-1" &&
				e.isError === true &&
				e.content.includes("denied"),
		);
		expect(denied).toBeDefined();
		// command 审批经 createAuditedApprovalChain 落盘 asked/decided 对
		expect(events.filter((e) => e.type === "approval/asked")).toHaveLength(1);
		const decided = events.find((e) => e.type === "approval/decided");
		expect(decided).toMatchObject({ decision: "denied" });
	});

	it("approval policy=never：不询问，危险操作 fail-closed 直接 deny", async () => {
		const settings: Settings = {
			...SETTINGS,
			approval: { policy: "never" },
		};
		const script: StreamEvent[][] = [
			spawnWorkersRound("清理临时目录"),
			toolCallRound(
				"tc-1",
				"bash",
				'{"command":"rm -rf /tmp/hotpot-cli-test-target"}',
			),
			textRound("已跳过危险操作"),
			textRound("收到"),
		];
		// 输入队列不含审批回答：若仍发起终端询问会消费掉 /exit 导致用例失败
		const input = new ScriptedInput(["清理临时目录", "/exit"]);
		const output = new CollectedOutput();
		await runChat({
			cwd: home,
			home,
			settings,
			llm: { adapter: scriptedAdapter(script), model: TEST_MODEL },
			input,
			output,
		});

		expect(output.text).not.toContain("[approval]");
		expect(output.text).toContain("已跳过危险操作");
		const sessions = await listSessions(home);
		const { events } = await loadSession(sessions[0]?.filePath ?? "");
		// fail-closed deny 照样落盘（无终端 handler，asked/decided 仍经审计包装写日志）
		const denied = events.find(
			(e): e is Extract<SessionEvent, { type: "tool_result" }> =>
				e.type === "tool_result" &&
				e.agentId === "worker-1" &&
				e.isError === true &&
				e.content.includes("denied"),
		);
		expect(denied).toBeDefined();
		const decided = events.find((e) => e.type === "approval/decided");
		expect(decided).toMatchObject({ decision: "denied" });
	});

	it("approval policy=always：安全命令也先询问，回答 y 放行执行", async () => {
		const settings: Settings = {
			...SETTINGS,
			approval: { policy: "always" },
		};
		const script: StreamEvent[][] = [
			spawnWorkersRound("打个招呼"),
			toolCallRound("tc-1", "bash", '{"command":"echo policy-always-ok"}'),
			textRound("执行完毕"),
			textRound("已完成"),
		];
		const input = new ScriptedInput(["打个招呼", "y", "/exit"]);
		const output = new CollectedOutput();
		await runChat({
			cwd: home,
			home,
			settings,
			llm: { adapter: scriptedAdapter(script), model: TEST_MODEL },
			input,
			output,
		});

		// echo 不是危险命令，ask-on-dangerous 下不会询问；always 下询问并放行
		expect(output.text).toContain("[approval]");
		expect(output.text).toContain("已允许");
		expect(output.text).toContain("执行完毕");
		const sessions = await listSessions(home);
		const { events } = await loadSession(sessions[0]?.filePath ?? "");
		// 放行执行：worker 的 echo tool_result 真实落盘（worker 事件不外传，改查会话文件）
		const echoed = events.find(
			(e): e is Extract<SessionEvent, { type: "tool_result" }> =>
				e.type === "tool_result" &&
				e.agentId === "worker-1" &&
				e.isError !== true &&
				e.content.includes("policy-always-ok"),
		);
		expect(echoed).toBeDefined();
	});

	it("approval policy=always：read 无副作用不询问，结果正常返回", async () => {
		const settings: Settings = {
			...SETTINGS,
			approval: { policy: "always" },
		};
		await writeFile(join(home, "note.txt"), "hello hotpot\n");
		const script: StreamEvent[][] = [
			spawnWorkersRound("读一下 note.txt"),
			toolCallRound("tc-1", "read", '{"path":"note.txt"}'),
			textRound("读取完成"),
			textRound("好的"),
		];
		// 输入队列不含审批回答：read 若被错误包装会发起询问、消费掉 /exit 导致用例失败
		const input = new ScriptedInput(["读一下 note.txt", "/exit"]);
		const output = new CollectedOutput();
		await runChat({
			cwd: home,
			home,
			settings,
			llm: { adapter: scriptedAdapter(script), model: TEST_MODEL },
			input,
			output,
		});

		expect(output.text).not.toContain("[approval]");
		expect(output.text).toContain("读取完成");
		const sessions = await listSessions(home);
		const { events } = await loadSession(sessions[0]?.filePath ?? "");
		// read 正常执行：内容原样进 worker 的 tool_result，全程无 approval/asked
		const read = events.find(
			(e): e is Extract<SessionEvent, { type: "tool_result" }> =>
				e.type === "tool_result" &&
				e.agentId === "worker-1" &&
				e.isError !== true &&
				e.content.includes("hello hotpot"),
		);
		expect(read).toBeDefined();
		expect(events.filter((e) => e.type === "approval/asked")).toHaveLength(0);
	});

	it("--session 恢复：续聊写入同一文件，首轮请求携带历史消息", async () => {
		const session = await createSession(home, home);
		await session.append({
			type: "user_msg",
			id: "u-old",
			ts: TS,
			agentId: "main",
			content: "之前的问题",
		});

		const requests: ChatRequest[] = [];
		const inner = scriptedAdapter([
			spawnWorkersRound("继续"),
			textRound("worker 摘要"),
			textRound("续聊回答"),
		]);
		const recording: LlmAdapter = {
			api: inner.api,
			streamChat(req, signal) {
				requests.push(req);
				return inner.streamChat(req, signal);
			},
		};
		const input = new ScriptedInput(["继续", "/exit"]);
		const output = new CollectedOutput();
		await runChat({
			cwd: home,
			home,
			sessionPath: session.filePath,
			settings: SETTINGS,
			llm: { adapter: recording, model: TEST_MODEL },
			input,
			output,
		});

		// 同一文件继续追加，不新建会话
		expect(await listSessions(home)).toHaveLength(1);
		const { events } = await loadSession(session.filePath);
		expect(events.map((e) => e.type)).toEqual([
			"meta",
			"user_msg",
			"user_msg",
			"assistant_msg",
			"agent_spawn",
			"user_msg",
			"assistant_msg",
			"agent_end",
			"tool_result",
			"assistant_msg",
		]);
		// 首轮请求即携带恢复出的历史（runTurn 内部 loadSession + deriveMessages）：
		// 旧问题在前，本次用户消息在后（spawn_workers 调用是本轮的响应，进第二个请求的历史）
		expect(requests[0]?.messages).toHaveLength(2);
		expect(requests[0]?.messages[0]).toEqual({
			role: "user",
			content: [{ type: "text", text: "之前的问题" }],
		});
		expect(requests[0]?.messages[1]?.content).toEqual([
			{ type: "text", text: "继续" },
		]);
		// 全局调用序：requests[0]=main 第一步（spawn_workers），requests[1]=worker 步，
		// requests[2]=main 收尾步 —— spawn_workers 调用与结果进 main 第二步的历史
		expect(requests[2]?.messages[2]?.content[0]).toMatchObject({
			type: "tool_call",
			name: "spawn_workers",
		});
		expect(requests[2]?.messages[3]?.content[0]).toMatchObject({
			type: "tool_result",
			toolCallId: "m-tc-1",
		});
	});

	it("Ctrl-C 中断当前回合而不退出进程：abort 后循环继续，/exit 正常收尾", async () => {
		// 模拟真实适配器：signal 传入 fetch，abort 使等待中的流以 AbortError rejection 结束
		const hangingAdapter: LlmAdapter = {
			api: "hanging-fake",
			streamChat(_req, signal) {
				return (async function* (): AsyncGenerator<StreamEvent> {
					yield { type: "text_delta", delta: "半截回答" };
					await new Promise<never>((_resolve, reject) => {
						if (signal.aborted) {
							reject(
								new DOMException("The operation was aborted", "AbortError"),
							);
							return;
						}
						signal.addEventListener("abort", () =>
							reject(
								new DOMException("The operation was aborted", "AbortError"),
							),
						);
					});
				})();
			},
		};
		const input = new ScriptedInput(["打个长回合", "/exit"]);
		const output = new CollectedOutput();
		// 回答文本一开始打印就模拟 Ctrl-C
		output.onWrite = (s) => {
			if (s.includes("半截回答")) {
				input.interrupt();
			}
		};
		await runChat({
			cwd: home,
			home,
			settings: SETTINGS,
			llm: { adapter: hangingAdapter, model: TEST_MODEL },
			input,
			output,
		});

		expect(output.text).toContain("半截回答");
		expect(output.text).toContain("[done: aborted]");
		// 中断后 readline 循环继续：第二行 /exit 被消费，正常告别
		expect(output.text).toContain("再见");
	});

	it("tier 默认取 settings.mainAgentTier", async () => {
		const settings: Settings = {
			...SETTINGS,
			mainAgentTier: "medium",
		};
		const input = new ScriptedInput(["hi", "/exit"]);
		const output = new CollectedOutput();
		await runChat({
			cwd: home,
			home,
			settings,
			llm: {
				adapter: scriptedAdapter([
					spawnWorkersRound("hi"),
					textRound("worker 摘要"),
					textRound("ok"),
				]),
				model: TEST_MODEL,
			},
			input,
			output,
		});
		expect(output.text).toContain("tier=medium");
		// --tier 语义不变（主 agent 档）：首轮后 worker 照常 spawn
		expect(output.text).toContain("[spawn] worker-1");
	});

	it("prompt template：/命令展开为模板正文并落 prompt/invoked；未知命令报可用列表", async () => {
		await mkdir(join(home, "prompts"), { recursive: true });
		await writeFile(
			join(home, "prompts", "deploy.md"),
			"---\nname: deploy\ndescription: Deploy helper\n---\nDeploy target: $ARGUMENTS\n",
		);
		const input = new ScriptedInput(["/nope", "/deploy staging", "/exit"]);
		const output = new CollectedOutput();
		await runChat({
			cwd: home,
			home,
			settings: SETTINGS,
			llm: {
				adapter: scriptedAdapter([
					spawnWorkersRound("Deploy target: staging"),
					textRound("worker 完成"),
					textRound("已部署"),
				]),
				model: TEST_MODEL,
			},
			input,
			output,
		});

		// 未知命令：提示可用命令且不进入回合
		expect(output.text).toContain("未知命令：/nope");
		expect(output.text).toContain("/deploy");

		const sessions = await listSessions(home);
		const { events } = await loadSession(sessions[0]?.filePath ?? "");
		const invoked = events.find((e) => e.type === "prompt/invoked");
		expect(invoked).toMatchObject({
			agentId: "main",
			name: "deploy",
			args: "staging",
			content: "Deploy target: staging\n",
		});
		// 展开后的正文作为 user_msg 进入回合（而非原始 /deploy 命令）
		const userTexts = events
			.filter(
				(e): e is Extract<SessionEvent, { type: "user_msg" }> =>
					e.type === "user_msg",
			)
			.map((e) => e.content);
		expect(userTexts).toContain("Deploy target: staging\n");
		expect(userTexts).not.toContain("/deploy staging");
	});
});

describe("parseChatArgs", () => {
	it("解析 chat 子命令与 --session/--tier", () => {
		expect(parseChatArgs(["chat"])).toEqual({});
		expect(
			parseChatArgs(["chat", "--session", "/tmp/s.jsonl", "--tier", "low"]),
		).toEqual({ sessionPath: "/tmp/s.jsonl", tier: "low" });
	});

	it("非法输入报中文用法错误", () => {
		expect(() => parseChatArgs(["nope"])).toThrow(/未知命令/);
		expect(() => parseChatArgs(["chat", "--tier", "ultra"])).toThrow(/--tier/);
		expect(() => parseChatArgs(["chat", "--session"])).toThrow(/--session/);
		expect(() => parseChatArgs(["chat", "--wat"])).toThrow(/未知参数/);
	});
});

describe("resolveModel", () => {
	it("目录内模型按 ModelInfo.api 选适配器，无告警", () => {
		const resolved = resolveModel({
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			apiKey: "k",
		});
		expect(resolved.model.id).toBe("claude-sonnet-4-5");
		expect(resolved.adapter.api).toBe("anthropic-messages");
		expect(resolved.warning).toBeUndefined();
	});

	it("未知模型按 provider 推断协议并给出告警，contextWindow 取 128000", () => {
		const openaiLike = resolveModel({
			provider: "acme",
			model: "acme-1",
			apiKey: "k",
		});
		expect(openaiLike.adapter.api).toBe("openai-completions");
		expect(openaiLike.model.contextWindow).toBe(128000);
		expect(openaiLike.warning).toContain("acme/acme-1");

		const anthropicLike = resolveModel({
			provider: "anthropic",
			model: "claude-future-9",
			apiKey: "k",
		});
		expect(anthropicLike.adapter.api).toBe("anthropic-messages");
		expect(anthropicLike.warning).toBeTruthy();
	});
});
