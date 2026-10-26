// 会话管理器（M3 服务层核心）：turn 串行化、审批桥接线、seq/订阅广播与 usage 统计。
// 回合装配镜像 packages/cli/src/chat.ts 的 runChat：
// - tier = settings.mainAgentTier ?? "high"；new ApprovalChain()——链头挂
//   createPermissionModeChainHead 动态处理器（执行时读 holder：full 直接放行、
//   其余委托桥 handler bridge.registerToolAsk，运行期切换立即生效）；
//   整体经 createAuditedApprovalChain 落盘审计
// - decorateWorkerTool 总是设置 createPermissionModeDecorator(holder)，包装在 execute
//   时按 holder.mode 动态分派（readonly 预审批非 read 工具；ask-on-dangerous/full 原样放行）；
//   holder 同时作为 runtime.permissionMode 传入，运行期可被 API 改写（M2）
// - createRuntime + opts.llm 覆盖 resolveModel（scriptedAdapter 测试注入，同 chat.ts）
// - createInbox(session, "main", {onCancel, seed})；onPlanApproval 走桥的 registerPlanAsk
// - M2 新增能力：权限模式 GET/PUT（统一切换路径 applyPermissionMode：持有者 + durable
//   permission/changed + wire 广播，attach 时 fold 恢复）；队列 steer/remove 薄封装；
//   文本上传（<home>/uploads/<sessionId>/<counter>-<净化名>，绝不覆盖，10 个/会话上限）；
//   fs 浏览（realpath + startsWith 防逃逸，跳过隐藏/node_modules，500 条上限）；
//   内置指令 /help、/permission（send() 里先于 prompt template 解析分发，本地应答）
// - M4 Feature⑦ MCP：开关打开且 settings.mcpServers 非空时 connectMcpServers 建连，
//   工具经 mcpTools 注入 runtime；mcp/attached 经 watermark.session 落盘；
//   mcpCreateClient 为测试注入缝；manager.close 里 closeMcpConnections 统一关闭
//
// 事件转发架构规则（计划级决策）：
// - durable 事件只由 tailer 产出一条路径：迭代器收到的 tool_call/tool_result/
//   assistant_msg/user_msg 一律不转发（它们由 runTurn 落盘、tailer 推 log）；
//   编排层收尾落盘的 agent_end 同样经该 log 路径到达订阅者（web 卡片状态数据源），
//   客户端无需 turn(end) 兜底翻转 agent
// - 迭代器只转发瞬态：text→delta、agent_spawn→spawn、plan→plan；done/error 不直发，
//   收敛为回合收尾的一次 turn(end)（complex 流的起草轮与执行轮各产 done，回合只有一个 end）
// - 边界同步：delta 前与 turn(end) 前 syncDurable()，保证 log(user_msg) 先于首个 delta、
//   log(assistant_msg) 先于 turn(end) 到达订阅者
//
// 广播顺序不变量：每会话一条 emit 管道（hub.emit 同步 fan-out 到订阅者），
// seq 在 emit 时刻分配；订阅时重放先于 live 到达（重放在注册回调前同步完成），
// live 事件按 seq 序推送——每订阅者的 FIFO 序由单线程同步交付天然保证。

