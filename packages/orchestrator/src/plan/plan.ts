// plan 审批流（complex 任务的 human-in-the-loop 修订循环，编排文档 §3）。
// 计划正文优先复用初始轮（main 首轮直接产出的、带 # Plan 标记的最终消息）：
// 只有计划缺失、或 plan 开始时 next-step 队列非空（需要让模型看到用户 steer）
// 时才跑一轮内部起草；批注修订仍走起草轮。每轮：整理 plan → yield drafted
// （携带作为计划落盘的 assistant 消息 id，供 UI 隐藏正文气泡）→ await onPlanApproval
// （默认 fail-closed 拒绝）→ 分流：
//   approve  → 落盘 asked/decided(approved)，state.planApproved/phase 翻转，yield approved，
//              追加执行 kickoff internal_msg 后返回（main-turn 接着跑执行 turn）
//   annotate → revisions++；revisions > planMaxRevisions 时 yield revision_exhausted、
//              落盘说明并结束（不再 asked —— 超限轮的 asked/decided 不落盘）；
//              否则 asked/decided(denied, note=批注) 落盘后带批注进入下一轮修订
//   reject   → asked/decided(denied, note=拒绝理由) 落盘，yield denied，追加拒绝提示，
//              跑一轮收尾 runTurn（main 回复用户）后结束
// 内部提示统一写 internal_msg（进入模型历史、UI 不渲染），plan 阶段注册表为空，
// 避免模型把它当成新用户消息去执行。main-turn 仅在首轮 detectPlanDraft 命中时进入本阶段。

import { randomUUID } from "node:crypto";
import {
	createToolRegistry,
	type LoopConfig,
	loadSession,
	type ModelTier,
	runTurn,
	type SessionEvent,
} from "@hotpot/core";
import type { Inbox } from "../inbox/inbox.ts";
import {
	buildRoleSystemPrompt,
	PLANNING_INSTRUCTIONS,
} from "../prompts/prompts.ts";
import type { OrchestrationRuntime } from "../runtime/runtime.ts";
import type { OrchestrationEvent, TurnState } from "../types/types.ts";

export type PlanDecision =
	| { kind: "approve" }
	| { kind: "reject"; note: string }
	| { kind: "annotate"; note: string };

export interface PlanPhaseOptions {
	onPlanApproval?: (plan: string) => Promise<PlanDecision>;
	// steer/queue 双队列：plan 起草/修订/拒绝收尾轮同样在 step 顶部消费 next-step；
	// 队列非空时先跑一轮 reconcile 起草，保证 steer 在审批前进入模型上下文
	inbox?: Inbox;
}

// 主agent 的 agentId 固定为 "main"：与 main-turn.ts 的 MAIN_AGENT_ID 是同一包级约定
const MAIN_AGENT_ID = "main";

// 首轮起草提示：要求只输出 plan 文本，便于整条 assistant 消息直接作为 plan 回收
const DRAFT_PROMPT =
	"Draft the implementation plan for the approved scope: steps, files involved, " +
	"acceptance criteria. Output ONLY the plan.";

// 初始轮已产出计划、但用户在计划期间又发来 steer：让模型把 steer 纳入后重出最终版
const RECONCILE_PROMPT =
	"The user sent follow-up messages while you were planning. Take them into " +
	"account, revise the plan if needed, and output ONLY the final plan.";

// 批注修订提示：批注原文进入内部消息，驱动下一版计划
function revisionPrompt(annotation: string): string {
	return (
		`The user annotated the previous plan: "${annotation}". Revise the plan ` +
		"accordingly. Output ONLY the revised plan."
	);
}

// 计划被拒绝后的收尾提示：只回复用户，不执行任何操作
const REJECTED_PROMPT =
	"Plan rejected by user. Reply briefly without executing anything.";

// 起草轮没有产出任何文本时的兜底提示：让 main 告知用户，而不是拿空计划去审批
const EMPTY_PLAN_PROMPT =
	"No plan text was produced. Stop and tell the user that you could not produce a plan.";

// 计划草稿的标记与必备段落：complex 首轮流要求模型按 PLAN_FORMAT_TEMPLATE
// （prompts.ts）输出计划正文，本处按同一份标题做结构校验——两处共用模板。
const PLAN_HEADING = "# Plan";
const PLAN_REQUIRED_SECTIONS = [
	"## Steps",
	"## Files",
	"## Acceptance criteria",
];

