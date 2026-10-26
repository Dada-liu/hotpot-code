// 编排运行时：spawn_workers/spawn_tasks、plan 流程、inbox 等后续能力都闭包在这个对象上。
// spawn 只负责三件事：首次调用时按既有日志播种计数器（resume 场景防 agentId 复用，见下）、
// 按 role 计数分配 agentId（worker-1、task-1…，runtime 生命周期内单调递增不复用），
// 并把 agent_spawn 事件落盘（id/ts 由这里组装，append 本身带 fsync，见 core session/store.ts）。
// spawn 不运行任何 turn —— 回合执行是后续任务的责任。
// resolveModel(tier) 把 settings 里的档位 ModelRef 解析为适配器 + 模型 + 凭证。

import { randomUUID } from "node:crypto";
import type {
	ApprovalChain,
	ApprovalHandler,
	HookChain,
	ModelTier,
	PermissionMode,
	Session,
	SessionEvent,
	Settings,
	Skill,
	ToolDefinition,
} from "@hotpot/core";
import {
	createWebSearchBackendFromConfig,
	loadSession,
	type WebSearchBackend,
} from "@hotpot/core";
import { type ModelResolution, resolveModel } from "../models/models.ts";
import type { AgentRole } from "../types/types.ts";

// worker/task 注册表工具装饰器：装配层注入权限包装（createPermissionModeDecorator）
// 的唯一通道 —— 下层注册表由编排层内部装配，调用方只能经 runtime 闭包把包装带进来；
// 默认原样返回（无装饰）。
// 语义钉死（M4 Review Focus）：只包四件套基础工具，feature 派生的外工具不包
export type WorkerToolDecorator = (
	tool: ToolDefinition<unknown>,
) => ToolDefinition<unknown>;

// 工具入参摘要：input 来自 runTurn 的 JSON.parse，恒为 JSON-safe；防御性 try/catch 兜底
function summarizeToolInput(input: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(input) ?? "";
	} catch {
		text = String(input);
	}
	return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

// 权限模式动态分派的 worker 工具装饰器（M1，替代旧 policy=always 的静态包装）：
// 装配期总是设置，execute 时才读 holder.mode —— readonly 下非 read 工具逐个预审批
// （旧 always 语义）；ask-on-dangerous/full 原样放行（ask-on-dangerous 靠工具内建危险判定询问，
// full 靠 createPermissionModeChainHead 动态链头兜底，永不打断）。
// read 永不包：无副作用，任何模式下都不询问。holder 与 runtime.permissionMode
// 共享同一对象引用，运行期改写 holder.mode 立即对尚未执行的工具生效
export function createPermissionModeDecorator(holder: {
	mode: PermissionMode;
}): WorkerToolDecorator {
	return (tool) => {
		if (tool.name === "read") {
			return tool;
		}
		return {
			...tool,
			execute: async (args, ctx) => {
				if (holder.mode !== "readonly") {
					return tool.execute(args, ctx);
				}
				const decision = await ctx.approval.ask({
					kind: tool.name === "bash" ? "command" : "write",
					summary: `Run tool "${tool.name}" (permission mode: readonly)`,
					detail: summarizeToolInput(args),
				});
				if (decision === "deny") {
					return {
						content: `tool "${tool.name}" denied by approval`,
						isError: true,
					};
				}
				return tool.execute(args, ctx);
			},
		};
	};
}

// 权限模式动态分派的审批链头处理器（M2 修订）：与装饰器一样在 ask 时才读
// holder.mode —— full 直接放行（运行期从 ask-on-dangerous/readonly 切到 full 立即生效，
// 永不打断）；其余模式原样委托调用方传入的询问 handler（server 桥 / cli 终端）。
// 替代旧装配期静态挂 allowAllHandler 的做法（装配后切换 full 不生效的缺口）
export function createPermissionModeChainHead(
	holder: { mode: PermissionMode },
	ask: ApprovalHandler,
): ApprovalHandler {
	return async (req) => (holder.mode === "full" ? "allow" : ask(req));
}

export interface OrchestrationRuntime {
	readonly session: Session;
	readonly cwd: string;
	readonly approval: ApprovalChain;
	readonly maxParallelTasks: number;
	readonly planMaxRevisions: number;
	readonly decorateWorkerTool?: WorkerToolDecorator;
	// M1 权限模式可变持有者：装配时从 settings 初始化（默认 ask-on-dangerous），
	// 运行期可被 server API 改写（M2 端点）；与装饰器工厂共享引用，
	// 改写立即对后续工具执行生效
	permissionMode: { mode: PermissionMode };
	// —— M4 可选透传（createRuntime 默认空；Task 2-6 逐步消费）——
	// features：功能开关（读取侧一律经 core 的 featureEnabled `?? true`）
	readonly features?: Settings["features"];
	// skills：扫描到的 skill 清单（Task 6 注入 prompt + read 追踪）
	readonly skills?: Skill[];
	// mcpTools：MCP 桥接工具（Task 5 连接后注入；features.mcp 关闭则不并入注册表）
	readonly mcpTools?: readonly ToolDefinition<unknown>[];
	// webSearchBackend：web_search 工具后端；默认由 createRuntime 依 opts.webSearch
	// 经 core 的 createWebSearchBackendFromConfig 解析（默认 duckduckgo），
	// 显式注入（webSearchBackend opt）优先，是 hermetic 测试的注入缝
	readonly webSearchBackend?: WebSearchBackend;
	// hooks：生命周期钩子链（M4 Feature③）；装配层按 features.hooks 门控注入，
	// 回合包装层经 runtime.hooks 触发 session_start/turn_end，runTurn 触发 pre/post tool
	readonly hooks?: HookChain;
	resolveModel(tier: ModelTier): ModelResolution;
	spawn(opts: {
		role: AgentRole;
		parentAgentId: string;
		task: string;
		tier: ModelTier;
	}): Promise<{ agentId: string }>;
}

