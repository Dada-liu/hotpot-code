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
	getInbox,
	getPermission,
	listPrompts,
	listSessions,
	type PromptInfo,
	removeQueued,
	type SessionSummary,
	sendMessage,
	setPermission,
	steerQueued,
} from "./api.ts";
import { AgentPanel } from "./components/AgentPanel.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { SessionList } from "./components/SessionList.tsx";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { type ConnectionState, connect } from "./events.ts";
import { sessionNameFromPrompt } from "./lib/session-name.ts";
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
	const [currentId, setCurrentId] = useState<string | null>(null);
	// 点“新建会话”后进入待创建态：不立刻建会话，首条消息发送时才创建
	const [pending, setPending] = useState(false);
	// 待创建态选择的工作目录（新建会话对话框；null = 服务端默认 cwd）
	const [pendingCwd, setPendingCwd] = useState<string | null>(null);
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
	}, [refreshSessions]);

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

	const handleCreate = (cwd?: string): void => {
		// Kimi 式延迟创建：直接清空对话区进入欢迎态，首条消息发送时才真正建会话。
		// 新建会话对话框可选填工作目录（留空 = 服务端默认 cwd），随首条消息一起创建
		const normalized = cwd?.trim() ?? "";
		setPendingCwd(normalized === "" ? null : normalized);
		setCurrentId(null);
		setPending(true);
		setNotices([]);
		setCreateError(null);
		dispatch({ type: "reset" });
		setError(null);
	};

	const handleSelect = (id: string): void => {
		if (id === currentId) {
			return;
		}
		setError(null);
		setPending(false);
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
				dispatch({ type: "reset" });
			}
			await refreshSessions();
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
			// 待创建态：首条消息先到——带待选 cwd 创建会话、以提示词命名、加入列表并连接
			if (currentId === null) {
				let id: string;
				try {
					id = await createSession(pendingCwd ?? undefined);
				} catch (e) {
					// cwd 校验失败（400）等：停在欢迎态，红字提示，可改工作目录后重试
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
				setPendingCwd(null);
				setCreateError(null);
				await refreshSessions();
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
	// 右侧面板开关只在 work agent 运行期间展示
	const workerRunning = chat.agents.some(
		(a) => a.role === "worker" && a.status === "running",
	);

	return (
		<TooltipProvider>
			<div className="flex h-screen overflow-hidden">
				<SessionList
					sessions={sessions}
					currentId={currentId}
					nameFor={(s) => names[s.id] ?? s.cwd}
					onSelect={handleSelect}
					onCreate={handleCreate}
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
				<div className="flex min-w-0 flex-1 flex-col">
					<header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
						<span
							className="min-w-0 flex-1 truncate text-sm text-muted-foreground"
							title={current?.cwd ?? pendingCwd ?? undefined}
						>
							{current
								? currentName
								: pending
									? pendingCwd === null
										? "新会话"
										: `新会话 · ${pendingCwd}`
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
