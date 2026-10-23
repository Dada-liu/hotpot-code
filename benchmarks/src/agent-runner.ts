// 无交互 agent runner：为 benchmark 跑一个完整 task turn。
// 与 CLI 共用 core/orchestrator 的装配，但刻意收紧：
// - 临时 HOTPOT_HOME（mkdtemp），不污染用户会话与 telemetry 安装 ID；
// - 显式 allow-all 工具审批（经 audited 包装落盘 asked/decided），plan 自动批准；
//   不用 permission.mode 门控（基准场景要求零打断，显式链头放行语义更直接）；
// - 关闭 todo/hooks/skills/promptTemplates/web/mcp，只留 bash/read/write/edit 等基础工具；
// - maxParallelTasks=1，benchmark 不做并行拆分压测；
// - 只回传 outcome、整棵树的 token、时长与会话路径，不把对话内容带回上层。

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmAdapter, ModelInfo } from "@hotpot/ai";
import {
	ApprovalChain,
	createAuditedApprovalChain,
	createSession,
	loadSession,
	loadSettings,
	type ModelTier,
	type Settings,
} from "@hotpot/core";
import {
	createRuntime,
	type OrchestrationRuntime,
	runMainTurn,
} from "@hotpot/orchestrator";

const DEFAULT_TIMEOUT_MS = 600000;

export interface RunAgentTurnOptions {
	cwd: string;
	prompt: string;
	// 默认加载用户级 settings（真实跑批）；测试注入内存配置
	settings?: Settings;
	modelTier: ModelTier;
	timeoutMs?: number;
	// 测试注入：两者同时提供时覆盖全部档位的模型解析
	adapter?: LlmAdapter;
	model?: ModelInfo;
}

export interface AgentTurnResult {
	outcome: "success" | "error" | "aborted";
	inputTokens: number;
	outputTokens: number;
	durationMs: number;
	sessionFilePath: string;
	error?: string;
}

export async function runAgentTurn(
	opts: RunAgentTurnOptions,
): Promise<AgentTurnResult> {
	const started = Date.now();
	const settings = opts.settings ?? loadSettings();
	const home = await mkdtemp(join(tmpdir(), "hotpot-bench-"));
	const session = await createSession(opts.cwd, home);

	const allowAll = new ApprovalChain();
	allowAll.use(async () => "allow");
	const approval = createAuditedApprovalChain(allowAll, {
		session,
		agentId: "main",
	});

	const baseRuntime = createRuntime({
		session,
		cwd: opts.cwd,
		approval,
		models: settings.models,
		maxParallelTasks: 1,
		features: {
			todo: false,
			hooks: false,
			skills: false,
			promptTemplates: false,
			webSearch: false,
			webFetch: false,
			mcp: false,
		},
	});
	const injectedAdapter = opts.adapter;
	const injectedModel = opts.model;
	const runtime: OrchestrationRuntime =
		injectedAdapter !== undefined && injectedModel !== undefined
			? {
					...baseRuntime,
					resolveModel: () => ({
						adapter: injectedAdapter,
						model: injectedModel,
						apiKey: "test",
					}),
				}
			: baseRuntime;

	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
	let stopReason: string | undefined;
	let sawError = false;
	let errorMessage: string | undefined;

	try {
		for await (const event of runMainTurn({
			runtime,
			userMessage: opts.prompt,
			signal: controller.signal,
			mainTier: opts.modelTier,
			onPlanApproval: async () => ({ kind: "approve" }),
		})) {
			if (event.type === "done") {
				stopReason = event.stopReason;
			} else if (event.type === "error") {
				sawError = true;
				errorMessage ??= event.error.message;
			}
		}
	} catch (err) {
		sawError = true;
		errorMessage = err instanceof Error ? err.message : String(err);
	} finally {
		clearTimeout(timer);
	}

	const usage = await sumUsage(session.filePath);
	const outcome = controller.signal.aborted
		? "aborted"
		: sawError || stopReason !== "stop"
			? "error"
			: "success";
	if (outcome === "error" && errorMessage === undefined) {
		errorMessage =
			stopReason === undefined
				? "turn ended without a done event"
				: `turn ended with stop reason ${stopReason}`;
	}
	if (outcome === "aborted" && errorMessage === undefined) {
		errorMessage = "turn aborted";
	}

	return {
		outcome,
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		durationMs: Date.now() - started,
		sessionFilePath: session.filePath,
		...(errorMessage === undefined ? {} : { error: errorMessage }),
	};
}

// 从会话日志折叠整棵 agent 树（main + worker + task）的 assistant usage。
// 日志损坏时按 0 计，不掩盖 runner 的 outcome。
async function sumUsage(
	filePath: string,
): Promise<{ inputTokens: number; outputTokens: number }> {
	let inputTokens = 0;
	let outputTokens = 0;
	try {
		const { events } = await loadSession(filePath);
		for (const event of events) {
			if (event.type !== "assistant_msg") {
				continue;
			}
			inputTokens += event.usage.input;
			outputTokens += event.usage.output;
		}
	} catch {
		// 读不到日志：token 记 0
	}
	return { inputTokens, outputTokens };
}
