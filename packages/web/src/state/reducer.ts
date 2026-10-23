// 会话 UI 状态的纯函数归约：WireEvent 流 → ChatState。
// 不依赖 DOM/React，node 下可单测。核心规则：
// - transcript 只收 main 的 user_msg；assistant_msg 的工具块落成工具卡片，
//   tool_result 按 toolCallId + agentId 配对回填
// - agent 树由 spawn / log(agent_spawn) 登记；log(agent_end) 把仍 running 的翻为
//   done/failed（failed 不回退），log(error) 即时标 failed；turn(end) 只做回合级
//   收敛（turn/pending/流式段），不再触碰 agent 状态
// - log 事件按 event.id 去重（tailer 重放/断线补发会重复投递）
// - delta 只累加进当前流式段；assistant_msg 到达后流式段定格（以 content 为准）；
//   turn(end) 与 log(error) 兜底清理（LLM 失败路径无 assistant_msg 定格）

import type {
	ContentBlock,
	InboxMessage,
	InboxSnapshot,
	SessionEvent,
	TodoItem,
	WireEvent,
} from "../protocol.ts";

export type AgentStatus = "running" | "done" | "failed";

// agent 树节点：spawn / log(agent_spawn) 登记
export interface AgentNode {
	agentId: string;
	role: "worker" | "task";
	tier: string;
	task: string;
	parentAgentId: string;
	status: AgentStatus;
	// 最近一个尚未收到结果的工具名
	currentTool?: string;
	lastEventAt: string;
}

// transcript 条目（主对话投影：用户/助手消息、工具卡片、plan 卡片、审批痕迹、错误）
export type TranscriptEntry =
	| { kind: "user"; id: string; ts: string; agentId: string; content: string }
	| {
			kind: "assistant";
			id: string;
			ts: string;
			agentId: string;
			content: ContentBlock[];
	  }
	| {
			kind: "tool";
			id: string;
			ts: string;
			agentId: string;
			toolCallId: string;
			name: string;
			input: unknown;
			result?: { content: string; isError: boolean };
	  }
	| {
			kind: "plan";
			id: string;
			ts: string;
			phase: "drafted" | "approved" | "denied" | "revision_exhausted";
			plan?: string;
	  }
	| {
			kind: "approval";
			id: string;
			ts: string;
			requestId: string;
			approvalType: "tool" | "plan";
			summary: string;
			decision?: "approved" | "denied";
			note?: string;
	  }
	| {
			kind: "error";
			id: string;
			ts: string;
			agentId: string;
			code: string;
			message: string;
	  };

// 待用户处理的审批请求（approval 事件登记，decided 日志或 turn(end) 清除）
export interface PendingApproval {
	requestId: string;
	approvalType: "tool" | "plan";
	summary: string;
	detail?: string;
	plan?: string;
}

export interface PendingPlan {
	entryId: string;
	plan?: string;
}

// 当前流式段：delta 累加；assistant_msg 到达后定格清除
export interface StreamingSegment {
	agentId: string;
	text: string;
}

export interface ChatState {
	transcript: TranscriptEntry[];
	agents: AgentNode[];
	streaming: StreamingSegment | null;
	pendingApproval: PendingApproval | null;
	pendingPlan: PendingPlan | null;
	turn: "idle" | "running";
	// token 用量累计：log(assistant_msg) 时按 tier 分组累加
	// （含历史重放，幂等去重保证不重复计；tier 默认 "high"，与 core 一致）
	usage: UsageTotals;
	// steer/queue 两队列（inbox/spliced 折叠；REST 快照可覆盖修正消费后的残留）
	inbox: InboxSnapshot;
	// agent 任务清单：todo/set 全量快照按 agentId 折叠（last-write-wins），
	// 右侧面板卡片在状态栏下方实时渲染
	todosByAgent: Record<string, TodoItem[]>;
	// 作为计划正文落盘的 assistant_msg id：UI 只保留 plan 卡片，不再重复渲染正文气泡
	hiddenPlanMessageIds: string[];
	// 已见过的 log 事件 id（幂等去重）
	seenEventIds: string[];
}

export interface UsageTotals {
	total: { input: number; output: number };
	byTier: Record<string, { input: number; output: number; count: number }>;
}

export function createInitialState(): ChatState {
	return {
		transcript: [],
		agents: [],
		streaming: null,
		pendingApproval: null,
		pendingPlan: null,
		turn: "idle",
		usage: { total: { input: 0, output: 0 }, byTier: {} },
		inbox: { nextTurn: [], nextStep: [] },
		todosByAgent: {},
		hiddenPlanMessageIds: [],
		seenEventIds: [],
	};
}

