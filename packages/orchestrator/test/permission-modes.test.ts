// 权限三档（readonly/ask-on-dangerous/full）的审批行为测试（M1）：
// 装配方式镜像 server session-manager 与 cli chat.ts：createPermissionModeDecorator(holder)
// 总是设为 decorateWorkerTool，execute 时按 holder.mode 动态分派；审批链头部经
// createPermissionModeChainHead 动态裁决（执行时读 holder：full 放行、其余委托询问）。驱动方式与 run-worker 同款：createRuntime + scriptedAdapter，
// 下层 turn 经 runAgentInline（worker 走 createWorkerRegistry，装饰器作用于四件套）。
// - readonly：非 read 工具逐个预审批（新文件写入这种非危险操作也询问）
// - ask-on-dangerous：非危险写不询问；危险 bash 询问，deny 则不执行
// - full：危险 bash 也无人可问（链头直接 allow），真实执行
// - 动态分派：装配后改写 holder.mode，后续执行的工具按新模式走

import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
	allowAllHandler,
	createSession,
	type ModelTier,
	type PermissionMode,
	type Settings,
} from "@hotpot/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createPermissionModeChainHead,
	createPermissionModeDecorator,
	createRuntime,
	type OrchestrationRuntime,
} from "../src/runtime/runtime.ts";
import { runAgentInline } from "../src/tools/run-worker.ts";

let home: string;
let proj: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-perm-home-"));
	proj = await mkdtemp(join(tmpdir(), "hotpot-perm-proj-"));
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

// 记录每次询问的请求，并返回预设裁决（默认 allow）——装配层桥/终端 handler 的测试桩
interface RecordedApproval {
	kind: string;
	summary: string;
}

function recordingChain(
	asks: RecordedApproval[],
	decision: "allow" | "deny",
): ApprovalChain {
	const chain = new ApprovalChain();
	chain.use(async (req) => {
		asks.push({ kind: req.kind, summary: req.summary });
		return decision;
	});
	return chain;
}