export function createRuntime(opts: {
	session: Session;
	cwd: string;
	approval: ApprovalChain;
	models: Settings["models"];
	maxParallelTasks?: number;
	planMaxRevisions?: number;
	decorateWorkerTool?: WorkerToolDecorator;
	// M1 权限模式持有者：缺省 { mode: "ask-on-dangerous" }；装配层传入时须与
	// createPermissionModeDecorator 共享同一对象，保证运行期改写对装饰器可见
	permissionMode?: { mode: PermissionMode };
	features?: Settings["features"];
	skills?: Skill[];
	mcpTools?: readonly ToolDefinition<unknown>[];
	webSearch?: Settings["webSearch"];
	webSearchBackend?: WebSearchBackend;
	hooks?: HookChain;
}): OrchestrationRuntime {
	// 每个 role 一条计数链：同一 runtime 内单调递增，编号不复用
	const counters = new Map<AgentRole, number>();
	// 计数器播种标记：播种只做一次。CLI --session 恢复旧会话后若计数器从 0 重启，
	// 首个委派又会 spawn 出 worker-1，deriveMessages 按 agentId 过滤会把旧 worker-1
	// 的完整 transcript 折进新 worker 上下文（agentId 复用污染）。故首次 spawn 前
	// 按既有日志播种：取各 role 已有 agent_spawn 的编号最大值作为计数起点。
	// createRuntime 是同步接口而 loadSession 是 async，spawn 本身已是 async，
	// 故在 spawn 内惰性播种（标记位同步置位，并发 spawn 也只播一次）。
	// spawn 编号按调用序 FIFO 分配（spawn_tasks 的脚本分发依赖「编号 FIFO × 描述锚定」
	// 锚定确定性）：播种的 await 会把首个 spawn 的编号发放推迟到文件读完之后，
	// 并发 spawn 时编号与调用序错位。故 spawn 经一条 Promise 链串行化，
	// 保证「播种 → 编号 → 落盘」严格按调用顺序执行（spawn 只做计数与一行落盘，
	// 串行化不影响其后 task turn 的并行执行）。
	let countersSeeded = false;
	let spawnTail: Promise<void> = Promise.resolve();

	async function seedCounters(): Promise<void> {
		if (countersSeeded) {
			return;
		}
		countersSeeded = true;
		let events: SessionEvent[];
		try {
			events = (await loadSession(opts.session.filePath)).events;
		} catch {
			return; // 文件不存在或损坏：按 0 处理，等价于全新会话
		}
		for (const e of events) {
			if (e.type !== "agent_spawn") {
				continue;
			}
			const m = /-(\d+)$/.exec(e.agentId);
			if (!m) {
				continue; // 非编号形态（如 main）不参与计数
			}
			const role = e.role as AgentRole;
			const n = Number(m[1]);
			counters.set(role, Math.max(counters.get(role) ?? 0, n));
		}
	}

	return {
		session: opts.session,
		cwd: opts.cwd,
		approval: opts.approval,
		maxParallelTasks: opts.maxParallelTasks ?? 10,
		planMaxRevisions: opts.planMaxRevisions ?? 3,
		decorateWorkerTool: opts.decorateWorkerTool,
		permissionMode: opts.permissionMode ?? { mode: "ask-on-dangerous" },
		features: opts.features,
		skills: opts.skills,
		mcpTools: opts.mcpTools,
		webSearchBackend:
			opts.webSearchBackend ?? createWebSearchBackendFromConfig(opts.webSearch),
		hooks: opts.hooks,

		resolveModel(tier: ModelTier): ModelResolution {
			return resolveModel(opts.models[tier]);
		},

		async spawn(spawnOpts: {
			role: AgentRole;
			parentAgentId: string;
			task: string;
			tier: ModelTier;
		}): Promise<{ agentId: string }> {
			const job = spawnTail.then(() => doSpawn(spawnOpts));
			// 尾指针吞掉 rejection 只作串行化用； rejection 经 job 原样抛给调用方
			spawnTail = job.then(
				() => {},
				() => {},
			);
			return job;
		},
	};

	async function doSpawn(spawnOpts: {
		role: AgentRole;
		parentAgentId: string;
		task: string;
		tier: ModelTier;
	}): Promise<{ agentId: string }> {
		await seedCounters();
		const next = (counters.get(spawnOpts.role) ?? 0) + 1;
		counters.set(spawnOpts.role, next);
		const agentId = `${spawnOpts.role}-${next}`;
		await opts.session.append({
			type: "agent_spawn",
			id: randomUUID(),
			ts: new Date().toISOString(),
			parentAgentId: spawnOpts.parentAgentId,
			agentId,
			role: spawnOpts.role,
			task: spawnOpts.task,
			tier: spawnOpts.tier,
		});
		return { agentId };
	}
}