// approval/decided 折叠（decided 日志与本地乐观应答共用）：
// 清除匹配 requestId 的 pendingApproval，回填审计条目的决定
export function applyApprovalDecided(
	state: ChatState,
	decided: {
		requestId: string;
		decision: "approved" | "denied";
		note?: string;
	},
): ChatState {
	const transcript = state.transcript.map((t) =>
		t.kind === "approval" && t.requestId === decided.requestId
			? { ...t, decision: decided.decision, note: decided.note }
			: t,
	);
	const pendingApproval =
		state.pendingApproval?.requestId === decided.requestId
			? null
			: state.pendingApproval;
	const pendingPlan =
		state.pendingApproval?.requestId === decided.requestId &&
		state.pendingApproval.approvalType === "plan"
			? null
			: state.pendingPlan;
	return { ...state, transcript, pendingApproval, pendingPlan };
}

// 本地动作：事件折叠、队列快照覆盖、会话切换重置，以及审批应答的乐观收敛。
// App 的 useReducer 以本函数为 reducer；与 reduce 一样保持纯函数、node 下可单测
export type ChatAction =
	| { type: "event"; event: WireEvent }
	| { type: "inbox"; snapshot: InboxSnapshot }
	| { type: "reset" }
	| {
			type: "approval-answered";
			requestId: string;
			decision: "approved" | "denied";
	  };

export function reduceChatAction(
	state: ChatState,
	action: ChatAction,
): ChatState {
	switch (action.type) {
		case "reset":
			return createInitialState();
		case "inbox":
			return applyInboxSnapshot(state, action.snapshot);
		case "approval-answered":
			// 应答已送达服务端：与 decided 日志走同一折叠路径立即关闭审批框，
			// 不等 SSE 往返；服务端 decided 日志随后到达时幂等
			return applyApprovalDecided(state, action);
		default:
			return reduce(state, action.event);
	}
}

// 按消息 id 去重（同快照内重复不重复展示，保留首次出现次序）
function dedupeMessages(messages: InboxMessage[]): InboxMessage[] {
	const seen = new Set<string>();
	const out: InboxMessage[] = [];
	for (const m of messages) {
		if (seen.has(m.id)) {
			continue;
		}
		seen.add(m.id);
		out.push(m);
	}
	return out;
}

// REST 快照覆盖本地折叠状态：消费（drain/poll）不落事件，快照是唯一能纠正
// 「已消费但仍显示」的路径。拷贝数组避免与调用方共享引用
export function applyInboxSnapshot(
	state: ChatState,
	snapshot: InboxSnapshot,
): ChatState {
	return {
		...state,
		inbox: {
			nextTurn: [...snapshot.nextTurn],
			nextStep: [...snapshot.nextStep],
		},
	};
}

// 把一条 assistant_msg 的 usage 累加进 totals（按 tier 分桶）
function accumulateUsage(
	totals: UsageTotals,
	usage: { input: number; output: number },
	tier: string,
): UsageTotals {
	const bucket = totals.byTier[tier] ?? { input: 0, output: 0, count: 0 };
	return {
		total: {
			input: totals.total.input + usage.input,
			output: totals.total.output + usage.output,
		},
		byTier: {
			...totals.byTier,
			[tier]: {
				input: bucket.input + usage.input,
				output: bucket.output + usage.output,
				count: bucket.count + 1,
			},
		},
	};
}

export function reduce(state: ChatState, event: WireEvent): ChatState {
	switch (event.kind) {
		case "log":
			return reduceLog(state, event.event);
		case "delta": {
			// 只累加当前 agent 的流式段（delta 目前仅 main 产出）
			const base =
				state.streaming?.agentId === event.agentId ? state.streaming.text : "";
			return {
				...state,
				streaming: { agentId: event.agentId, text: base + event.text },
			};
		}
		case "turn": {
			if (event.phase === "start") {
				// 新任务开始：右侧面板只展示本回合 spawn 的 agent，
				// 清空上一任务的 agent 树与 todo 清单（turn(start) 不重放，
				// 重开历史会话时末轮 agent 不受影响的原理与此相同）
				return {
					...state,
					turn: "running",
					agents: [],
					todosByAgent: {},
				};
			}
			// 回合结束：兜底清掉 pending 与流式段（LLM 失败时无 assistant_msg
			// 定格，turn(end) 是最后收敛点）；agent 状态由 agent_end/log(error) 驱动
			return {
				...state,
				turn: "idle",
				pendingApproval: null,
				pendingPlan: null,
				streaming: null,
			};
		}
		case "plan":
			return reducePlan(state, event);
		case "spawn":
			return {
				...state,
				agents: upsertAgent(state.agents, {
					agentId: event.agentId,
					role: event.role,
					tier: event.tier,
					task: event.task,
					parentAgentId: event.parentAgentId,
					lastEventAt: "",
				}),
			};
		case "approval": {
			// plan 审批由 plan 卡片承担；asked/decided 日志已提供审计，不重复落条目
			if (event.approvalType === "plan") {
				return state;
			}
			// 登记待审批并落一条审计痕迹
			const entry: TranscriptEntry = {
				kind: "approval",
				id: `approval:${event.requestId}`,
				ts: "",
				requestId: event.requestId,
				approvalType: event.approvalType,
				summary: event.summary,
			};
			return {
				...state,
				transcript: [...state.transcript, entry],
				pendingApproval: {
					requestId: event.requestId,
					approvalType: event.approvalType,
					summary: event.summary,
					detail: event.detail,
					plan: event.plan,
				},
			};
		}
	}
}