// 装配镜像调用侧：holder 与 runtime.permissionMode 共享引用，装饰器总是设置
async function makeRuntime(opts: {
	adapter: LlmAdapter;
	approval: ApprovalChain;
	holder: { mode: PermissionMode };
}): Promise<OrchestrationRuntime> {
	const session = await createSession(proj, home);
	const base = createRuntime({
		session,
		cwd: proj,
		approval: opts.approval,
		models: MODELS,
		decorateWorkerTool: createPermissionModeDecorator(opts.holder),
		permissionMode: opts.holder,
	});
	return {
		...base,
		resolveModel(tier: ModelTier) {
			return { ...base.resolveModel(tier), adapter: opts.adapter };
		},
	};
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
		{ type: "usage", usage: { input: 5, output: 3 } },
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

const SIGNAL = new AbortController().signal;

describe("permission mode 三档审批行为", () => {
	it("readonly：新文件写入（非危险操作）也逐个预审批，allow 后真实写入", async () => {
		const asks: RecordedApproval[] = [];
		const holder: { mode: PermissionMode } = { mode: "readonly" };
		const runtime = await makeRuntime({
			adapter: scriptedAdapter([
				toolCallRound(
					"w-tc-1",
					"write",
					JSON.stringify({ path: "out.txt", content: "hi" }),
				),
				textRound("写完了", { input: 5, output: 3 }),
			]),
			approval: recordingChain(asks, "allow"),
			holder,
		});

		const outcome = await runAgentInline(
			runtime,
			"worker-1",
			"worker",
			"low",
			SIGNAL,
		);
		expect(outcome.failures).toEqual([]);
		expect(await readFile(join(proj, "out.txt"), "utf8")).toBe("hi");
		// 预审批一次：kind 按工具副作用映射为 write，summary 标明 readonly 来源
		expect(asks).toHaveLength(1);
		expect(asks[0]?.kind).toBe("write");
		expect(asks[0]?.summary).toContain("readonly");
	});

	it("readonly：危险 bash 预审批 + 工具内建判定各询问一次（旧 always 语义）", async () => {
		const target = join(proj, "readonly-target");
		await mkdir(target);
		const asks: RecordedApproval[] = [];
		const holder: { mode: PermissionMode } = { mode: "readonly" };
		const runtime = await makeRuntime({
			adapter: scriptedAdapter([
				toolCallRound(
					"w-tc-1",
					"bash",
					JSON.stringify({ command: `rm -rf ${target}` }),
				),
				textRound("清理完毕", { input: 5, output: 3 }),
			]),
			approval: recordingChain(asks, "allow"),
			holder,
		});

		const outcome = await runAgentInline(
			runtime,
			"worker-1",
			"worker",
			"low",
			SIGNAL,
		);
		expect(outcome.failures).toEqual([]);
		// 两次询问：装饰器预审批（kind=command）+ bash 内建危险判定
		expect(asks).toHaveLength(2);
		expect(asks[0]?.kind).toBe("command");
		expect(asks[1]?.summary).toContain("rm -rf");
	});

	it("ask-on-dangerous：新文件写入不询问、直接执行", async () => {
		const asks: RecordedApproval[] = [];
		const holder: { mode: PermissionMode } = { mode: "ask-on-dangerous" };
		const runtime = await makeRuntime({
			adapter: scriptedAdapter([
				toolCallRound(
					"w-tc-1",
					"write",
					JSON.stringify({ path: "out.txt", content: "hi" }),
				),
				textRound("写完了", { input: 5, output: 3 }),
			]),
			approval: recordingChain(asks, "allow"),
			holder,
		});

		const outcome = await runAgentInline(
			runtime,
			"worker-1",
			"worker",
			"low",
			SIGNAL,
		);
		expect(outcome.failures).toEqual([]);
		expect(await readFile(join(proj, "out.txt"), "utf8")).toBe("hi");
		expect(asks).toHaveLength(0);
	});

	it("ask-on-dangerous：危险 bash 询问，deny 则不执行（内建危险判定唯一询问来源）", async () => {
		const target = join(proj, "ask-on-dangerous-target");
		await mkdir(target);
		const asks: RecordedApproval[] = [];
		const holder: { mode: PermissionMode } = { mode: "ask-on-dangerous" };
		const runtime = await makeRuntime({
			adapter: scriptedAdapter([
				toolCallRound(
					"w-tc-1",
					"bash",
					JSON.stringify({ command: `rm -rf ${target}` }),
				),
				textRound("已跳过", { input: 5, output: 3 }),
			]),
			approval: recordingChain(asks, "deny"),
			holder,
		});

		const outcome = await runAgentInline(
			runtime,
			"worker-1",
			"worker",
			"low",
			SIGNAL,
		);
		// deny 返回 isError 的 tool_result，不算 runTurn 级失败；目录必须还在
		expect(outcome.failures).toEqual([]);
		expect(asks).toHaveLength(1);
		expect(asks[0]?.summary).toContain("rm -rf");
		await expect(access(target)).resolves.toBeUndefined();
	});

	it("full：链头 allowAllHandler 直接放行，危险 bash 零询问真实执行", async () => {
		const target = join(proj, "full-target");
		await mkdir(target);
		const asks: RecordedApproval[] = [];
		const holder: { mode: PermissionMode } = { mode: "full" };
		// 装配镜像调用侧：full 模式链头挂 allowAllHandler，不注册应答 handler
		const chain = new ApprovalChain();
		chain.use(allowAllHandler);
		chain.use(async (req) => {
			asks.push({ kind: req.kind, summary: req.summary });
			return "deny"; // 绝不会执行到：allowAllHandler 短路
		});
		const runtime = await makeRuntime({
			adapter: scriptedAdapter([
				toolCallRound(
					"w-tc-1",
					"bash",
					JSON.stringify({ command: `rm -rf ${target}` }),
				),
				textRound("清理完毕", { input: 5, output: 3 }),
			]),
			approval: chain,
			holder,
		});

		const outcome = await runAgentInline(
			runtime,
			"worker-1",
			"worker",
			"low",
			SIGNAL,
		);
		expect(outcome.failures).toEqual([]);
		expect(asks).toHaveLength(0);
		// 目录真的被删掉：放行执行
		await expect(access(target)).rejects.toThrow();
	});

	it("动态分派：装配后改写 holder.mode，后续执行的工具按新模式走", async () => {
		const asks: RecordedApproval[] = [];
		const holder: { mode: PermissionMode } = { mode: "readonly" };
		// 一个适配器按全局调用序回放 4 轮：turn-1 写 a.txt（readonly 预审批），
		// 运行期翻成 ask-on-dangerous 后 turn-2 写 b.txt（不再询问）
		const runtime = await makeRuntime({
			adapter: scriptedAdapter([
				toolCallRound(
					"w-tc-1",
					"write",
					JSON.stringify({ path: "a.txt", content: "a" }),
				),
				textRound("第一次写完", { input: 5, output: 3 }),
				toolCallRound(
					"w-tc-2",
					"write",
					JSON.stringify({ path: "b.txt", content: "b" }),
				),
				textRound("第二次写完", { input: 5, output: 3 }),
			]),
			approval: recordingChain(asks, "allow"),
			holder,
		});

		await runAgentInline(runtime, "worker-1", "worker", "low", SIGNAL);
		expect(asks).toHaveLength(1);
		expect(await readFile(join(proj, "a.txt"), "utf8")).toBe("a");

		// 运行期切换（M2 端点的语义）：holder 即 runtime.permissionMode 持有的对象
		holder.mode = "ask-on-dangerous";
		expect(runtime.permissionMode.mode).toBe("ask-on-dangerous");
		await runAgentInline(runtime, "worker-2", "worker", "low", SIGNAL);
		expect(asks).toHaveLength(1);
		expect(await readFile(join(proj, "b.txt"), "utf8")).toBe("b");
	});
});

describe("createPermissionModeChainHead 动态链头（M2 修订）", () => {
	it("执行时读 holder：ask-on-dangerous 委托询问、full 直接放行、切回继续询问", async () => {
		const holder: { mode: PermissionMode } = { mode: "ask-on-dangerous" };
		const asks: string[] = [];
		const chain = new ApprovalChain();
		chain.use(
			createPermissionModeChainHead(holder, async (req) => {
				asks.push(req.kind);
				return "deny";
			}),
		);
		const req = { kind: "command", summary: "s", detail: "d" } as const;
		// ask-on-dangerous：委托询问 handler（此处恒 deny，验证真的走到了询问）
		expect(await chain.ask(req)).toBe("deny");
		expect(asks).toHaveLength(1);
		// 运行期切 full：同一 chain 直接 allow，询问 handler 不再被调
		holder.mode = "full";
		expect(await chain.ask(req)).toBe("allow");
		expect(asks).toHaveLength(1);
		// 切回 readonly：恢复委托询问
		holder.mode = "readonly";
		expect(await chain.ask(req)).toBe("deny");
		expect(asks).toHaveLength(2);
	});
});
