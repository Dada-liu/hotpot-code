// 下层 agent 内联执行助手：spawn 之后由 spawn_workers（simple 直派与 complex 执行流）
// 复用 worker 版；spawn_tasks 用通用版 runAgentInline 跑每个 task turn。
// 通用版按角色装配注册表（worker 走 createWorkerRegistry —— 闭包绑定了该 worker 的
// spawn_tasks，嵌套拆分才真正可用；task 走 createRoleRegistry 四件套、无派生能力），
// 瞬态事件不外传（M2 计划决定 #3），只回收 error 事件、done(aborted) 与收尾
// summary，失败标注由调用方按统一 taxonomy 决定（Task 9：`[FAILED] ${agentId}: ${reason}`）。
// 收尾在 finally 里额外落盘一条 agent_end（durable）：web 右侧面板卡片状态的
// 完成信号，outcome 与调用方失败taxonomy一致（aborted/error/无 summary 均 failed），
// runTurn 抛错路径也保证落盘。
// M4 Task 2：system prompt 按 features.todo 折入该 agent 的 todo 清单段
// （构建前 foldTodos，关闭开关则不 fold 不出段）；M4 Task 6：skills 段同经
// features.skills 门控注入（清单来自装配层 discoverSkills 扫描）。

import { randomUUID } from "node:crypto";
import {
	featureEnabled,
	foldTodos,
	type LoopConfig,
	loadSession,
	type ModelTier,
	runTurn,
} from "@hotpot/core";
import { buildRoleSystemPrompt } from "../prompts/prompts.ts";
import {
	createRoleRegistry,
	createWorkerRegistry,
} from "../registries/registries.ts";
import type { OrchestrationRuntime } from "../runtime/runtime.ts";

// 读取指定 agent 最后一条 assistant_msg，拼接其文本块作为回传摘要；
// 没有任何 assistant_msg 或文本块为空时返回 undefined，由调用方标注失败
async function readAgentSummary(
	filePath: string,
	agentId: string,
): Promise<string | undefined> {
	const { events } = await loadSession(filePath);
	const messages = events.filter(
		(e) => e.type === "assistant_msg" && e.agentId === agentId,
	);
	const last = messages[messages.length - 1];
	if (last?.type !== "assistant_msg") return undefined;
	const text = last.content
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("");
	return text === "" ? undefined : text;
}

// 内联 turn 的结构化回收结果：summary 缺失 / error 事件 / abort 由调用方判失败
export interface InlineTurnOutcome {
	/** 该 agent 最后一条 assistant_msg 的文本块拼接；无 assistant_msg 或纯空文本为 undefined */
	summary: string | undefined;
	/** runTurn 产出的 error 事件，按 `${code}: ${message}` 收集 */
	failures: string[];
	/** turn 是否以 done(aborted) 收尾（贯穿 signal 被 cancel） */
	aborted: boolean;
}

// 内联跑完一个下层 agent 的整个 turn：注册表按角色装配（worker 闭包 spawn_tasks），
// 走自己的档位模型（runtime.resolveModel(tier)），不复用 main 的适配器；
// 耗尽 runTurn 的异步迭代，瞬态事件不外传，只回收失败标注所需的三元组，
// 收尾落盘 agent_end（web 卡片状态数据源）
export async function runAgentInline(
	runtime: OrchestrationRuntime,
	agentId: string,
	role: "worker" | "task",
	tier: ModelTier,
	signal: AbortSignal,
): Promise<InlineTurnOutcome> {
	const registry =
		role === "worker"
			? createWorkerRegistry(runtime, { agentId, tier })
			: // task 角色同样应用 decorateWorkerTool：policy 包装对下层 agent 一视同仁
				createRoleRegistry(runtime, role, []);
	const resolved = runtime.resolveModel(tier);
	// M4 Task 2：构建 prompt 前经 loadSession 做一次 foldTodos（与结尾 readAgentSummary
	// 的成本模型一致）；features.todo 关闭时不 fold 也不传，prompt 不出 task-list 段
	const todos = featureEnabled(runtime.features, "todo")
		? foldTodos((await loadSession(runtime.session.filePath)).events, agentId)
		: [];
	// M4 Feature④：skills 段（开关关闭时不传，段不出）
	const skills = featureEnabled(runtime.features, "skills")
		? runtime.skills
		: undefined;
	const cfg: LoopConfig = {
		session: runtime.session,
		agentId,
		adapter: resolved.adapter,
		model: resolved.model,
		apiKey: resolved.apiKey,
		baseUrl: resolved.baseUrl,
		registry,
		approval: runtime.approval,
		cwd: runtime.cwd,
		system: buildRoleSystemPrompt(
			role,
			{
				cwd: runtime.cwd,
				os: process.platform,
				date: new Date().toISOString().slice(0, 10),
				tools: registry.declarations(),
			},
			{ skills, todos },
		),
		tier,
		hooks: runtime.hooks,
	};
	const failures: string[] = [];
	let aborted = false;
	let stopReason: string | undefined;
	// try/finally：runTurn 抛错（不止 emits error 事件）时也要保证收尾三件
	// 事执行完，尤其 agent_end 落盘——它是卡片状态的唯一完成信号，漏掉会让
	// web 卡片永远停在 running；原异常在 finally 之后照常向上传播
	let summary: string | undefined;
	try {
		for await (const event of runTurn(cfg, signal)) {
			if (event.type === "error") {
				failures.push(`${event.error.code}: ${event.error.message}`);
			}
			if (event.type === "done") {
				stopReason = event.stopReason;
				if (event.stopReason === "aborted") {
					aborted = true;
				}
			}
		}
	} finally {
		// 每个下层 agent 的 turn 收尾触发一次 Stop 钩子（归属该 agent）
		await runtime.hooks?.run("turn_end", {
			agent_id: agentId,
			stop_reason: stopReason ?? "stop",
		});
		// best-effort：摘要读取失败（如日志中途损坏）不得阻断下面的 agent_end
		// 落盘——它是卡片状态的唯一完成信号，summary 缺失按失败 outcome 处理
		summary = await readAgentSummary(runtime.session.filePath, agentId).catch(
			() => undefined,
		);
		// agent_end：与调用方失败taxonomy对齐（无 summary 也算失败）
		await runtime.session.append({
			type: "agent_end",
			id: randomUUID(),
			ts: new Date().toISOString(),
			agentId,
			outcome:
				aborted || failures.length > 0 || summary === undefined
					? "failed"
					: "done",
		});
	}
	return { summary, failures, aborted };
}

// 内联跑完 worker 的整个 turn（spawn_workers 的 simple 直派与 complex 执行流共用）：
// 注册表来自 createWorkerRegistry（含该 worker 的 spawn_tasks），摘要回收失败时按
// `[${workerId} failed] ${reason}` 标注，失败分类法与 spawn_tasks 的 [FAILED] 段对齐
export async function runWorkerInline(
	runtime: OrchestrationRuntime,
	workerId: string,
	tier: ModelTier,
	signal: AbortSignal,
): Promise<string> {
	const outcome = await runAgentInline(
		runtime,
		workerId,
		"worker",
		tier,
		signal,
	);
	if (outcome.aborted) {
		return `[${workerId} failed] aborted`;
	}
	if (outcome.failures.length > 0) {
		return `[${workerId} failed] ${outcome.failures.join("; ")}`;
	}
	return outcome.summary ?? `[${workerId} failed] no assistant text produced`;
}
