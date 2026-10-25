// 左栏：工作区浏览器。侧栏头（logo），正文分「工作区」与「未分组」两个分类：
// - 「工作区」分类名右侧在有工作区时挂「新建工作区」图标按钮（无工作区时按钮在空态里）
// - 工作区行可展开/收起（localStorage 持久化）、可拖拽排序（HTML5 DnD →
//   PUT /api/workspaces/order），hover 露出「+ 新建会话」与「…」重命名/删除
// - 会话行 = 统一 hover/active 容器的行体 + 行尾归档/删除下拉（运行中归档、空闲删除，
//   二次确认）；会话名与工作区名的 tooltip 用 sideOffset 推到侧栏之外，避免遮挡行内按钮
// 底部功能按钮区：设置（弹设置弹窗，见 SettingsDialog）。

import {
	Archive,
	ChevronDown,
	ChevronRight,
	Folder,
	FolderPlus,
	MoreHorizontal,
	Pencil,
	Plus,
	Settings,
	Trash2,
} from "lucide-react";
import {
	type DragEvent,
	type ReactElement,
	useCallback,
	useEffect,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { SessionSummary, WorkspaceWire } from "../api.ts";
import {
	groupSessionsByWorkspace,
	workspaceForSession,
} from "../lib/workspaces.ts";

// 折叠状态只存 id 集合；当前会话/待建会话所在组会被自动展开
const COLLAPSED_KEY = "hotpot.workspaceCollapsed";

function loadCollapsed(): Set<string> {
	try {
		const raw = localStorage.getItem(COLLAPSED_KEY);
		if (raw === null) {
			return new Set();
		}
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			return new Set();
		}
		return new Set(parsed.filter((id): id is string => typeof id === "string"));
	} catch {
		return new Set();
	}
}

function saveCollapsed(ids: Set<string>): void {
	try {
		localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
	} catch {
		// 隐私模式等写入失败：折叠状态退化为本次会话内有效
	}
}

