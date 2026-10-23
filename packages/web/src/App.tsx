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
	listPrompts,
	listSessions,
	type PromptInfo,
	type SessionSummary,
	sendMessage,
	steerMessage,
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
	const [names, setNames] = useState<Record<string, string>>(loadSessionNames);
	const [chat, dispatch] = useReducer(
		reduceChatAction,
		undefined,
		createInitialState,
	);
	const [connState, setConnState] = useState<ConnectionState | "idle">("idle");
	const [error, setError] = useState<string | null>(null);
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

	const handleCreate = (): void => {
		// Kimi 式延迟创建：直接清空对话区进入欢迎态，首条消息发送时才真正建会话
		setCurrentId(null);
		setPending(true);
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

	// 空闲发送 = 新 turn（POST messages）；运行中发送 = steer 注入（POST steer）
	const handleSend = async (content: string): Promise<void> => {
		try {
			// 待创建态：首条消息先到——创建会话、以提示词命名、加入列表并连接
			// 无会话（初始欢迎态或点“新建会话”的待创建态）：首条消息先创建会话、以提示词命名、加入列表并连接
			if (currentId === null) {
				const id = await createSession();
				setNames((prev) => {
					const next = { ...prev, [id]: sessionNameFromPrompt(content) };
					localStorage.setItem(SESSION_NAMES_KEY, JSON.stringify(next));
					return next;
				});
				setCurrentId(id);
				setPending(false);
				await refreshSessions();
				await sendMessage(id, content);
				setSessions((ss) =>
					ss.map((s) => (s.id === id ? { ...s, turn: "running" as const } : s)),
				);
				setError(null);
				return;
			}
			if (chat.turn === "running") {
				await steerMessage(currentId, content);
				void refreshInbox(currentId);
			} else {
				await sendMessage(currentId, content);
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
							title={current?.cwd}
						>
							{current ? currentName : pending ? "新会话" : "hotpot-agent"}
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
