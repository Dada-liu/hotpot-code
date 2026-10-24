// 根组件：三栏布局（会话列表 | 对话 | agent 面板）与全局状态。
// 全局状态 = useReducer(reduceChatAction) 折叠 WireEvent 流；切换会话时重置并重建 SSE 连接。
// 顶栏：会话目录名 + 重连指示 + 面板开关（仅 worker 运行期间可见）。
// agent 面板随 worker 运行自动展示、全部完成即消失，无空态。

import { PanelRight } from "lucide-react";
import { useCallback, useEffect, useReducer, useState } from "react";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
	answerApproval,
	answerPlan,
	archiveSession,
	cancelTurn,
	createSession,
	deleteSession,
	deleteWorkspace,
	getInbox,
	getPermission,
	listPrompts,
	listSessions,
	listWorkspaces,
	type PromptInfo,
	removeQueued,
	renameWorkspace,
	reorderWorkspaces,
	type SessionSummary,
	sendMessage,
	setPermission,
	steerQueued,
	type WorkspaceWire,
} from "./api.ts";
import { AgentPanel } from "./components/AgentPanel.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { SessionList } from "./components/SessionList.tsx";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { WorkspacePickerDialog } from "./components/WorkspacePickerDialog.tsx";
import { type ConnectionState, connect } from "./events.ts";
import { sessionNameFromPrompt } from "./lib/session-name.ts";
import { workspaceForSession } from "./lib/workspaces.ts";
import { createInitialState, reduceChatAction } from "./state/reducer.ts";

// 会话 id → 首轮提示词提取的显示名，持久化到 localStorage（服务端 SessionSummary 无 name 字段）
const SESSION_NAMES_KEY = "hotpot.sessionNames";

function loadSessionNames(): Record<string, string> {
	try {
		const raw = localStorage.getItem(SESSION_NAMES_KEY);
		if (raw === null) {
			return {};
		}
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) {
			return {};
		}
		return Object.fromEntries(
			Object.entries(parsed as Record<string, unknown>).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string",
			),
		);
	} catch {
		return {};
	}
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