function isPlanDraftText(text: string): boolean {
	// 模型输出可能出现 CRLF：归一化后再做标题匹配，避免换行风格导致漏检
	const trimmed = text.replace(/\r\n/g, "\n").trimStart();
	if (trimmed !== PLAN_HEADING && !trimmed.startsWith(`${PLAN_HEADING}\n`)) {
		return false;
	}
	return PLAN_REQUIRED_SECTIONS.every((section) => trimmed.includes(section));
}

export interface PlanDraft {
	id: string;
	text: string;
}

// 扫描窗口起点：默认最后一条 main user_msg 之后；传入 afterId（本回合 user_msg
// 事件 id）时锚定到该事件之后——turn 内 steer 注入的 user_msg 不得把首轮计划
// 挤出检测窗口。锚点事件缺失时回退默认窗口。
function scanWindowStart(events: SessionEvent[], afterId?: string): number {
	if (afterId !== undefined) {
		const idx = events.findIndex((e) => "id" in e && e.id === afterId);
		if (idx >= 0) return idx + 1;
	}
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event?.type === "user_msg" && event.agentId === MAIN_AGENT_ID) {
			return i + 1;
		}
	}
	return 0;
}

// 读窗口内最后一条带文本的 main assistant_msg（plan 阶段修订轮复用）。
// internal_msg 不算用户输入，因此批注修订后仍能定位到最新草稿。
async function readLastMainAssistantText(
	runtime: OrchestrationRuntime,
): Promise<PlanDraft | null> {
	const { events } = await loadSession(runtime.session.filePath);
	const start = scanWindowStart(events);
	for (let i = events.length - 1; i >= start; i--) {
		const event = events[i];
		if (event?.type !== "assistant_msg" || event.agentId !== MAIN_AGENT_ID) {
			continue;
		}
		const text = event.content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("");
		if (text.trim() !== "") {
			return { id: event.id, text };
		}
	}
	return null;
}

// 检测本回合是否产出了计划草稿（首轮流路由、spawn_workers 门禁与 plan 阶段
// 初始复用共用）：窗口内从新到旧找第一条带 # Plan 标记与必备段落的 assistant
// 消息。取「最新一条带标记的」而非「最后一条文本」：首轮流允许「计划正文 + 同轮
// 工具调用被守卫拦截后的补充说明」形态，计划标记在较早消息里。漏标/缺段落一律
// 视为普通回答——宁可 complex 被当 trivial 静默跳过审批，不可把闲聊误判成计划
// 拿去审批。
export async function detectPlanDraft(
	runtime: OrchestrationRuntime,
	afterId?: string,
): Promise<PlanDraft | null> {
	const { events } = await loadSession(runtime.session.filePath);
	const start = scanWindowStart(events, afterId);
	for (let i = events.length - 1; i >= start; i--) {
		const event = events[i];
		if (event?.type !== "assistant_msg" || event.agentId !== MAIN_AGENT_ID) {
			continue;
		}
		const text = event.content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("");
		if (isPlanDraftText(text)) {
			return { id: event.id, text };
		}
	}
	return null;
}

// 内部延续提示：进入模型历史但不进入 UI transcript
async function appendInternal(
	runtime: OrchestrationRuntime,
	content: string,
): Promise<void> {
	await runtime.session.append({
		type: "internal_msg",
		id: randomUUID(),
		ts: new Date().toISOString(),
		agentId: MAIN_AGENT_ID,
		content,
	});
}