function reduceLog(state: ChatState, event: SessionEvent): ChatState {
	// meta 无 id，忽略（不记录会话信息）
	if (event.type === "meta") {
		return state;
	}
	// 幂等：同 id 重复投递直接返回
	if (state.seenEventIds.includes(event.id)) {
		return state;
	}
	state = { ...state, seenEventIds: [...state.seenEventIds, event.id] };

	switch (event.type) {
		case "user_msg": {
			// 只收 main 的 user_msg（steer 注入同样落 user_msg，归属 main）
			if (event.agentId !== "main") {
				return state;
			}
			const entry: TranscriptEntry = {
				kind: "user",
				id: event.id,
				ts: event.ts,
				agentId: event.agentId,
				content: event.content,
			};
			return { ...state, transcript: [...state.transcript, entry] };
		}
		case "internal_msg": {
			// 编排层内部延续提示：进入模型历史，但不属于用户输入，UI 不渲染
			return state;
		}
		case "assistant_msg": {
			// 工具块落成工具卡片；最后一个 in-flight 工具名记到 agent.currentTool
			const toolEntries: TranscriptEntry[] = [];
			let currentTool: string | undefined;
			for (const block of event.content) {
				if (block.type === "tool_call") {
					currentTool = block.name;
					toolEntries.push({
						kind: "tool",
						id: block.id,
						ts: event.ts,
						agentId: event.agentId,
						toolCallId: block.id,
						name: block.name,
						input: block.input,
					});
				}
			}
			const assistantEntry: TranscriptEntry = {
				kind: "assistant",
				id: event.id,
				ts: event.ts,
				agentId: event.agentId,
				content: event.content,
			};
			return {
				...state,
				// 工具块落成工具卡片；usage 按 tier 分桶累计进面板用量条
				usage: event.usage
					? accumulateUsage(state.usage, event.usage, event.tier ?? "high")
					: state.usage,
				// 计划正文由 plan 卡片承载：隐藏对应 assistant 气泡，工具卡片仍保留
				transcript: state.hiddenPlanMessageIds.includes(event.id)
					? [...state.transcript, ...toolEntries]
					: [...state.transcript, assistantEntry, ...toolEntries],
				// 流式段定格：durable 消息已落 transcript，以 content 为准
				streaming:
					state.streaming?.agentId === event.agentId ? null : state.streaming,
				agents:
					currentTool === undefined
						? touchAgent(state.agents, event.agentId, event.ts, (a) => a)
						: touchAgent(state.agents, event.agentId, event.ts, (a) => ({
								...a,
								currentTool,
							})),
			};
		}
		case "tool_result": {
			const agentId = event.agentId ?? "main";
			// 配对回填工具卡片
			const transcript = state.transcript.map((t) =>
				t.kind === "tool" &&
				t.toolCallId === event.toolCallId &&
				t.agentId === agentId
					? { ...t, result: { content: event.content, isError: event.isError } }
					: t,
			);
			// 父级工具结束，清除其 currentTool
			const agents = touchAgent(state.agents, agentId, event.ts, (a) => ({
				...a,
				currentTool: undefined,
			}));
			return { ...state, transcript, agents };
		}
		case "agent_spawn":
			return {
				...state,
				agents: upsertAgent(state.agents, {
					agentId: event.agentId,
					role: event.role === "task" ? "task" : "worker",
					tier: event.tier,
					task: event.task,
					parentAgentId: event.parentAgentId,
					lastEventAt: event.ts,
				}),
			};
		case "agent_end":
			// 下层 agent turn 收尾：只翻转仍 running 的卡片，failed 不回退
			// （error 可能已先标 failed）；currentTool 随收尾清除
			return {
				...state,
				agents: touchAgent(state.agents, event.agentId, event.ts, (a) =>
					a.status === "running"
						? {
								...a,
								status:
									event.outcome === "failed"
										? ("failed" as const)
										: ("done" as const),
								currentTool: undefined,
							}
						: a,
				),
			};
		case "approval/asked": {
			// 审计痕迹：payload.requestId 可关联到对应审批条目；
			// plan 流程的 payload 是 {kind:"plan", plan}，不能按工具审批展示
			const requestId =
				typeof event.payload.requestId === "string"
					? event.payload.requestId
					: event.id;
			const approvalType =
				event.payload.kind === "plan" ? ("plan" as const) : ("tool" as const);
			const entry: TranscriptEntry = {
				kind: "approval",
				id: event.id,
				ts: event.ts,
				requestId,
				approvalType,
				summary:
					typeof event.payload.summary === "string"
						? event.payload.summary
						: approvalType === "plan"
							? "执行计划"
							: "",
			};
			return { ...state, transcript: [...state.transcript, entry] };
		}
		case "approval/decided":
			// 清除对应 pending；回填审批条目的决定
			return applyApprovalDecided(state, event);
		case "inbox/spliced": {
			// 每次变更动词落该队列的全量快照：整体替换并按 id 去重（last write wins）
			const messages = dedupeMessages(event.messages);
			return {
				...state,
				inbox:
					event.queue === "next-turn"
						? { ...state.inbox, nextTurn: messages }
						: { ...state.inbox, nextStep: messages },
			};
		}
		case "todo/set":
			// todo 工具的全量快照：整体覆盖该 agent 的清单（last-write-wins）
			return {
				...state,
				todosByAgent: {
					...state.todosByAgent,
					[event.agentId]: event.todos,
				},
			};
		// M4 新增事件：与主对话渲染无关（hook/skill/prompt/mcp 由遥测与审计消费），
		// 幂等去重已在函数入口完成
		case "hook/fired":
		case "skill/loaded":
		case "prompt/invoked":
		case "mcp/attached":
			return state;
		case "error": {
			const entry: TranscriptEntry = {
				kind: "error",
				id: event.id,
				ts: event.ts,
				agentId: event.agentId,
				code: event.code,
				message: event.message,
			};
			return {
				...state,
				transcript: [...state.transcript, entry],
				// 该 agent 的流式段随失败清理（其余 agent 的流式段不受影响）
				streaming:
					state.streaming?.agentId === event.agentId ? null : state.streaming,
				agents: touchAgent(state.agents, event.agentId, event.ts, (a) => ({
					...a,
					status: "failed",
				})),
			};
		}
	}
}