function formatTime(iso: string): string {
	const t = new Date(iso);
	return Number.isNaN(t.getTime()) ? iso : t.toLocaleString();
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

// 把 sourceId 移到 targetId 之前；拖到自己身上是 no-op
function moveBefore(
	ids: string[],
	sourceId: string,
	targetId: string,
): string[] {
	if (sourceId === targetId) {
		return ids;
	}
	const next = ids.filter((id) => id !== sourceId);
	const targetIndex = next.indexOf(targetId);
	if (targetIndex < 0) {
		return ids;
	}
	next.splice(targetIndex, 0, sourceId);
	return next;
}

interface SessionRowProps {
	session: SessionSummary;
	active: boolean;
	name: string;
	onSelect: (id: string) => void;
	onDelete: (id: string) => void;
	onArchive: (id: string) => void;
}

// 单行 = 会话主体（点击选中）+ 行尾展开/收起下拉（hover 露出、向左弹出）
function SessionRow({
	session,
	active,
	name,
	onSelect,
	onDelete,
	onArchive,
}: SessionRowProps): ReactElement {
	// 操作二次确认：首次点菜单项进入确认态（菜单保持打开），再点一次才执行；
	// 菜单关闭即重置（DropdownMenuContent 卸载，confirming 随之复位）
	const [confirming, setConfirming] = useState(false);
	const running = session.turn === "running";

	// 会话名是否被省略号截断（打点）：span 挂载或换名（key 变化触发重挂）时量一次 scrollWidth
	const [truncated, setTruncated] = useState(false);
	const measureName = useCallback((el: HTMLSpanElement | null) => {
		if (el !== null) {
			setTruncated(el.scrollWidth > el.clientWidth);
		}
	}, []);
	const nameSpan = (
		// w-full 是打点的前提：父级 flex-col + items-start 会让 span 收缩到内容宽度，
		// 没有宽度约束时 truncate 永远不生效（scrollWidth === clientWidth）
		<span
			ref={measureName}
			key={name}
			className="block w-full truncate text-sm"
		>
			{name}
		</span>
	);

	return (
		<li className="group">
			{/* 行体与右侧操作钮同处一个容器：hover/active 底色覆盖整行（含按钮区域） */}
			<div
				className={cn(
					"flex items-center rounded-lg transition-colors",
					active ? "bg-primary text-primary-foreground" : "hover:bg-accent",
				)}
			>
				<button
					type="button"
					className="flex min-w-0 flex-1 flex-col items-start px-2 py-2 text-left"
					onClick={() => {
						onSelect(session.id);
					}}
				>
					{/* tooltip 常驻展示 cwd（工作区上下文已由分组表达，行内不再占一行副标题）。
					    sideOffset 把气泡推到「行体 + 行尾按钮 + 侧栏内边距」之外：
					    行尾按钮 24px + 间距/内边距约 12px，取 48 保证气泡落在侧栏之外 */}
					<Tooltip>
						<TooltipTrigger asChild>{nameSpan}</TooltipTrigger>
						<TooltipContent
							side="right"
							sideOffset={48}
							className="max-w-72 break-all font-normal"
						>
							{truncated && <span className="block font-medium">{name}</span>}
							<span className="block">{session.cwd}</span>
						</TooltipContent>
					</Tooltip>
					<span
						className={cn(
							"mt-0.5 flex items-center gap-1.5 text-[11px]",
							active ? "text-primary-foreground/60" : "text-muted-foreground",
						)}
					>
						<span
							className={cn(
								"size-1.5 rounded-full",
								running ? "bg-brand" : "bg-current opacity-40",
							)}
						/>
						{formatTime(session.createdAt)}
					</span>
				</button>
				<DropdownMenu
					onOpenChange={(open) => {
						if (!open) {
							setConfirming(false);
						}
					}}
				>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							aria-label="会话操作"
							className={cn(
								"mr-1 flex size-6 shrink-0 items-center justify-center rounded-md opacity-0 transition-[opacity,background-color,color] group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
								active
									? "text-primary-foreground/70 hover:bg-primary-foreground/15 hover:text-primary-foreground"
									: "text-muted-foreground hover:bg-accent-foreground/10 hover:text-foreground",
							)}
						>
							<ChevronDown className="size-3.5 transition-transform duration-200 [[data-state=open]_&]:rotate-180" />
						</button>
					</DropdownMenuTrigger>
					{/* 会话行操作弹窗与工作区弹窗一致：侧栏右侧、sideOffset 4 */}
					<DropdownMenuContent side="right" align="start" sideOffset={4}>
						{running ? (
							<DropdownMenuItem
								className="gap-2"
								onSelect={(e) => {
									if (!confirming) {
										// 首次点击：拦截默认的选单即关行为，停留在确认态
										e.preventDefault();
										setConfirming(true);
										return;
									}
									onArchive(session.id);
								}}
							>
								<Archive className="size-3.5" />
								{confirming ? "再次点击确认归档" : "归档"}
							</DropdownMenuItem>
						) : (
							<DropdownMenuItem
								variant="destructive"
								className="gap-2"
								onSelect={(e) => {
									if (!confirming) {
										e.preventDefault();
										setConfirming(true);
										return;
									}
									onDelete(session.id);
								}}
							>
								<Trash2 className="size-3.5" />
								{confirming ? "再次点击确认删除" : "删除会话"}
							</DropdownMenuItem>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</li>
	);
}

interface SessionListProps {
	workspaces: WorkspaceWire[];
	sessions: SessionSummary[];
	currentId: string | null;
	pendingWorkspaceId: string | null;
	nameFor: (s: SessionSummary) => string;
	onSelect: (id: string) => void;
	onNewSessionIn: (workspaceId: string) => void;
	onNewSessionGlobal: () => void;
	onAddWorkspace: () => void;
	// 原生选择器请求在途：禁用「添加工作区」入口，防止重复弹系统对话框
	addWorkspaceBusy?: boolean;
	// 失败时 reject，由弹窗展示服务端 message
	onRenameWorkspace: (id: string, title: string) => Promise<void>;
	onDeleteWorkspace: (id: string) => Promise<void>;
	onReorderWorkspaces: (ids: string[]) => Promise<void>;
	onDelete: (id: string) => void;
	onArchive: (id: string) => void;
	onOpenSettings: () => void;
}

export function SessionList({
	workspaces,
	sessions,
	currentId,
	pendingWorkspaceId,
	nameFor,
	onSelect,
	onNewSessionIn,
	onNewSessionGlobal,
	onAddWorkspace,
	addWorkspaceBusy = false,
	onRenameWorkspace,
	onDeleteWorkspace,
	onReorderWorkspaces,
	onDelete,
	onArchive,
	onOpenSettings,
}: SessionListProps): ReactElement {
	const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
	const [dragId, setDragId] = useState<string | null>(null);
	const [dropId, setDropId] = useState<string | null>(null);
	const [renameTarget, setRenameTarget] = useState<WorkspaceWire | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	const [renameError, setRenameError] = useState<string | null>(null);
	const [renameBusy, setRenameBusy] = useState(false);
	const [deleteTarget, setDeleteTarget] = useState<WorkspaceWire | null>(null);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const [deleteBusy, setDeleteBusy] = useState(false);

	const grouped = groupSessionsByWorkspace(workspaces, sessions);
	const currentWorkspaceId =
		currentId === null
			? null
			: (workspaceForSession(workspaces, currentId)?.id ?? null);

	// 当前会话/待建会话所在组自动展开：清掉持久化里的过期折叠状态
	useEffect(() => {
		const activeId = currentWorkspaceId ?? pendingWorkspaceId;
		if (activeId === null) {
			return;
		}
		setCollapsed((prev) => {
			if (!prev.has(activeId)) {
				return prev;
			}
			const next = new Set(prev);
			next.delete(activeId);
			return next;
		});
	}, [currentWorkspaceId, pendingWorkspaceId]);

	useEffect(() => {
		saveCollapsed(collapsed);
	}, [collapsed]);

	const toggleCollapsed = (id: string): void => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	};

	const handleDragStart = (
		e: DragEvent<HTMLElement>,
		workspaceId: string,
	): void => {
		setDragId(workspaceId);
		e.dataTransfer.effectAllowed = "move";
		e.dataTransfer.setData("text/plain", workspaceId);
	};

	const handleDragOver = (
		e: DragEvent<HTMLElement>,
		workspaceId: string,
	): void => {
		if (dragId === null || dragId === workspaceId) {
			return;
		}
		e.preventDefault();
		e.dataTransfer.dropEffect = "move";
		setDropId(workspaceId);
	};

	const handleDrop = (e: DragEvent<HTMLElement>, targetId: string): void => {
		e.preventDefault();
		const sourceId = dragId ?? e.dataTransfer.getData("text/plain");
		setDragId(null);
		setDropId(null);
		if (sourceId === "" || sourceId === targetId) {
			return;
		}
		const ids = workspaces.map((w) => w.id);
		if (!ids.includes(sourceId)) {
			return;
		}
		const next = moveBefore(ids, sourceId, targetId);
		// 失败由 App 回滚并展示错误；这里只需吞掉 rejection
		void onReorderWorkspaces(next).catch(() => {});
	};

	const openRename = (workspace: WorkspaceWire): void => {
		setRenameTarget(workspace);
		setRenameDraft(workspace.title);
		setRenameError(null);
	};

	const submitRename = async (): Promise<void> => {
		if (renameTarget === null || renameBusy) {
			return;
		}
		setRenameBusy(true);
		setRenameError(null);
		try {
			await onRenameWorkspace(renameTarget.id, renameDraft.trim());
			setRenameTarget(null);
		} catch (e) {
			setRenameError(errorMessage(e));
		} finally {
			setRenameBusy(false);
		}
	};

	const openDelete = (workspace: WorkspaceWire): void => {
		setDeleteTarget(workspace);
		setDeleteError(null);
	};

	const submitDelete = async (): Promise<void> => {
		if (deleteTarget === null || deleteBusy) {
			return;
		}
		setDeleteBusy(true);
		setDeleteError(null);
		try {
			await onDeleteWorkspace(deleteTarget.id);
			setDeleteTarget(null);
		} catch (e) {
			setDeleteError(errorMessage(e));
		} finally {
			setDeleteBusy(false);
		}
	};

	return (
		<aside className="flex h-full w-60 shrink-0 flex-col border-r bg-secondary/60">
			<div className="flex items-center gap-2 px-4 pb-1 pt-4">
				<img
					src="/logo.png"
					alt="hotpot"
					className="h-8 w-8 rounded-lg object-contain"
				/>
				<span className="text-base font-semibold tracking-tight">hotpot</span>
			</div>
			<div className="px-3 pb-2 pt-3">
				<Button
					variant="outline"
					className="w-full justify-start gap-2 rounded-xl border-border-strong bg-background py-5 hover:bg-accent"
					onClick={onNewSessionGlobal}
				>
					<Plus className="size-4" />
					新建会话
				</Button>
			</div>
			<ScrollArea className="min-h-0 flex-1">
				<div className="flex flex-col gap-1 px-2 pb-3 pt-1">
					{/* 「工作区」分类头：与「未分组」同款样式；有工作区时右侧同行挂新建按钮 */}
					<div className="flex items-center justify-between px-3 pb-1 pt-2">
						<span className="text-xs font-medium text-muted-foreground">
							工作区
						</span>
						{workspaces.length > 0 && (
							<Tooltip>
								<TooltipTrigger asChild>
									<button
										type="button"
										aria-label="添加工作区"
										className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
										disabled={addWorkspaceBusy}
										onClick={onAddWorkspace}
									>
										<FolderPlus className="size-3.5" />
									</button>
								</TooltipTrigger>
								{/* 图标按钮规则：气泡紧贴 svg 上方（sideOffset=0，见 web AGENTS.md） */}
								<TooltipContent side="top" sideOffset={0}>
									添加工作区
								</TooltipContent>
							</Tooltip>
						)}
					</div>
					{workspaces.length === 0 && (
						<div className="flex flex-col items-center gap-3 px-4 py-6 text-center">
							<p className="flex flex-col gap-0.5 text-xs text-muted-foreground">
								<span>还没有工作区</span>
								<span>请选择文件夹作为工作区</span>
							</p>
							<Button
								variant="outline"
								size="sm"
								className="border-border-strong bg-background"
								disabled={addWorkspaceBusy}
								onClick={onAddWorkspace}
							>
								<FolderPlus className="size-3.5" />
								添加工作区
							</Button>
						</div>
					)}
					{grouped.groups.map(({ workspace, sessions: groupSessions }) => {
						const expanded = !collapsed.has(workspace.id);
						const highlighted =
							pendingWorkspaceId === workspace.id ||
							(currentId !== null && workspace.sessionIds.includes(currentId));
						return (
							<div key={workspace.id}>
								<fieldset
									draggable
									aria-label={workspace.title}
									className={cn(
										"min-w-0",
										"group/workspace flex cursor-grab items-center gap-1 rounded-lg px-1.5 py-1.5 transition-colors active:cursor-grabbing",
										highlighted ? "bg-accent" : "hover:bg-accent/60",
										dragId === workspace.id && "opacity-50",
										dropId === workspace.id &&
											"bg-brand-soft ring-1 ring-brand/40",
									)}
									onDragStart={(e) => {
										handleDragStart(e, workspace.id);
									}}
									onDragOver={(e) => {
										handleDragOver(e, workspace.id);
									}}
									onDragLeave={() => {
										setDropId((current) =>
											current === workspace.id ? null : current,
										);
									}}
									onDrop={(e) => {
										handleDrop(e, workspace.id);
									}}
									onDragEnd={() => {
										setDragId(null);
										setDropId(null);
									}}
								>
									<button
										type="button"
										aria-label={expanded ? "收起工作区" : "展开工作区"}
										className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
										onClick={() => {
											toggleCollapsed(workspace.id);
										}}
									>
										<ChevronRight
											className={cn(
												"size-3.5 transition-transform",
												expanded && "rotate-90",
											)}
										/>
									</button>
									<Folder className="size-3.5 shrink-0 text-muted-foreground" />
									{/* 路径 tooltip：sideOffset 越过「+ / …」两个行尾按钮与内边距，
									    气泡落在侧栏之外，不遮挡按钮 */}
									<Tooltip>
										<TooltipTrigger asChild>
											<span className="min-w-0 flex-1 truncate text-sm font-semibold">
												{workspace.title}
											</span>
										</TooltipTrigger>
										<TooltipContent
											side="right"
											sideOffset={72}
											className="max-w-72 break-all font-normal"
										>
											{workspace.path}
										</TooltipContent>
									</Tooltip>
									<Tooltip>
										<TooltipTrigger asChild>
											<button
												type="button"
												aria-label="在此工作区新建会话"
												className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[opacity,background-color,color] hover:bg-accent-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover/workspace:opacity-100"
												onClick={() => {
													onNewSessionIn(workspace.id);
												}}
											>
												<Plus className="size-3.5" />
											</button>
										</TooltipTrigger>
										{/* 图标按钮规则：气泡紧贴 svg 上方（sideOffset=0，见 web AGENTS.md） */}
										<TooltipContent side="top" sideOffset={0}>
											新建会话
										</TooltipContent>
									</Tooltip>
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<button
												type="button"
												aria-label="工作区操作"
												className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100 group-hover/workspace:opacity-100"
											>
												<MoreHorizontal className="size-3.5" />
											</button>
										</DropdownMenuTrigger>
										<DropdownMenuContent
											side="right"
											align="start"
											sideOffset={4}
										>
											<DropdownMenuItem
												className="gap-2"
												onSelect={() => {
													openRename(workspace);
												}}
											>
												<Pencil className="size-3.5" />
												重命名
											</DropdownMenuItem>
											<DropdownMenuItem
												variant="destructive"
												className="gap-2"
												onSelect={() => {
													openDelete(workspace);
												}}
											>
												<Trash2 className="size-3.5" />
												删除
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								</fieldset>
								{expanded && (
									<ul className="mb-1 flex flex-col gap-0.5 pl-2">
										{groupSessions.map((s) => (
											<SessionRow
												key={s.id}
												session={s}
												active={s.id === currentId}
												name={nameFor(s)}
												onSelect={onSelect}
												onDelete={onDelete}
												onArchive={onArchive}
											/>
										))}
										{groupSessions.length === 0 && (
											<li className="px-3 py-1.5 text-xs text-muted-foreground">
												暂无会话
											</li>
										)}
									</ul>
								)}
							</div>
						);
					})}
					{grouped.ungrouped.length > 0 && (
						<div className="mt-1">
							<div className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">
								未分组
							</div>
							<ul className="flex flex-col gap-0.5">
								{grouped.ungrouped.map((s) => (
									<SessionRow
										key={s.id}
										session={s}
										active={s.id === currentId}
										name={nameFor(s)}
										onSelect={onSelect}
										onDelete={onDelete}
										onArchive={onArchive}
									/>
								))}
							</ul>
						</div>
					)}
				</div>
			</ScrollArea>
			<div className="border-t p-2">
				<Button
					variant="outline"
					className="w-full justify-start gap-2 rounded-xl border-border-strong bg-background py-5 hover:bg-accent"
					onClick={onOpenSettings}
				>
					<Settings className="size-4" />
					设置
				</Button>
			</div>
			{/* 重命名工作区：回车/保存提交，服务端 409 重名等错误行内展示 */}
			<Dialog
				open={renameTarget !== null}
				onOpenChange={(open) => {
					if (!open && !renameBusy) {
						setRenameTarget(null);
						setRenameError(null);
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>重命名工作区</DialogTitle>
						<DialogDescription>
							标题仅用于侧栏展示，不会重命名磁盘目录。
						</DialogDescription>
					</DialogHeader>
					<Input
						value={renameDraft}
						disabled={renameBusy}
						onChange={(e) => {
							setRenameDraft(e.target.value);
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								void submitRename();
							}
						}}
						autoFocus
					/>
					{renameError !== null && (
						<p className="text-xs text-destructive">{renameError}</p>
					)}
					<DialogFooter>
						<Button
							variant="ghost"
							disabled={renameBusy}
							onClick={() => {
								setRenameTarget(null);
								setRenameError(null);
							}}
						>
							取消
						</Button>
						<Button
							disabled={renameBusy}
							onClick={() => {
								void submitRename();
							}}
						>
							{renameBusy ? "保存中…" : "保存"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			{/* 删除工作区：只注销注册，目录与会话日志保留 */}
			<Dialog
				open={deleteTarget !== null}
				onOpenChange={(open) => {
					if (!open && !deleteBusy) {
						setDeleteTarget(null);
						setDeleteError(null);
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							删除工作区「{deleteTarget?.title ?? ""}」？
						</DialogTitle>
						<DialogDescription>
							删除工作区只移除注册，文件夹与会话日志保留，组内会话将变为「未分组」。
						</DialogDescription>
					</DialogHeader>
					{deleteError !== null && (
						<p className="text-xs text-destructive">{deleteError}</p>
					)}
					<DialogFooter>
						<Button
							variant="ghost"
							disabled={deleteBusy}
							onClick={() => {
								setDeleteTarget(null);
								setDeleteError(null);
							}}
						>
							取消
						</Button>
						<Button
							variant="destructive"
							disabled={deleteBusy}
							onClick={() => {
								void submitDelete();
							}}
						>
							{deleteBusy ? "删除中…" : "删除"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</aside>
	);
}