import { randomUUID } from "node:crypto";
import {
	mkdir,
	readdir,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { LlmAdapter, ModelInfo } from "@hotpot/ai";
import {
	ApprovalChain,
	createAuditedApprovalChain,
	createHookChain,
	createSession,
	discoverPromptTemplates,
	discoverSkills,
	expandTemplate,
	featureEnabled,
	type InboxMessage,
	isSlashInput,
	listSessions,
	loadSession,
	loadSettings,
	type ModelTier,
	openWorkspaceRegistry,
	type PermissionMode,
	type PromptTemplate,
	resolveHome,
	resolveSlashCommand,
	resumeSession,
	type Session,
	type SessionEvent,
	type SessionSummary,
	type Settings,
	WorkspaceError,
	type WorkspaceRecord,
	type WorkspaceRegistry,
} from "@hotpot/core";
import {
	closeMcpConnections,
	connectMcpServers,
	createInbox,
	createPermissionModeChainHead,
	createPermissionModeDecorator,
	createRuntime,
	foldInbox,
	type Inbox,
	type InboxState,
	type McpClientFactory,
	type McpConnection,
	type OrchestrationRuntime,
	type PlanDecision,
	resolveModel,
	runMainTurn,
	type WorkerToolDecorator,
} from "@hotpot/orchestrator";
import {
	APP_VERSION,
	createTelemetryRuntime,
	sessionEndEvent,
	sessionStartEvent,
	type TelemetryRuntime,
} from "@hotpot/telemetry";
import { type ApprovalBridge, createApprovalBridge } from "./approvals.ts";
import { pickDirectory } from "./directory-picker.ts";
import { createTailer, type Tailer } from "./tailer.ts";
import { summarizeUsage, type UsageSummary } from "./usage.ts";
import {
	createWireHub,
	type WireEvent,
	type WireEventInput,
	type WireHub,
} from "./wire.ts";

// 主agent 的 agentId 固定 "main"：与 orchestrator 包级约定一致
const MAIN_AGENT_ID = "main";

export interface SessionRecord {
	id: string;
	cwd: string;
	filePath: string;
	createdAt: string;
	// 是否有回合正在执行（turn 串行链非空闲）
	running: boolean;
}

// 未知斜杠命令：REST 层转 400（消息不进入回合），CLI 侧有同款文案
export class PromptCommandError extends Error {
	readonly command: string;
	readonly available: string[];
	constructor(command: string, available: string[]) {
		super(
			`unknown prompt template: /${command}. Available: ${available.map((n) => `/${n}`).join(", ")}`,
		);
		this.name = "PromptCommandError";
		this.command = command;
		this.available = available;
	}
}

// M2 REST 4xx 映射：manager 方法对可预期非法输入（上传超限/含 NUL、fs 逃逸等）抛本错误，
// 路由层按 status 转 {error}+状态码；message 即 {error} 文案。
// status 收窄为字面量联合：Hono c.json 只接受具体状态码字面量。
// 500 供工作区存储损坏（invalid-storage）使用
export type SessionApiErrorStatus = 400 | 404 | 409 | 413 | 500;

export class SessionApiError extends Error {
	readonly status: SessionApiErrorStatus;
	constructor(status: SessionApiErrorStatus, message: string) {
		super(message);
		this.name = "SessionApiError";
		this.status = status;
	}
}

// send() 结果：内置指令（/help、/permission）不进模型、不落盘，直接本地应答——
// reply 为客户端渲染文本；普通输入 reply 为 null（消息已挂进 turn 串行链）
export interface SendOutcome {
	reply: string | null;
}

// GET /prompts 列表项：builtin 标记供 web `/` 菜单分区（内置组 + 模板组）
export interface PromptInfo {
	name: string;
	description: string;
	builtin: boolean;
}

// fs/ls 目录项：path 为绝对路径（kind 只有 file|dir，其余文件类型直接跳过）
export interface FsEntry {
	name: string;
	path: string;
	kind: "file" | "dir";
}

// 权限模式合法值（与 core config 的 PERMISSION_MODES 同序；该常量未导出，此处镜像）
const PERMISSION_MODE_VALUES: readonly string[] = [
	"readonly",
	"ask-on-dangerous",
	"full",
];

// M2 上传限制：单文件 ≤512KB、纯文本（无 NUL）、每会话 10 个
const UPLOAD_MAX_BYTES = 512 * 1024;
const UPLOAD_MAX_FILES = 10;
// 草稿态是全局目录（尚未绑定会话），上限放宽到 100 个，防止无限增长
const DRAFT_UPLOAD_MAX_FILES = 100;
const UPLOAD_NAME_MAX = 120;
// fs/ls 单次最多返回的目录项数
const FS_MAX_ENTRIES = 500;

// 上传文件名净化：剥掉路径分隔符（取末段）与 .. 段，trim 后限长；
// 返回空串表示文件名非法（调用方转 400）
function sanitizeUploadName(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? "";
	return base.replaceAll("..", "").trim().slice(0, UPLOAD_NAME_MAX);
}

// 斜杠输入解析：trim 后以 / 开头 → {name, args}；其余（含纯 "/"）返回 null
function parseSlashInput(
	content: string,
): { name: string; args: string } | null {
	const trimmed = content.trim();
	if (!trimmed.startsWith("/")) return null;
	const body = trimmed.slice(1);
	const spIndex = body.search(/\s/);
	if (spIndex === -1) return { name: body, args: "" };
	return {
		name: body.slice(0, spIndex),
		args: body.slice(spIndex + 1).trim(),
	};
}

// /help 应答：列出内置指令，并提示 `/` 同样补全 prompt 模板
const HELP_REPLY = `可用命令：
/help — 显示本帮助
/permission — 查看当前权限模式
/permission <readonly|ask-on-dangerous|full> — 切换权限模式
提示：输入 / 还可以补全 prompt 模板。`;

// M2 内置指令注册表：send() 里先于 prompt template 解析分发；未命中的斜杠输入
// 继续走 resolvePromptMessage（未知 /x 仍抛 PromptCommandError）。run 返回应答文本。
interface BuiltinCommand {
	name: string;
	description: string;
	run(m: ManagedSession, args: string): Promise<string>;
}

export interface SessionManagerOptions {
	home?: string;
	// 测试注入点：默认时按 settings 的 ModelRef 解析真实适配器（orchestrator 的 resolveModel）；
	// 存在时覆盖 runtime.resolveModel（main/worker 共用同一录制适配器），同 chat.ts opts.llm
	llm?: { adapter: LlmAdapter; model: ModelInfo };
	// 未知模型兜底等告警通道；默认静默
	warn?: (text: string) => void;
	// 测试注入点：MCP 连接层打桩（默认走真实 SDK client），配 mcpServers 配置做 attach 用例
	mcpCreateClient?: McpClientFactory;
	// 测试注入点：遥测上报用的 fetch，默认走全局 fetch
	telemetryFetch?: typeof fetch;
	// 测试注入点：系统目录选择器（默认调 directory-picker 的原生实现）
	picker?: () => Promise<string | null>;
}

// 建会话选项：permissionMode 在装配后写入 holder 并落 permission/changed（草稿态
// 里用户选的档位随首条消息一并生效）；autoAttach=false 时跳过按 cwd 自动归属
// （web 要求「未分组」草稿落到未分组，即使默认 cwd 恰好命中某个工作区）
export interface CreateSessionOptions {
	permissionMode?: PermissionMode;
	autoAttach?: boolean;
}

export interface SessionManager {
	create(cwd: string, opts?: CreateSessionOptions): Promise<SessionRecord>;
	// 在工作区内建会话：取注册表记录的 path 作 cwd，创建成功后 attach；
	// 未知 workspaceId 抛 SessionApiError(404)，路径失效抛 400
	createInWorkspace(
		workspaceId: string,
		opts?: Pick<CreateSessionOptions, "permissionMode">,
	): Promise<SessionRecord>;
	// 按会话 id 恢复（listSessions 找 filePath → resumeSession + foldInbox 播种），
	// 未命中返回 null
	attachById(id: string): Promise<SessionRecord | null>;
	get(id: string): SessionRecord | null;
	list(): Promise<(SessionSummary & { running: boolean })[]>;
	// 工作区注册表薄封装：WorkspaceError 统一转 SessionApiError（400/404/409/500）
	listWorkspaces(): Promise<WorkspaceRecord[]>;
	createWorkspace(
		path: string,
	): Promise<{ workspace: WorkspaceRecord; created: boolean }>;
	renameWorkspace(id: string, title: string): Promise<WorkspaceRecord>;
	removeWorkspace(id: string): Promise<void>;
	reorderWorkspaces(ids: string[]): Promise<WorkspaceRecord[]>;
	// 系统原生目录选择器：取消返回 null，不可用/超时抛对应错误
	pickDirectory(): Promise<string | null>;
	// turn 串行：挂到该会话的 turnTail 链尾，前一回合（含 followup 补发）结束后才执行。
	// `/name args` 命中 prompt template 时先展开并落 prompt/invoked；未命中抛 PromptCommandError。
	// 内置指令（/help、/permission）在模板解析前拦截，直接本地应答（SendOutcome.reply 非空），
	// 不进模型、不落盘
	send(id: string, content: string): Promise<SendOutcome>;
	// 当前会话可用的 `/` 菜单项：内置指令（builtin: true）置顶 + prompt templates（builtin: false）
	prompts(id: string): PromptInfo[];
	// steer/queue 两队列的只读快照（GET /inbox；web 队列条展示用）
	inbox(id: string): InboxState;
	// M2 权限模式：GET 读运行时持有者；setPermission 走统一切换路径
	// （持有者 + durable permission/changed + wire 广播），PUT 端点与 /permission 内置指令共用
	permission(id: string): PermissionMode;
	setPermission(id: string, mode: PermissionMode): Promise<void>;
	// M2 队列变更（web 队列条）：steerQueued 把 next-turn 指定消息移入 next-step
	// （仅运行中有意义，REST 层 409 拦截空闲调用）；removeQueued 移除 next-turn 指定消息。
	// 未命中返回 false（REST 层转 404）
	steerQueued(id: string, messageId: string): Promise<boolean>;
	removeQueued(id: string, messageId: string): Promise<boolean>;
	// M2 文本附件上传：写 <home>/uploads/<sessionId>/<counter>-<净化名>（绝不覆盖），
	// 返回绝对路径；NUL/超限/超量抛 SessionApiError（413/400）
	saveUpload(
		id: string,
		name: string,
		content: string,
	): Promise<{ path: string }>;
	// 草稿态附件上传（尚未创建会话）：写 <home>/uploads/drafts/<counter>-<净化名>，
	// 消息里以 @<绝对路径> 引用；会话创建后仍可读
	saveDraftUpload(name: string, content: string): Promise<{ path: string }>;
	// M2 工作区浏览（web @ 补全）：列 cwd 子目录直接子级（dirs 优先、上限 500）；
	// relPath 支持绝对/相对，realpath 后越出 cwd 抛 SessionApiError(400)
	listFs(id: string, relPath: string): Promise<{ entries: FsEntry[] }>;
	steer(id: string, content: string): Promise<void>;
	cancel(id: string): void;
	answerToolApproval(
		id: string,
		requestId: string,
		decision: "allow" | "deny",
	): boolean;
	answerPlan(id: string, decision: PlanDecision): boolean;
	// afterSeq 为 null 全量重放；否则增量补发（窗口外降级全量）。返回退订函数
	subscribe(
		id: string,
		afterSeq: number | null,
		sink: (e: WireEvent) => void,
	): () => void;
	// SSE 断线重连订阅：afterSeq 命中留存窗口则增量补发；为 null 走 buffer 全量；
	// 掉出窗口则 loadSession 全量日志重放——每条 durable 事件经 hub.replay 分配新 seq
	// （与 live 流 seq 连续）后先送达 sink。miss 路径先注册包装 sink 把 live 事件收进
	// pending，重放后按日志事件 id 去重泄洪、再同步换成真 sink：loadSession 期间的
	// live 事件不丢，先历史后 live 的到达序由同步段保证。返回退订函数
	subscribeResuming(
		id: string,
		afterSeq: number | null,
		sink: (e: WireEvent) => void,
	): Promise<() => void>;
	usage(id: string): Promise<UsageSummary>;
	close(id: string): Promise<void>;
	// 删除会话：先按 close 收尾（拒决未决审批/停 tailer/摘 managed/关 MCP），
	// 再删磁盘日志文件；未命中（含纯磁盘会话已不存在）返回 false。
	// 运行中的会话由 REST 层 409 拦截，调用方需保证非运行态
	delete(id: string): Promise<boolean>;
	// 归档会话：结束运行中的回合（abort + 拒决未决审批 + 不再消费队列），
	// 等回合链落定（日志与遥测全部落盘）后按 close 收尾摘托管；
	// 会话保留在磁盘列表中，可随时重新打开。未托管/未知返回 false
	archive(id: string): Promise<boolean>;
}

interface ManagedSession {
	id: string;
	cwd: string;
	filePath: string;
	createdAt: string;
	// 采集器要读会话日志，保留原始 session 句柄（水位包装只影响 append）
	session: Session;
	tier: ModelTier;
	hub: WireHub;
	bridge: ApprovalBridge;
	inbox: Inbox;
	runtime: OrchestrationRuntime;
	tailer: Tailer;
	// M4 Feature⑦ MCP：本会话挂载的 MCP 连接（close 时统一关闭）
	mcpConnections: McpConnection[];
	// M4 Feature⑤ prompt templates：装配时扫描（features.promptTemplates 关闭为空）
	promptTemplates: PromptTemplate[];
	// 功能开关快照（usage 端点报告 enabled 状态）
	features: Settings["features"];
	emit: (input: WireEventInput) => WireEvent;
	syncDurable: () => Promise<void>;
	holder: { currentAbort: AbortController | null; running: boolean };
	// 遥测会话开始时间（create 取会话 createdAt，attach 取挂接时刻）与累计 turn/error 数
	telemetryStartedAt: number;
	telemetryTurns: number;
	telemetryErrors: number;
	// 归档置位：followup 补发循环见到即停（归档不再消费队列里的消息）
	closing: boolean;
	// turn 串行链尾
	turnTail: Promise<void>;
	subscribers: Map<number, (e: WireEvent) => void>;
	nextSubscriberId: number;
}

// ---- append 水位包装：让「转发瞬态前」可以等待 tailer 把已落盘事件推齐 ----
// written = 包装后 append 完成的次数；delivered = tailer 已交付的次数。
// syncDurable() 等 delivered 追平 written——tailer 每批交付后重判等待者，无唤醒丢失。
// markBaseline() 在 tailer 初始补读完成后清零两计数：此后只比较增量，
// attach 场景里存量历史不影响同步判断。

interface AppendWatermark {
	session: Session;
	onDelivered(n: number): void;
	syncDurable(): Promise<void>;
	markBaseline(): void;
}

function wrapAppend(session: Session): AppendWatermark {
	let written = 0;
	let delivered = 0;
	const waiters: (() => void)[] = [];
	const base = session.append.bind(session);
	return {
		session: {
			...session,
			append: async (e: SessionEvent) => {
				await base(e);
				written += 1;
			},
		},
		onDelivered(n: number): void {
			delivered += n;
			if (delivered >= written) {
				while (waiters.length > 0) {
					waiters.shift()?.();
				}
			}
		},
		syncDurable(): Promise<void> {
			if (delivered >= written) return Promise.resolve();
			return new Promise<void>((resolve) => {
				waiters.push(resolve);
			});
		},
		markBaseline(): void {
			written = 0;
			delivered = 0;
		},
	};
}

// permission 恢复（与 attachById 的 foldInbox 播种同址）：按事件顺序对
// permission/changed 做 last-write-wins 折叠，取最后一次切换结果；
// 无记录返回 null（退回 settings 默认）
function foldPermissionMode(events: SessionEvent[]): PermissionMode | null {
	let mode: PermissionMode | null = null;
	for (const e of events) {
		if (e.type === "permission/changed") {
			mode = e.mode;
		}
	}
	return mode;
}

// 权限切换统一路径（PUT /permission 与 /permission 内置指令共用）：
// 改写运行时持有者（与 decorator 共享引用，立即生效）→ 落 permission/changed
// （source: "user"）→ 等 tailer 把 log 推齐后广播瞬态 permission 事件
// （边界同步同 plan 事件：订阅者先收到 durable log、再收到瞬态通知）
async function applyPermissionMode(
	m: ManagedSession,
	mode: PermissionMode,
): Promise<void> {
	m.runtime.permissionMode.mode = mode;
	await m.runtime.session.append({
		type: "permission/changed",
		id: randomUUID(),
		ts: new Date().toISOString(),
		mode,
		source: "user",
	});
	await m.syncDurable();
	m.emit({ kind: "permission", mode });
}

// M2 内置指令：/help 本地应答；/permission 无参报当前档、带参走统一切换路径
const BUILTIN_COMMANDS: BuiltinCommand[] = [
	{
		name: "help",
		description: "显示可用命令帮助",
		run: async () => HELP_REPLY,
	},
	{
		name: "permission",
		description: "查看或切换权限模式（readonly|ask-on-dangerous|full）",
		run: async (m, args) => {
			if (args === "") {
				return `当前权限模式：${m.runtime.permissionMode.mode}`;
			}
			if (!PERMISSION_MODE_VALUES.includes(args)) {
				throw new SessionApiError(
					400,
					`无效权限模式 "${args}"，有效值：${PERMISSION_MODE_VALUES.join(", ")}`,
				);
			}
			const mode = args as PermissionMode;
			await applyPermissionMode(m, mode);
			return `权限模式已切换为：${mode}`;
		},
	},
];

// 内置指令分发：命中注册表返回应答文本；非斜杠输入或未知斜杠返回 null，
// 交回常规解析（未知 /x 仍由 resolvePromptMessage 抛 PromptCommandError）
async function runBuiltin(
	m: ManagedSession,
	content: string,
): Promise<string | null> {
	const parsed = parseSlashInput(content);
	if (parsed === null) return null;
	const cmd = BUILTIN_COMMANDS.find((b) => b.name === parsed.name);
	if (cmd === undefined) return null;
	return cmd.run(m, parsed.args);
}

export function createSessionManager(
	opts: SessionManagerOptions,
): SessionManager {
	const warn = opts.warn ?? (() => {});
	const managed = new Map<string, ManagedSession>();

	// 工作区注册表懒打开：工厂保持同步，首次用到时才读盘（打开失败会被缓存，
	// 每次调用都得到一个 rejected Promise，路由统一转 500）
	let registryPromise: Promise<WorkspaceRegistry> | null = null;
	function openRegistry(): Promise<WorkspaceRegistry> {
		if (registryPromise === null) {
			registryPromise = openWorkspaceRegistry({ home: opts.home });
		}
		return registryPromise;
	}

	// WorkspaceError → SessionApiError：错误码映射到 REST 状态码，message 用中文。
	// 非 WorkspaceError 原样抛回（真实故障交给 onError 500）
	function workspaceApiError(err: unknown): unknown {
		if (!(err instanceof WorkspaceError)) return err;
		switch (err.code) {
			case "invalid-path":
				return new SessionApiError(
					400,
					"工作区路径无效（需为已存在的绝对目录）",
				);
			case "invalid-title":
				return new SessionApiError(400, "工作区标题不能为空");
			case "invalid-order":
				return new SessionApiError(
					400,
					"工作区顺序非法（需包含全部工作区 id 且不重复）",
				);
			case "not-found":
				return new SessionApiError(404, "工作区不存在");
			case "name-conflict":
				return new SessionApiError(409, "工作区标题已被占用");
			case "invalid-storage":
				return new SessionApiError(500, `工作区存储不可用：${err.message}`);
		}
	}

	// 注册表操作统一出口：把 WorkspaceError 转成带状态码的 API 错误
	async function withRegistry<T>(
		fn: (registry: WorkspaceRegistry) => Promise<T>,
	): Promise<T> {
		let registry: WorkspaceRegistry;
		try {
			registry = await openRegistry();
		} catch (err) {
			throw workspaceApiError(err);
		}
		try {
			return await fn(registry);
		} catch (err) {
			throw workspaceApiError(err);
		}
	}

	// cwd 命中已注册工作区时自动归属（CLI/web 会话回到同一侧栏）；
	// 注册表故障不能拖垮建会话，只告警
	async function attachByPathQuiet(
		sessionId: string,
		cwd: string,
	): Promise<void> {
		try {
			const registry = await openRegistry();
			const workspace = registry.findByPath(cwd);
			if (workspace !== null) {
				await registry.attachSession(workspace.id, sessionId);
			}
		} catch (err) {
			warn(
				`工作区自动归属失败（${sessionId}）：${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// 删除会话后清理归属；失败只告警——会话文件已经删掉，不能因此报错
	async function detachQuiet(sessionId: string): Promise<void> {
		try {
			await (await openRegistry()).detachSession(sessionId);
		} catch (err) {
			warn(
				`工作区归属清理失败（${sessionId}）：${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	const picker = opts.picker ?? (() => pickDirectory());

	// M5 遥测旁路：整个 manager 共用一个运行时（未启用或 endpoint 不可用时为 null）。
	// 读配置失败也只退化为 null——遥测问题不能影响服务启动与会话装配
	function loadTelemetryRuntime(): TelemetryRuntime | null {
		try {
			return createTelemetryRuntime(loadSettings({ home: opts.home }), {
				home: opts.home,
				appVersion: APP_VERSION,
				fetchImpl: opts.telemetryFetch,
			});
		} catch {
			return null;
		}
	}
	const telemetry = loadTelemetryRuntime();

	// session_start 在会话进入 managed 后上报；入队失败只丢这条事件，不影响会话
	function emitSessionStart(m: ManagedSession, resumed: boolean): void {
		if (telemetry === null) return;
		try {
			telemetry.client.enqueue(
				sessionStartEvent({
					sessionId: m.id,
					resumed,
					appVersion: APP_VERSION,
					features: m.features,
					os: process.platform,
					nodeVersion: process.version,
				}),
			);
		} catch {
			// 遥测是旁路：任何异常都不向调用方冒泡
		}
	}

	function requireManaged(id: string): ManagedSession {
		const m = managed.get(id);
		if (m === undefined) {
			throw new Error(`会话未管理: ${id}`);
		}
		return m;
	}

	// 装配：hub/桥/审批/runtime/inbox/tailer 闭包到同一会话上；tailer 初始补读后清基线
	async function assemble(init: {
		session: Session;
		cwd: string;
		settings: Settings;
		createdAt: string;
		// 遥测会话起点（毫秒）：create 用 meta.createdAt，attach 用挂接时刻
		startedAt: number;
		inboxSeed?: InboxState;
		// M2 权限恢复：attach 时 fold permission/changed 的最后一次切换结果，
		// 优先于 settings.permission.mode（last-write-wins 已折叠完成）
		permissionSeed?: PermissionMode;
	}): Promise<ManagedSession> {
		const { settings, cwd } = init;
		const tier = settings.mainAgentTier ?? "high";
		const ref = settings.models[tier];
		const hub = createWireHub();
		const holder: { currentAbort: AbortController | null; running: boolean } = {
			currentAbort: null,
			running: false,
		};
		const subscribers = new Map<number, (e: WireEvent) => void>();
		const watermark = wrapAppend(init.session);

		function emitLocal(input: WireEventInput): WireEvent {
			const full = hub.emit(input);
			for (const sink of subscribers.values()) {
				sink(full);
			}
			return full;
		}

		// 桥的广播接到本会话的 emit 管道：ask 入表后同步推送 approval 事件
		const bridge = createApprovalBridge((requestId, payload) => {
			if (payload.approvalType === "tool") {
				emitLocal({
					kind: "approval",
					requestId,
					approvalType: "tool",
					summary: payload.summary,
					detail: payload.detail,
				});
			} else {
				emitLocal({
					kind: "approval",
					requestId,
					approvalType: "plan",
					summary: payload.summary,
					plan: payload.plan,
				});
			}
		});

		// 审批装配镜像 chat.ts：链头挂 createPermissionModeChainHead 动态处理器——
		// 执行时读 holder：full 任何询问直接放行（运行期切换立即生效，永不打断），
		// readonly/ask-on-dangerous 委托桥 handler（parked promise 等 web 应答）。
		// 默认 ask-on-dangerous；holder 与 runtime.permissionMode 共享引用，运行期可被改写（M2）；
		// attach 恢复时 permissionSeed（fold permission/changed）优先于 settings
		const mode: PermissionMode =
			init.permissionSeed ?? settings.permission?.mode ?? "ask-on-dangerous";
		const permissionHolder: { mode: PermissionMode } = { mode };
		const baseApproval = new ApprovalChain();
		baseApproval.use(
			createPermissionModeChainHead(permissionHolder, (req) =>
				bridge.registerToolAsk(req),
			),
		);
		const approval = createAuditedApprovalChain(baseApproval, {
			session: watermark.session,
			agentId: MAIN_AGENT_ID,
		});

		// decorateWorkerTool 总是设置：包装在 execute 时读 holder.mode 动态分派——
		// readonly 给非 read 工具逐个预审批；ask-on-dangerous/full 原样放行（ask-on-dangerous 靠工具
		// 内建危险判定询问，full 靠上面链头的 allowAllHandler 兜底）
		const decorateWorkerTool: WorkerToolDecorator =
			createPermissionModeDecorator(permissionHolder);

		// M4 Feature⑦ MCP：开关（features.mcp，默认开）打开且配置了 server 才连接。
		// 单 server 失败由 connectMcpServers 内部告警跳过，不阻塞装配；连接成功逐个经
		// watermark.session 落盘 mcp/attached（此时 tailer 未 start，初始补读会把它与
		// 历史事件一起交付，markBaseline 清计数，无水位悬挂）。mcpCreateClient 为测试注入缝
		const mcpConnections: McpConnection[] = [];
		if (
			featureEnabled(settings.features, "mcp") &&
			settings.mcpServers !== undefined &&
			Object.keys(settings.mcpServers).length > 0
		) {
			mcpConnections.push(
				...(await connectMcpServers(settings.mcpServers, {
					cwd,
					warn,
					...(opts.mcpCreateClient === undefined
						? {}
						: { createClient: opts.mcpCreateClient }),
				})),
			);
			for (const conn of mcpConnections) {
				await watermark.session.append({
					type: "mcp/attached",
					id: randomUUID(),
					ts: new Date().toISOString(),
					server: conn.name,
					transport: conn.transport,
					tools: conn.tools.map((t) => t.name),
				});
			}
		}

		// M4 Feature④ skill：开关（features.skills，默认开）打开时扫描
		// skillsDirs（相对 cwd 解析）→ <home>/skills → <cwd>/.hotpot/skills
		// （只查 cwd 一级、不向上逐级，已知边界见 orchestrator README）；
		// discoverSkills 同名去重、后扫描者胜：项目级 > home > skillsDirs
		const skills = featureEnabled(settings.features, "skills")
			? await discoverSkills([
					...(settings.skillsDirs ?? []).map((d) => resolve(cwd, d)),
					join(resolveHome(opts.home), "skills"),
					join(cwd, ".hotpot", "skills"),
				])
			: [];

		// M4 Feature⑤ prompt templates：与 skill 同款目录优先级（后扫描覆盖先扫描）
		const promptTemplates = featureEnabled(settings.features, "promptTemplates")
			? await discoverPromptTemplates([
					...(settings.promptsDirs ?? []).map((d) => resolve(cwd, d)),
					join(resolveHome(opts.home), "prompts"),
					join(cwd, ".hotpot", "prompts"),
				])
			: [];

		// M4 Feature③ hooks：开关打开时构造生命周期链（配置只来自用户级 settings）；
		// pre/post tool 由 runTurn 触发，turn_end 由 runMainTurn/runAgentInline 触发，
		// session_start 在 runtime 装配完成后触发一次
		const hooks = featureEnabled(settings.features, "hooks")
			? createHookChain(settings.hooks, {
					session: watermark.session,
					cwd,
					agentId: MAIN_AGENT_ID,
				})
			: undefined;

		const baseRuntime = createRuntime({
			session: watermark.session,
			cwd,
			approval,
			models: settings.models,
			maxParallelTasks: settings.maxParallelTasks,
			planMaxRevisions: settings.planMaxRevisions,
			decorateWorkerTool,
			permissionMode: permissionHolder,
			features: settings.features,
			skills,
			mcpTools: mcpConnections.flatMap((c) => c.tools),
			webSearch: settings.webSearch,
			hooks,
		});
		// opts.llm 覆盖档位解析（main/worker 共用同一录制适配器）；
		// 未注入时仅为主档位解析一次拿兜底告警（runtime 内部每回合自行解析）
		const llm = opts.llm;
		if (!llm) {
			const resolved = resolveModel(ref);
			if (resolved.warning !== undefined) {
				warn(resolved.warning);
			}
		}
		const runtime: OrchestrationRuntime = {
			...baseRuntime,
			...(llm
				? {
						resolveModel: (_t: ModelTier) => ({
							adapter: llm.adapter,
							model: llm.model,
							apiKey: ref.apiKey,
							baseUrl: ref.baseUrl,
						}),
					}
				: {}),
		};

		// 会话级钩子：装配完成后触发一次（attach 到已存在会话同样算一次会话开始）
		await hooks?.run("session_start", {});

		const inbox = createInbox(watermark.session, MAIN_AGENT_ID, {
			onCancel: () => holder.currentAbort?.abort(),
			...(init.inboxSeed === undefined ? {} : { seed: init.inboxSeed }),
		});

		// durable 唯一路径：tailer 每条事件推一条 log；整批交付后推进水位
		const tailer = createTailer(init.session.filePath, {
			fromOffset: 0,
			onEvents: (events) => {
				for (const e of events) {
					emitLocal({ kind: "log", event: e });
				}
				watermark.onDelivered(events.length);
			},
		});

		const m: ManagedSession = {
			id: init.session.id,
			cwd,
			filePath: init.session.filePath,
			createdAt: init.createdAt,
			session: init.session,
			tier,
			hub,
			bridge,
			inbox,
			runtime,
			tailer,
			mcpConnections,
			promptTemplates,
			features: settings.features,
			emit: emitLocal,
			syncDurable: watermark.syncDurable,
			holder,
			telemetryStartedAt: init.startedAt,
			telemetryTurns: 0,
			telemetryErrors: 0,
			closing: false,
			turnTail: Promise.resolve(),
			subscribers,
			nextSubscriberId: 1,
		};
		await tailer.start();
		watermark.markBaseline();
		return m;
	}

	// 单回合：emit turn(start) → 迭代转发瞬态 → 收尾 emit turn(end)。
	// 异常不抛出（吞进 turn(end, {error})）；done 的 stopReason 与 error 事件收敛到回合级 turn(end)
	async function runOneTurn(m: ManagedSession, content: string): Promise<void> {
		m.emit({ kind: "turn", phase: "start" });
		const ac = new AbortController();
		m.holder.currentAbort = ac;
		m.holder.running = true;
		// 遥测：一个用户 turn 一个采集器；start 入队后才开始迭代事件流
		const collector =
			telemetry === null
				? null
				: telemetry.createCollector(m.session, {
						turnId: randomUUID(),
						features: m.features,
					});
		let planRejected = false;
		let stopReason: string | undefined;
		let error: string | undefined;
		try {
			if (telemetry !== null && collector !== null) {
				telemetry.client.enqueue(collector.start());
			}
			for await (const event of runMainTurn({
				runtime: m.runtime,
				userMessage: content,
				signal: ac.signal,
				mainTier: m.tier,
				onPlanApproval: (plan) => m.bridge.registerPlanAsk(plan),
				inbox: m.inbox,
			})) {
				if (event.type === "text") {
					// 边界同步：首个 delta 前把 log(user_msg) 等已落盘事件推齐
					await m.syncDurable();
					m.emit({
						kind: "delta",
						agentId: MAIN_AGENT_ID,
						text: event.delta,
					});
				} else if (event.type === "agent_spawn") {
					// 瞬态 spawn 先行（不做边界同步，保住「worker 诞生早通知」语义）；
					// parentAgentId 固定 main：主流内全部 spawn 都以 main 为父。
					// role 防御性收窄：wire 协议只有 worker/task，编排层也不会产 main 角色
					if (event.role === "worker" || event.role === "task") {
						m.emit({
							kind: "spawn",
							agentId: event.agentId,
							role: event.role,
							tier: event.tier,
							task: event.task,
							parentAgentId: MAIN_AGENT_ID,
						});
					}
				} else if (event.type === "plan") {
					// 计划被用户拒绝属于主动中止，采集器据此判 aborted
					if (event.phase === "denied") {
						planRejected = true;
					}
					// 边界同步：assistant_msg 先于 plan 事件到达，web 才能按 messageIds
					// 隐藏计划正文气泡（否则后到的日志会重新渲染一遍）
					await m.syncDurable();
					m.emit({
						kind: "plan",
						phase: event.phase,
						plan: event.plan,
						messageIds: event.messageIds,
					});
				} else if (event.type === "done") {
					stopReason = event.stopReason;
				} else if (event.type === "error") {
					error = `${event.error.code}: ${event.error.message}`;
				}
				// 遥测采集器观察每一个编排事件（只提取匿名指标，不持有内容）
				collector?.observe(event);
				// tool_call/tool_result/assistant_msg/user_msg 不转发：
				// 它们由 runTurn 落盘、tailer 经 log 路径推送
			}
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			m.holder.currentAbort = null;
			m.holder.running = false;
			// 遥测收尾与 abort 复位在同一 finally：finish 折算本回合明细后入队并立即 flush。
			// 采集/入队失败只丢本回合遥测，绝不向 turn 调用方抛错
			if (telemetry !== null && collector !== null) {
				try {
					const events = await collector.finish({
						aborted: ac.signal.aborted,
						planRejected,
					});
					for (const event of events) {
						telemetry.client.enqueue(event);
					}
					m.telemetryTurns += 1;
					if (
						events.some(
							(event) => event.type === "turn_end" && event.outcome === "error",
						)
					) {
						m.telemetryErrors += 1;
					}
				} catch {
					// 折叠失败只影响遥测，不影响回合结果
				}
				void telemetry.client.flush();
			}
		}
		// 收尾边界同步：log(assistant_msg) 等全部 durable 推齐后再发 turn(end)
		await m.syncDurable();
		m.emit({ kind: "turn", phase: "end", stopReason, error });
	}

	// 一回合 + followup 补发循环（同 CLI：turn 结束后 drain next-turn 逐个补发为新回合）；
	// closing（归档）置位后不再消费队列：归档语义是结束会话，排队消息留给重新打开时处理
	async function runTurnWithFollowups(
		m: ManagedSession,
		content: string,
	): Promise<void> {
		await runOneTurn(m, content);
		let followups: InboxMessage[] = await m.inbox.drainNextTurn();
		while (followups.length > 0 && !m.closing) {
			for (const followup of followups) {
				await runOneTurn(m, followup.content);
			}
			followups = await m.inbox.drainNextTurn();
		}
	}

	function recordOf(m: ManagedSession): SessionRecord {
		return {
			id: m.id,
			cwd: m.cwd,
			filePath: m.filePath,
			createdAt: m.createdAt,
			running: m.holder.running,
		};
	}

	// live 回调注册（subscribe/subscribeResuming 共用）：补发在调用方同步完成后执行，
	// 保证重放事件先于 live 到达同一订阅者
	function registerLive(
		m: ManagedSession,
		sink: (e: WireEvent) => void,
	): () => void {
		const subId = m.nextSubscriberId;
		m.nextSubscriberId += 1;
		m.subscribers.set(subId, sink);
		return () => {
			m.subscribers.delete(subId);
		};
	}

	// M4 Feature⑤：`/name args` → 模板正文。未命中抛 PromptCommandError（REST 转 400）；
	// 非斜杠输入原样返回。展开后立刻落 prompt/invoked（声明 message 级输入意图，
	// 与队列无关——真正的 user_msg 仍由 runMainTurn 在回合开始时落盘）
	async function resolvePromptMessage(
		m: ManagedSession,
		content: string,
	): Promise<string> {
		if (m.promptTemplates.length === 0 || !isSlashInput(content)) {
			return content;
		}
		const matched = resolveSlashCommand(content, m.promptTemplates);
		if (matched === null) {
			const command = content.trim().slice(1).split(/\s+/)[0] ?? "";
			throw new PromptCommandError(
				command,
				m.promptTemplates.map((t) => t.name),
			);
		}
		const expanded = expandTemplate(matched.template, matched.args);
		await m.runtime.session.append({
			type: "prompt/invoked",
			id: randomUUID(),
			ts: new Date().toISOString(),
			agentId: MAIN_AGENT_ID,
			name: matched.template.name,
			args: matched.args.join(" "),
			content: expanded,
		});
		return expanded;
	}

	// 会话销毁收尾（close 与 delete 共用）：未决审批一律拒绝（tool 型 deny；plan 型 reject），
	// 让 parked promise 落盘 decided 并释放等待中的回合链
	async function closeManaged(id: string): Promise<void> {
		const m = requireManaged(id);
		for (const requestId of m.bridge.pending()) {
			if (!m.bridge.answer(requestId, "deny")) {
				m.bridge.answer(requestId, {
					kind: "reject",
					note: "session closed",
				});
			}
		}
		m.tailer.stop();
		// session_end 必须在 managed 摘除前入队：turns/errors 取本会话累计值。
		// flush 不 await：关闭路径不能被网络重试拖住，失败由客户端内部吞掉
		if (telemetry !== null) {
			try {
				telemetry.client.enqueue(
					sessionEndEvent({
						sessionId: m.id,
						startedAt: m.telemetryStartedAt,
						turns: m.telemetryTurns,
						errors: m.telemetryErrors,
					}),
				);
				void telemetry.client.flush();
			} catch {
				// 遥测是旁路：上报失败不影响会话关闭
			}
		}
		// managed 同步摘除保持旧行为（close 不 await 时 get 立即为 null）；
		// MCP 连接关闭是异步收尾，放最后不阻塞摘除
		managed.delete(id);
		await closeMcpConnections(m.mcpConnections);
	}

	// 建会话的统一入口（create 与 createInWorkspace 共用）：装配完成后按 opts.autoAttach
	// （默认 true）决定是否按 cwd 自动归属；permissionMode 在装配后写入 holder 并落审计
	async function createAt(
		cwd: string,
		createOpts?: CreateSessionOptions,
	): Promise<SessionRecord> {
		const settings = loadSettings({ cwd, home: opts.home });
		const session = await createSession(cwd, opts.home);
		const { meta } = await loadSession(session.filePath);
		if (meta.type !== "meta") {
			throw new Error(`会话文件缺 meta 头: ${session.filePath}`);
		}
		// 遥测会话时长从会话创建时间算起；createdAt 不可解析时退回当前时刻
		const createdAtMs = Date.parse(meta.createdAt);
		const m = await assemble({
			session,
			cwd,
			settings,
			createdAt: meta.createdAt,
			startedAt: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
		});
		// 草稿态选的权限档位随会话创建一并生效：先落 durable 审计再对外可见
		if (createOpts?.permissionMode !== undefined) {
			m.runtime.permissionMode.mode = createOpts.permissionMode;
			await m.session.append({
				type: "permission/changed",
				id: randomUUID(),
				ts: new Date().toISOString(),
				mode: createOpts.permissionMode,
				source: "user",
			});
		}
		managed.set(m.id, m);
		emitSessionStart(m, false);
		if (createOpts?.autoAttach !== false) {
			await attachByPathQuiet(m.id, cwd);
		}
		return recordOf(m);
	}

	// 附件落盘共用路径：NUL/大小校验 + 净化文件名 + 计数防覆盖（wx 独占创建）
	async function storeUpload(
		dir: string,
		name: string,
		content: string,
		maxFiles: number,
		overflowMessage: string,
	): Promise<{ path: string }> {
		// 纯文本校验：NUL 字节视为二进制（v1 附件只支持文本）
		if (content.includes("\0")) {
			throw new SessionApiError(
				400,
				"仅支持纯文本附件（内容含 NUL 字节，疑似二进制文件）",
			);
		}
		if (new TextEncoder().encode(content).length > UPLOAD_MAX_BYTES) {
			throw new SessionApiError(
				413,
				"附件内容超过 512KB 上限（v1 仅支持纯文本）",
			);
		}
		const sanitized = sanitizeUploadName(name);
		if (sanitized === "") {
			throw new SessionApiError(400, "文件名非法（净化后为空）");
		}
		await mkdir(dir, { recursive: true });
		// 计数取磁盘现状：重启后不与既有文件冲突；达到上限拒绝（413）
		const existing = await readdir(dir);
		if (existing.length >= maxFiles) {
			throw new SessionApiError(413, overflowMessage);
		}
		const filePath = join(dir, `${existing.length + 1}-${sanitized}`);
		// wx 独占创建：counter 递增已保证唯一，写时再加旗标兜底绝不覆盖
		await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
		return { path: filePath };
	}

	return {
		create: createAt,

		async createInWorkspace(
			workspaceId: string,
			workspaceOpts?: { permissionMode?: PermissionMode },
		): Promise<SessionRecord> {
			const workspace = await withRegistry((r) =>
				Promise.resolve(r.list().find((w) => w.id === workspaceId)),
			);
			if (workspace === undefined) {
				throw new SessionApiError(404, "工作区不存在");
			}
			// 注册后目录可能被删除/替换：沿用 cwd 的同一套校验与中文报错
			try {
				if (!(await stat(workspace.path)).isDirectory()) {
					throw new SessionApiError(400, `cwd 不是目录: ${workspace.path}`);
				}
			} catch (err) {
				if (err instanceof SessionApiError) throw err;
				throw new SessionApiError(400, `cwd 不存在: ${workspace.path}`);
			}
			const rec = await createAt(workspace.path, {
				...(workspaceOpts?.permissionMode === undefined
					? {}
					: { permissionMode: workspaceOpts.permissionMode }),
			});
			// createAt 已按 realpath 自动归属；这里再显式挂一次保证契约（幂等，无写盘）
			await withRegistry((r) => r.attachSession(workspace.id, rec.id));
			return rec;
		},

		async attachById(id: string): Promise<SessionRecord | null> {
			const summaries = await listSessions(opts.home);
			const summary = summaries.find((s) => s.id === id);
			if (summary === undefined) return null;
			const { meta, events } = await loadSession(summary.filePath);
			if (meta.type !== "meta") return null;
			const session = await resumeSession(summary.filePath);
			const settings = loadSettings({ cwd: meta.cwd, home: opts.home });
			// 恢复的会话从挂接时刻算起：用旧 createdAt 会把离线时长计入 durationMs
			const m = await assemble({
				session,
				cwd: meta.cwd,
				settings,
				createdAt: meta.createdAt,
				startedAt: Date.now(),
				inboxSeed: foldInbox(events),
				permissionSeed: foldPermissionMode(events) ?? undefined,
			});
			managed.set(m.id, m);
			emitSessionStart(m, true);
			return recordOf(m);
		},

		get(id: string): SessionRecord | null {
			const m = managed.get(id);
			return m === undefined ? null : recordOf(m);
		},

		async list(): Promise<(SessionSummary & { running: boolean })[]> {
			const summaries = await listSessions(opts.home);
			return summaries.map((s) => {
				const m = managed.get(s.id);
				return { ...s, running: m ? m.holder.running : false };
			});
		},

		async listWorkspaces(): Promise<WorkspaceRecord[]> {
			return withRegistry((r) => Promise.resolve(r.list()));
		},

		async createWorkspace(
			path: string,
		): Promise<{ workspace: WorkspaceRecord; created: boolean }> {
			return withRegistry((r) => r.create(path));
		},

		async renameWorkspace(id: string, title: string): Promise<WorkspaceRecord> {
			return withRegistry((r) => r.rename(id, title));
		},

		async removeWorkspace(id: string): Promise<void> {
			return withRegistry((r) => r.remove(id));
		},

		async reorderWorkspaces(ids: string[]): Promise<WorkspaceRecord[]> {
			return withRegistry((r) => r.reorder(ids));
		},

		pickDirectory(): Promise<string | null> {
			return picker();
		},

		async send(id: string, content: string): Promise<SendOutcome> {
			const m = requireManaged(id);
			// 内置指令（/help、/permission）先于 prompt template 解析：直接本地应答，
			// 不进模型、不落盘（/permission 带参走统一切换路径，会落 permission/changed）
			const builtinReply = await runBuiltin(m, content);
			if (builtinReply !== null) {
				return { reply: builtinReply };
			}
			const message = await resolvePromptMessage(m, content);
			// 运行中发送 = 排队（next-turn）：落 durable inbox/spliced，web QueueBar 立即展示；
			// 点击条目可转 steer（M2 端点），当前回合的 followup 补发循环在回合结束后消费。
			// 与旧实现（直接串到 turnTail）的区别：排队消息有队列可见性、可 steer/移除
			if (m.holder.running) {
				await m.inbox.followup(message);
				// 兜底：入队瞬间当前回合恰好走完最后一次 drain（消息将无人消费）——
				// 挂一个尾任务，回合空闲时再拉一次；若已被补发循环消费，这里为空操作
				const drainIfIdle = async (): Promise<void> => {
					if (m.closing || m.holder.running) return;
					const queued = await m.inbox.drainNextTurn();
					for (const q of queued) {
						await runTurnWithFollowups(m, q.content);
					}
				};
				m.turnTail = m.turnTail.then(drainIfIdle, drainIfIdle);
			} else {
				const run = () => runTurnWithFollowups(m, message);
				// turn 串行链：挂到链尾；链断（前序异常）也不跳过本回合（runOneTurn 自身不抛）
				m.turnTail = m.turnTail.then(run, run);
			}
			return { reply: null };
		},

		prompts(id: string): PromptInfo[] {
			const m = requireManaged(id);
			// 内置指令置顶 + prompt templates，builtin 标记供 web `/` 菜单分区
			return [
				...BUILTIN_COMMANDS.map((b) => ({
					name: b.name,
					description: b.description,
					builtin: true,
				})),
				...m.promptTemplates.map((t) => ({
					name: t.name,
					description: t.description,
					builtin: false,
				})),
			];
		},

		inbox(id: string): InboxState {
			return requireManaged(id).inbox.snapshot();
		},

		permission(id: string): PermissionMode {
			return requireManaged(id).runtime.permissionMode.mode;
		},

		async setPermission(id: string, mode: PermissionMode): Promise<void> {
			await applyPermissionMode(requireManaged(id), mode);
		},

		async steerQueued(id: string, messageId: string): Promise<boolean> {
			return requireManaged(id).inbox.steerQueued(messageId);
		},

		async removeQueued(id: string, messageId: string): Promise<boolean> {
			return requireManaged(id).inbox.removeNextTurn(messageId);
		},

		async saveUpload(
			id: string,
			name: string,
			content: string,
		): Promise<{ path: string }> {
			const m = requireManaged(id);
			const dir = join(resolveHome(opts.home), "uploads", m.id);
			return storeUpload(
				dir,
				name,
				content,
				UPLOAD_MAX_FILES,
				"本会话上传文件数已达上限（10 个）",
			);
		},

		async saveDraftUpload(
			name: string,
			content: string,
		): Promise<{ path: string }> {
			// 草稿目录是全局的（还没有会话 id）；会话创建后消息里的绝对路径仍可读
			const dir = join(resolveHome(opts.home), "uploads", "drafts");
			return storeUpload(
				dir,
				name,
				content,
				DRAFT_UPLOAD_MAX_FILES,
				"草稿附件数已达上限（100 个）",
			);
		},

		async listFs(id: string, relPath: string): Promise<{ entries: FsEntry[] }> {
			const m = requireManaged(id);
			const realCwd = await realpath(m.cwd);
			let realTarget: string;
			try {
				// relPath 为 "" 时 resolve 回 cwd 自身；绝对路径原样采用（@ 补全语义），
				// 逃逸与否由下方 startsWith 校验裁定
				realTarget = await realpath(resolve(m.cwd, relPath));
			} catch {
				throw new SessionApiError(400, `path 不存在或不可访问: ${relPath}`);
			}
			// 逃逸校验：realTarget 必须等于 cwd 或位于其下（前缀带尾部分隔符，
			// 防 /foo/bar 误命中 /foo/bar2；cwd 为根目录时前缀即根，天然放行）
			const prefix = realCwd.endsWith(sep) ? realCwd : `${realCwd}${sep}`;
			if (realTarget !== realCwd && !realTarget.startsWith(prefix)) {
				throw new SessionApiError(400, "path 越出会话工作目录");
			}
			const dirents = await readdir(realTarget, { withFileTypes: true });
			const entries: FsEntry[] = [];
			for (const d of dirents) {
				// 跳过隐藏项与 node_modules（.git 属隐藏项已覆盖）
				if (d.name.startsWith(".") || d.name === "node_modules") continue;
				const kind = d.isDirectory() ? "dir" : d.isFile() ? "file" : null;
				if (kind === null) continue;
				entries.push({ name: d.name, path: join(realTarget, d.name), kind });
				if (entries.length >= FS_MAX_ENTRIES) break;
			}
			// dirs 优先，同档按名字典序
			entries.sort((a, b) =>
				a.kind === b.kind
					? a.name < b.name
						? -1
						: a.name > b.name
							? 1
							: 0
					: a.kind === "dir"
						? -1
						: 1,
			);
			return { entries };
		},

		async steer(id: string, content: string): Promise<void> {
			const m = requireManaged(id);
			await m.inbox.steer(content);
		},

		cancel(id: string): void {
			const m = requireManaged(id);
			m.inbox.cancel();
		},

		answerToolApproval(
			id: string,
			requestId: string,
			decision: "allow" | "deny",
		): boolean {
			const m = managed.get(id);
			if (m === undefined) return false;
			return m.bridge.answer(requestId, decision);
		},

		answerPlan(id: string, decision: PlanDecision): boolean {
			const m = managed.get(id);
			if (m === undefined) return false;
			return m.bridge.answerPendingPlan(decision);
		},

		subscribe(
			id: string,
			afterSeq: number | null,
			sink: (e: WireEvent) => void,
		): () => void {
			const m = requireManaged(id);
			// 补发：afterSeq 为 null 全量重放；增量窗口外（tailAfter 返回 null）降级全量
			const catchUp =
				afterSeq === null
					? m.hub.buffer()
					: (m.hub.tailAfter(afterSeq) ?? m.hub.buffer());
			for (const e of catchUp) {
				sink(e);
			}
			return registerLive(m, sink);
		},

		async subscribeResuming(
			id: string,
			afterSeq: number | null,
			sink: (e: WireEvent) => void,
		): Promise<() => void> {
			const m = requireManaged(id);
			if (afterSeq === null) {
				const catchUp = m.hub.buffer();
				for (const e of catchUp) {
					sink(e);
				}
				return registerLive(m, sink);
			}
			// 命中留存窗口：增量补发（同步段，注册前无 await）
			if (m.hub.hasSeq(afterSeq)) {
				const incremental = m.hub.tailAfter(afterSeq);
				if (incremental !== null) {
					for (const e of incremental) {
						sink(e);
					}
					return registerLive(m, sink);
				}
			}
			// 掉出窗口：全量日志重放。为堵住 loadSession 期间的 live 窗口，先注册包装
			// sink 把 live 事件收进 pending（同步注册，先于任何 await），重放完成后
			// 再把 pending 泄洪并同步换成真 sink——泄洪与换 sink 在同一同步段完成，
			// 任何 emit 要么已进 pending、要么直送 sink，事件不会落在缝隙里
			const pending: WireEvent[] = [];
			const subId = m.nextSubscriberId;
			m.nextSubscriberId += 1;
			m.subscribers.set(subId, (e) => {
				pending.push(e);
			});
			let logEvents: SessionEvent[];
			try {
				const loaded = await loadSession(m.filePath);
				logEvents = loaded.events;
			} catch (err) {
				m.subscribers.delete(subId);
				throw err;
			}
			// 重放：durable 事件经 hub.replay 借 emit 管道分配新 seq（seq 与 live 流
			// 连续、单调；hub.replay 不入公共 buffer、不广播，其他订阅者不受影响）
			const replayedIds = new Set<string>();
			let sawMeta = false;
			for (const e of logEvents) {
				if (e.type === "meta") sawMeta = true;
				else replayedIds.add(e.id);
				sink(m.hub.replay({ kind: "log", event: e }));
			}
			// 泄洪 pending：重放已覆盖的 durable 事件按日志事件 id 去重（tailer 与本
			// 连接重放读到同一批历史时只留一份）；瞬态事件不在日志中，一律补发
			for (const e of pending) {
				if (e.kind === "log") {
					if (e.event.type === "meta") {
						if (sawMeta) continue;
					} else if (replayedIds.has(e.event.id)) {
						continue;
					}
				}
				sink(e);
			}
			m.subscribers.set(subId, sink);
			return () => {
				m.subscribers.delete(subId);
			};
		},

		async usage(id: string): Promise<UsageSummary> {
			const m = requireManaged(id);
			const { events } = await loadSession(m.filePath);
			return summarizeUsage(events, m.features);
		},

		close: closeManaged,

		async archive(id: string): Promise<boolean> {
			const m = managed.get(id);
			if (m === undefined) return false;
			m.closing = true;
			// 先拒决未决审批：parked promise 不释放，回合永远走不到收尾，
			// turnTail 将一直挂起（closeManaged 里的同款拒决因此成为 no-op，语义不变）
			for (const requestId of m.bridge.pending()) {
				if (!m.bridge.answer(requestId, "deny")) {
					m.bridge.answer(requestId, {
						kind: "reject",
						note: "session archived",
					});
				}
			}
			// abort 当前回合，随后等回合链落定：turn(end) 已发、遥测已入队并 flush、
			// 日志 append 全部落盘——这是「所有内容落盘」的时点
			m.inbox.cancel();
			await m.turnTail;
			await closeManaged(id);
			return true;
		},

		async delete(id: string): Promise<boolean> {
			const m = managed.get(id);
			if (m !== undefined) {
				// 托管会话：按 close 收尾（审批/尾随/遥测/MCP 全关停）后删磁盘日志
				await closeManaged(id);
				await rm(m.filePath, { force: true });
				await detachQuiet(id);
				return true;
			}
			// 纯磁盘会话（未托管）：定位日志文件直接删除
			const summaries = await listSessions(opts.home);
			const summary = summaries.find((s) => s.id === id);
			if (summary === undefined) return false;
			await rm(summary.filePath, { force: true });
			await detachQuiet(id);
			return true;
		},
	};
}