function reducePlan(
	state: ChatState,
	event: Extract<WireEvent, { kind: "plan" }>,
): ChatState {
	if (event.phase === "drafted") {
		const entryId = `plan:${event.seq}`;
		const entry: TranscriptEntry = {
			kind: "plan",
			id: entryId,
			ts: "",
			phase: "drafted",
			plan: event.plan,
		};
		// 计划正文由卡片承载：隐藏对应 assistant 气泡。messageIds 为空时保持旧行为；
		// 同时记录 id 集合，后到的 assistant 日志也不会重新渲染（SSE 顺序兜底）。
		const messageIds = event.messageIds ?? [];
		const hiddenPlanMessageIds = [
			...state.hiddenPlanMessageIds,
			...messageIds.filter((id) => !state.hiddenPlanMessageIds.includes(id)),
		];
		const transcript =
			messageIds.length === 0
				? state.transcript
				: state.transcript.filter(
						(t) => !(t.kind === "assistant" && messageIds.includes(t.id)),
					);
		return {
			...state,
			transcript: [...transcript, entry],
			pendingPlan: { entryId, plan: event.plan },
			hiddenPlanMessageIds,
		};
	}
	// approved/denied/revision_exhausted：回填 plan 卡片并清除 pending
	const transcript = state.transcript.map((t) =>
		t.kind === "plan" && state.pendingPlan && t.id === state.pendingPlan.entryId
			? { ...t, phase: event.phase }
			: t,
	);
	return {
		...state,
		transcript,
		pendingPlan: null,
		// plan 型审批由卡片承担；决定后清掉桥广播留下的 pendingApproval
		pendingApproval:
			state.pendingApproval?.approvalType === "plan"
				? null
				: state.pendingApproval,
	};
}

// 登记或刷新 agent 节点（按 agentId 去重，重复 spawn 不新增）
function upsertAgent(
	agents: AgentNode[],
	init: Omit<AgentNode, "status" | "currentTool">,
): AgentNode[] {
	if (agents.some((a) => a.agentId === init.agentId)) {
		return agents.map((a) =>
			a.agentId === init.agentId ? { ...a, ...init } : a,
		);
	}
	return [...agents, { ...init, status: "running" as const }];
}

// 触碰某个 agent：更新 lastEventAt 并套用修改；节点不存在则忽略
function touchAgent(
	agents: AgentNode[],
	agentId: string,
	ts: string,
	fn: (a: AgentNode) => AgentNode,
): AgentNode[] {
	return agents.map((a) =>
		a.agentId === agentId ? { ...fn(a), lastEventAt: ts } : a,
	);
}