export async function* runPlanPhase(
	runtime: OrchestrationRuntime,
	state: TurnState,
	signal: AbortSignal,
	options: PlanPhaseOptions = {},
): AsyncIterable<OrchestrationEvent> {
	// plan 阶段刻意挂空注册表：起草/修订只用模型能力——spawn_workers 不可用，
	// M1 起 main 标配的 read 也不可用（plan 阶段不操作文件，规则见 plan/AGENTS.md）。
	// 因此不走 createRoleRegistry("main")（它会注册 read），直接建空注册表
	const registry = createToolRegistry();
	// 起草轮档位：complex 流固定 high（首轮提示词规定 complex 用 high 档）
	const tier: ModelTier = "high";
	const resolved = runtime.resolveModel(tier);
	const inbox = options.inbox;
	const pollInbox = inbox ? () => inbox.pollNextStep() : undefined;
	const cfg: LoopConfig = {
		session: runtime.session,
		agentId: MAIN_AGENT_ID,
		adapter: resolved.adapter,
		model: resolved.model,
		apiKey: resolved.apiKey,
		baseUrl: resolved.baseUrl,
		registry,
		approval: runtime.approval,
		cwd: runtime.cwd,
		system: buildRoleSystemPrompt(
			MAIN_AGENT_ID,
			{
				cwd: runtime.cwd,
				os: process.platform,
				date: new Date().toISOString().slice(0, 10),
				tools: registry.declarations(),
			},
			{ instructions: PLANNING_INSTRUCTIONS },
		),
		tier,
		pollInbox,
	};

	// 初始草稿复用与首轮流路由同一标准（锚定窗口 + 标记校验）：「计划正文 + 同轮
	// 工具调用被拦截后的补充说明」形态下，送审的必须是带标记的计划而不是后续笔记。
	// 修订轮内部的再读仍用 readLastMainAssistantText（修订提示驱动，最后一条文本即草稿）
	let draft = await detectPlanDraft(runtime, state.turnAnchorId);
	// 所有作为计划草稿落盘的 assistant 消息 id：web 用它们隐藏正文气泡
	const messageIds: string[] = draft === null ? [] : [draft.id];
	// 初始轮已有计划时直接进入审批；队列里有 steer 则先 reconcile 一轮
	let needsDraft =
		draft === null || (options.inbox?.snapshot().nextStep.length ?? 0) > 0;
	let revisionNote: string | undefined;

	while (true) {
		if (needsDraft) {
			const prompt =
				revisionNote !== undefined
					? revisionPrompt(revisionNote)
					: draft === null
						? DRAFT_PROMPT
						: RECONCILE_PROMPT;
			await appendInternal(runtime, prompt);
			revisionNote = undefined;
			for await (const event of runTurn(cfg, signal)) {
				yield event;
			}
			if (signal.aborted) return;

			const next = await readLastMainAssistantText(runtime);
			if (next !== null) {
				draft = next;
				if (!messageIds.includes(next.id)) {
					messageIds.push(next.id);
				}
			}
			needsDraft = false;
		}

		if (draft === null) {
			await appendInternal(runtime, EMPTY_PLAN_PROMPT);
			for await (const event of runTurn(cfg, signal)) {
				yield event;
			}
			return;
		}

		const plan = draft.text;
		yield {
			type: "plan",
			phase: "drafted",
			plan,
			messageIds: [...messageIds],
		};
		const decision: PlanDecision = options.onPlanApproval
			? await options.onPlanApproval(plan)
			: { kind: "reject", note: "no approval handler" };

		if (decision.kind === "annotate") {
			state.revisions += 1;
			if (state.revisions > runtime.planMaxRevisions) {
				// 修订耗尽：第 planMaxRevisions+1 次批注直接结束，不再 asked/起草
				yield { type: "plan", phase: "revision_exhausted" };
				await appendInternal(
					runtime,
					`Plan revision limit reached (${String(runtime.planMaxRevisions)} ` +
						"revisions allowed). The plan is not approved; stop planning and " +
						"tell the user.",
				);
				return;
			}
		}

		const askedId = randomUUID();
		await runtime.session.append({
			type: "approval/asked",
			id: askedId,
			ts: new Date().toISOString(),
			agentId: MAIN_AGENT_ID,
			payload: { kind: "plan", plan },
		});

		if (decision.kind === "approve") {
			await runtime.session.append({
				type: "approval/decided",
				id: randomUUID(),
				ts: new Date().toISOString(),
				requestId: askedId,
				decision: "approved",
			});
			state.planApproved = true;
			state.phase = "executing";
			yield { type: "plan", phase: "approved" };
			await appendInternal(
				runtime,
				"Plan approved. Break the work down and call spawn_workers.",
			);
			return;
		}

		// reject 与 annotate 都记 denied，note 携带拒绝理由/批注内容
		await runtime.session.append({
			type: "approval/decided",
			id: randomUUID(),
			ts: new Date().toISOString(),
			requestId: askedId,
			decision: "denied",
			note: decision.note,
		});
		if (decision.kind === "annotate") {
			revisionNote = decision.note;
			needsDraft = true;
			continue;
		}

		yield { type: "plan", phase: "denied" };
		await appendInternal(runtime, REJECTED_PROMPT);
		// 收尾轮：main 基于「计划被拒」回复用户，回合随之结束
		for await (const event of runTurn(cfg, signal)) {
			yield event;
		}
		return;
	}
}