export function App() {
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	// 工作区注册表：数组顺序即侧栏展示顺序
	const [workspaces, setWorkspaces] = useState<WorkspaceWire[]>([]);
	const [currentId, setCurrentId] = useState<string | null>(null);
	// 点“新建会话”后进入待创建态：不立刻建会话，首条消息发送时才创建
	const [pending, setPending] = useState(false);
	// 待创建会话绑定的工作区（null = 服务端默认 cwd，落未分组）
	const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(
		null,
	);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [names, setNames] = useState<Record<string, string>>(loadSessionNames);
	const [chat, dispatch] = useReducer(
		reduceChatAction,
		undefined,
		createInitialState,
	);
	const [connState, setConnState] = useState<ConnectionState | "idle">("idle");
	const [error, setError] = useState<string | null>(null);
	// 内置指令（/help、/permission）的本地回复气泡：不落盘，会话切换清空
	const [notices, setNotices] = useState<string[]>([]);
	// 首条消息创建会话失败（如 cwd 400）：composer 上方红字
	const [createError, setCreateError] = useState<string | null>(null);
	// 权限切换在途：选择器禁用，防重复提交
	const [permissionBusy, setPermissionBusy] = useState(false);
	// 队列行操作在途：steer/移除单飞
	const [queueBusy, setQueueBusy] = useState(false);
	// 审批应答提交中：单飞锁 + 审批条按钮 loading，防重复点击产生二次应答 404
	const [approvalBusy, setApprovalBusy] = useState(false);
	// M4 Feature⑤：当前会话可用的 prompt templates（`/` 补全）
	const [prompts, setPrompts] = useState<PromptInfo[]>([]);
	// 面板收起是本地偏好：worker 运行期间可用顶栏开关展开/收起
	const [panelCollapsed, setPanelCollapsed] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);

	const refreshSessions = useCallback(async () => {
		try {
			setSessions(await listSessions());
		} catch (e) {
			setError(errorMessage(e));
		}
	}, []);

	const refreshWorkspaces = useCallback(async () => {
		try {
			setWorkspaces(await listWorkspaces());
		} catch (e) {
			setError(errorMessage(e));
		}
	}, []);

	// 队列快照：消费（drain/poll）不落事件，回合结束/发送 steer 后拉一次快照修正展示
	const refreshInbox = useCallback(async (id: string) => {
		try {
			dispatch({ type: "inbox", snapshot: await getInbox(id) });
		} catch {
			// 快照失败不影响对话；下次触发再试
		}
	}, []);

	useEffect(() => {
		void refreshSessions();
		void refreshWorkspaces();
	}, [refreshSessions, refreshWorkspaces]);

	// 选中会话即连接 SSE；切换/卸载时关闭旧连接（effect cleanup）。
	// connEpoch 供「同一会话强制重建连接」（归档当前会话后服务端已摘托管，需重连恢复）
	const [connEpoch, setConnEpoch] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: connEpoch 是强制重建连接的计数信号，刻意不读具体值
	useEffect(() => {
		// 切换会话/回欢迎态：本地 notice 与创建错误不跨会话
		setNotices([]);
		setCreateError(null);
		if (currentId === null) {
			setConnState("idle");
			setPrompts([]);
			return;
		}
		// 拉取 `/` 补全用的模板清单；失败不阻塞对话（补全为空即可）
		void listPrompts(currentId)
			.then(setPrompts)
			.catch(() => {
				setPrompts([]);
			});
		// 权限档位以服务端为权威（重启后 fold permission/changed 恢复最后选择）
		void getPermission(currentId)
			.then((mode) => {
				dispatch({ type: "permission", mode });
			})
			.catch(() => {
				// 拉取失败保持默认 workspace；wire permission 事件仍可校正
			});
		// 队列初始快照（web 重连/切换会话后恢复展示）
		void refreshInbox(currentId);
		const conn = connect(
			currentId,
			(event) => {
				dispatch({ type: "event", event });
			},
			(state) => {
				setConnState(state);
			},
		);
		return () => {
			conn.close();
		};
	}, [currentId, connEpoch, refreshInbox]);

	// 回合结束（含 abort/失败）后刷新队列快照：step 边界消费不落事件，
	// 只有快照能清掉已消费的队列条；运行中的 steer/inject 变更由 inbox/spliced 折叠
	useEffect(() => {
		if (currentId !== null && chat.turn === "idle") {
			void refreshInbox(currentId);
		}
	}, [currentId, chat.turn, refreshInbox]);

	// 进入待创建欢迎态：绑定目标工作区，首条消息发送时才真正建会话
	const enterPending = (workspaceId: string | null): void => {
		setPendingWorkspaceId(workspaceId);
		setCurrentId(null);
		setPending(true);
		setNotices([]);
		setCreateError(null);
		dispatch({ type: "reset" });
		setError(null);
	};

	// 全局「新建会话」：当前会话所属工作区 → 第一个工作区 → 没有工作区则先添加
	const handleCreateGlobal = (): void => {
		const currentWorkspace =
			currentId === null ? null : workspaceForSession(workspaces, currentId);
		const target = currentWorkspace ?? workspaces[0] ?? null;
		if (target === null) {
			setPickerOpen(true);
			return;
		}
		enterPending(target.id);
	};

	const handleNewSessionIn = (workspaceId: string): void => {
		enterPending(workspaceId);
	};

	// 选择器创建成功：刷新注册表并让待建会话绑定到该工作区（可能是既有记录）
	const handleWorkspaceCreated = (workspace: WorkspaceWire): void => {
		setPickerOpen(false);
		void refreshWorkspaces();
		enterPending(workspace.id);
	};

	// 重命名失败向上抛，由侧栏弹窗展示服务端 message
	const handleRenameWorkspace = async (
		id: string,
		title: string,
	): Promise<void> => {
		await renameWorkspace(id, title);
		await refreshWorkspaces();
	};

	// 删除只注销注册：当前会话不重置对话，刷新后自然落入「未分组」
	const handleDeleteWorkspace = async (id: string): Promise<void> => {
		await deleteWorkspace(id);
		setPendingWorkspaceId((prev) => (prev === id ? null : prev));
		await Promise.all([refreshSessions(), refreshWorkspaces()]);
	};

	// 拖拽排序：先本地乐观更新，失败回滚（重新拉取）并上抛
	const handleReorderWorkspaces = async (ids: string[]): Promise<void> => {
		const previous = workspaces;
		const byId = new Map(previous.map((w) => [w.id, w]));
		const optimistic = ids
			.map((id) => byId.get(id))
			.filter((w): w is WorkspaceWire => w !== undefined);
		if (optimistic.length === previous.length) {
			setWorkspaces(optimistic);
		}
		try {
			setWorkspaces(await reorderWorkspaces(ids));
			setError(null);
		} catch (e) {
			setError(errorMessage(e));
			await refreshWorkspaces();
			throw e;
		}
	};

	const handleSelect = (id: string): void => {
		if (id === currentId) {
			return;
		}
		setError(null);
		setPending(false);
		setPendingWorkspaceId(null);
		setCurrentId(id);
		dispatch({ type: "reset" });
	};

	// 归档会话：结束运行中的回合并全部落盘，服务端摘托管（日志保留，可重新打开）。
	// 归档的是当前会话：旧 SSE 订阅随托管摘除而失效，重置状态并重建连接（从磁盘恢复）
	const handleArchive = async (id: string): Promise<void> => {
		try {
			await archiveSession(id);
			if (id === currentId) {
				dispatch({ type: "reset" });
				setConnEpoch((e) => e + 1);
			}
			await refreshSessions();
			setError(null);
		} catch (e) {
			setError(errorMessage(e));
		}
	};

	// 删除会话：服务端删日志文件；本地显示名同步清理；删的是当前会话则回欢迎态
	const handleDelete = async (id: string): Promise<void> => {
		try {
			await deleteSession(id);
			setNames((prev) => {
				const next = { ...prev };
				delete next[id];
				localStorage.setItem(SESSION_NAMES_KEY, JSON.stringify(next));
				return next;
			});
			if (id === currentId) {
				setCurrentId(null);
				setPending(false);
				setPendingWorkspaceId(null);
				dispatch({ type: "reset" });
			}
			await refreshSessions();
			// 服务端删除会话后已从工作区 detach
			void refreshWorkspaces();
			setError(null);
		} catch (e) {
			setError(errorMessage(e));
		}
	};

	// 空闲发送 = 新 turn；运行中发送 = 排队（next-turn，服务端写 inbox/spliced，
	// QueueBar 立即展示；点击队列条目才转 steer）。内置指令命中返回 200 {reply}，
	// 只追加本地 notice 气泡，不进入回合
	const handleSend = async (content: string): Promise<void> => {
		try {
			// 待创建态：首条消息先到——绑定待选工作区（无则服务端默认 cwd）创建会话、
			// 以提示词命名、加入列表并连接
			if (currentId === null) {
				let id: string;
				try {
					id = await createSession(
						pendingWorkspaceId === null
							? undefined
							: { workspaceId: pendingWorkspaceId },
					);
				} catch (e) {
					// 工作区已删除（404）、cwd 校验失败（400）等：停在欢迎态，红字提示
					setCreateError(errorMessage(e));
					return;
				}
				setNames((prev) => {
					const next = { ...prev, [id]: sessionNameFromPrompt(content) };
					localStorage.setItem(SESSION_NAMES_KEY, JSON.stringify(next));
					return next;
				});
				setCurrentId(id);
				setPending(false);
				setPendingWorkspaceId(null);
				setCreateError(null);
				// 归属关系随创建变化，两个列表一起刷新
				await Promise.all([refreshSessions(), refreshWorkspaces()]);
				const result = await sendMessage(id, content);
				if (result.reply != null) {
					setNotices((n) => [...n, result.reply as string]);
				} else {
					setSessions((ss) =>
						ss.map((s) =>
							s.id === id ? { ...s, turn: "running" as const } : s,
						),
					);
				}
				setError(null);
				return;
			}
			const result = await sendMessage(currentId, content);
			if (result.reply != null) {
				setNotices((n) => [...n, result.reply as string]);
			} else if (chat.turn === "running") {
				// 已排队：inbox/spliced 随 SSE 到达，快照刷新兜底修正
				void refreshInbox(currentId);
			} else {
				setSessions((ss) =>
					ss.map((s) =>
						s.id === currentId ? { ...s, turn: "running" as const } : s,
					),
				);
			}
			setError(null);
		} catch (e) {
			setError(errorMessage(e));
		}
	};

	// 权限档位切换：乐观写入 + 服务端权威校正（wire permission 事件覆写）；失败回填
	const handlePermissionChange = async (
		mode: "readonly" | "workspace" | "full",
	): Promise<void> => {
		if (currentId === null || permissionBusy) {
			return;
		}
		const previous = chat.permissionMode;
		if (previous === mode) {
			return;
		}
		dispatch({ type: "permission", mode });
		setPermissionBusy(true);
		try {
			await setPermission(currentId, mode);
			setError(null);
		} catch (e) {
			dispatch({ type: "permission", mode: previous });
			setError(errorMessage(e));
		} finally {
			setPermissionBusy(false);
		}
	};

	// 排队条目点击转 steer：仅运行中可用（服务端 409 时保留条目并提示）
	const handleSteerQueued = async (messageId: string): Promise<void> => {
		if (currentId === null || queueBusy) {
			return;
		}
		setQueueBusy(true);
		try {
			await steerQueued(currentId, messageId);
			await refreshInbox(currentId);
			setError(null);
		} catch (e) {
			setError(errorMessage(e));
		} finally {
			setQueueBusy(false);
		}
	};

	const handleRemoveQueued = async (messageId: string): Promise<void> => {
		if (currentId === null || queueBusy) {
			return;
		}
		setQueueBusy(true);
		try {
			await removeQueued(currentId, messageId);
			await refreshInbox(currentId);
			setError(null);
		} catch (e) {
			setError(errorMessage(e));
		} finally {
			setQueueBusy(false);
		}
	};

	const handleCancel = async (): Promise<void> => {
		if (currentId === null) {
			return;
		}
		try {
			await cancelTurn(currentId);
			setSessions((ss) =>
				ss.map((s) =>
					s.id === currentId ? { ...s, turn: "idle" as const } : s,
				),
			);
		} catch (e) {
			setError(errorMessage(e));
		}
	};

	const handleApproval = async (decision: "allow" | "deny"): Promise<void> => {
		// 单飞锁：提交期间忽略重复点击（重复应答会被服务端判 404 未知 requestId）
		if (currentId === null || chat.pendingApproval === null || approvalBusy) {
			return;
		}
		const requestId = chat.pendingApproval.requestId;
		setApprovalBusy(true);
		try {
			await answerApproval(currentId, requestId, decision);
			// 乐观收敛：不等 SSE 的 decided 日志，立即关闭审批框并回填决定
			dispatch({
				type: "approval-answered",
				requestId,
				decision: decision === "allow" ? "approved" : "denied",
			});
			setError(null);
		} catch (e) {
			setError(errorMessage(e));
		} finally {
			setApprovalBusy(false);
		}
	};

	const handlePlanDecision = async (
		decision: "approve" | "reject" | "annotate",
		note?: string,
	): Promise<void> => {
		if (currentId === null) {
			return;
		}
		try {
			await answerPlan(currentId, decision, note);
			setError(null);
		} catch (e) {
			setError(errorMessage(e));
		}
	};

	const current = sessions.find((s) => s.id === currentId) ?? null;
	const currentName = current ? (names[current.id] ?? current.cwd) : "";
	// 待建会话绑定工作区：顶栏显示标题作为提示，title 展示完整路径
	const pendingWorkspace =
		pendingWorkspaceId === null
			? null
			: (workspaces.find((w) => w.id === pendingWorkspaceId) ?? null);
	// 右侧面板开关只在 work agent 运行期间展示
	const workerRunning = chat.agents.some(
		(a) => a.role === "worker" && a.status === "running",
	);

	return (
		<TooltipProvider>
			<div className="flex h-screen overflow-hidden">
				<SessionList
					workspaces={workspaces}
					sessions={sessions}
					currentId={currentId}
					pendingWorkspaceId={pendingWorkspaceId}
					nameFor={(s) => names[s.id] ?? s.cwd}
					onSelect={handleSelect}
					onNewSessionIn={handleNewSessionIn}
					onNewSessionGlobal={handleCreateGlobal}
					onAddWorkspace={() => {
						setPickerOpen(true);
					}}
					onRenameWorkspace={handleRenameWorkspace}
					onDeleteWorkspace={handleDeleteWorkspace}
					onReorderWorkspaces={handleReorderWorkspaces}
					onDelete={(id) => {
						void handleDelete(id);
					}}
					onArchive={(id) => {
						void handleArchive(id);
					}}
					onOpenSettings={() => {
						setSettingsOpen(true);
					}}
				/>
				<SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
				<WorkspacePickerDialog
					open={pickerOpen}
					onOpenChange={setPickerOpen}
					onCreated={handleWorkspaceCreated}
				/>
				<div className="flex min-w-0 flex-1 flex-col">
					<header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
						<span
							className="min-w-0 flex-1 truncate text-sm text-muted-foreground"
							title={current?.cwd ?? pendingWorkspace?.path ?? undefined}
						>
							{current
								? currentName
								: pending
									? pendingWorkspace === null
										? "新会话"
										: `新会话 · ${pendingWorkspace.title}`
									: "hotpot-agent"}
						</span>
						<span
							className={cn(
								"flex items-center gap-1.5 text-xs text-brand",
								connState !== "reconnecting" && "hidden",
							)}
						>
							<span className="size-1.5 animate-pulse rounded-full bg-brand" />
							重连中
						</span>
						<Button
							variant="ghost"
							size="icon"
							className={cn("size-8", !workerRunning && "hidden")}
							onClick={() => {
								setPanelCollapsed((v) => !v);
							}}
							aria-label="切换右侧面板"
						>
							<PanelRight className="size-4" />
						</Button>
					</header>
					{error !== null && (
						<div className="bg-destructive/10 px-4 py-1.5 text-center text-xs text-destructive">
							{error}
						</div>
					)}
					<ChatView
						state={chat}
						hasSession={currentId !== null}
						welcome={currentId === null}
						prompts={prompts}
						notices={notices}
						createError={createError}
						sessionId={currentId}
						permissionMode={chat.permissionMode}
						permissionBusy={permissionBusy}
						onPermissionChange={(mode) => {
							void handlePermissionChange(mode);
						}}
						queueBusy={queueBusy}
						onSteerQueued={(messageId) => {
							void handleSteerQueued(messageId);
						}}
						onRemoveQueued={(messageId) => {
							void handleRemoveQueued(messageId);
						}}
						onSend={(content) => {
							void handleSend(content);
						}}
						onCancel={() => {
							void handleCancel();
						}}
						onApproval={(decision) => {
							void handleApproval(decision);
						}}
						approvalBusy={approvalBusy}
						onPlanDecision={(decision, note) => {
							void handlePlanDecision(decision, note);
						}}
					/>
				</div>
				<AgentPanel
					key={currentId ?? "welcome"}
					agents={chat.agents}
					usage={chat.usage}
					open={workerRunning && !panelCollapsed}
					sessionName={currentName}
					transcript={chat.transcript}
					todosByAgent={chat.todosByAgent}
					onToggle={() => {
						setPanelCollapsed((v) => !v);
					}}
				/>
			</div>
		</TooltipProvider>
	);
}
