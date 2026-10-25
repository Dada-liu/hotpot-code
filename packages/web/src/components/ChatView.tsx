// 中栏：对话流按回合分组——右侧用户气泡，左侧 main_agent 头像栏（思考/工具过程 + 最终回答）；
// welcome 态（待创建会话）时 logo 与输入框居中。
// 过程区（思考文本 + 工具卡片）只在进行中展开；最终回答存在或开始流式生成时默认折叠，可手动展开。
// 输入（M4 重做）：空闲发送 = 新 turn；运行中发送 = 排队 next-turn（QueueBar 内消息可转 steer 注入）。
// Enter 发送，Shift+Enter 换行；IME 组合键入中 Enter 不触发（isComposing 守卫）。

import {
	ChevronDown,
	ChevronRight,
	File,
	Folder,
	ListPlus,
	Paperclip,
	Send,
	Square,
	X,
} from "lucide-react";
import {
	type ChangeEvent,
	type KeyboardEvent,
	type ReactElement,
	useEffect,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
	listFs,
	type PermissionMode,
	type PromptInfo,
	uploadFile,
} from "../api.ts";
import {
	findFinalAnswer,
	groupTranscript,
	isProcessItem,
	type TurnGroup,
} from "../lib/turn-groups.ts";
import type { ContentBlock, FsEntry, InboxSnapshot } from "../protocol.ts";
import type { ChatState, TranscriptEntry } from "../state/reducer.ts";
import { ApprovalPrompt } from "./ApprovalPrompt.tsx";
import { MessageBubble } from "./MessageBubble.tsx";
import { PermissionSelect } from "./PermissionSelect.tsx";
import { PlanPanel } from "./PlanPanel.tsx";
import { ToolCallCard } from "./ToolCallCard.tsx";

// assistant 消息的文本块拼接（tool_call 块不渲染文本）
function textOf(content: ContentBlock[]): string {
	return content
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n\n");
}

// 单条 transcript 条目渲染：assistant 气泡 / 工具卡片 / 计划卡片 / 审批痕迹 / 错误行。
// 主对话区与 agent 详情面板共用（详情按 agentId 过滤 transcript 后逐条渲染）
export function TranscriptItem({
	entry,
	pendingPlan,
	onPlanDecision,
}: {
	entry: TranscriptEntry;
	pendingPlan: ChatState["pendingPlan"];
	onPlanDecision: (
		decision: "approve" | "reject" | "annotate",
		note?: string,
	) => void;
}): ReactElement | null {
	switch (entry.kind) {
		case "assistant":
			return <MessageBubble variant="assistant" text={textOf(entry.content)} />;
		case "tool":
			return (
				<ToolCallCard
					name={entry.name}
					input={entry.input}
					result={entry.result}
				/>
			);
		case "plan":
			return (
				<PlanPanel
					phase={entry.phase}
					plan={entry.plan}
					pending={pendingPlan?.entryId === entry.id}
					onDecide={onPlanDecision}
				/>
			);
		case "approval":
			// 审计痕迹行（待处理的由 ApprovalPrompt 内联呈现）
			return (
				<div className="flex items-center gap-2 text-xs text-muted-foreground">
					审批 · {entry.summary}
					{entry.decision !== undefined && (
						<span
							className={
								entry.decision === "approved"
									? "font-medium text-foreground"
									: "font-medium text-destructive"
							}
						>
							{entry.decision === "approved" ? "已允许" : "已拒绝"}
						</span>
					)}
				</div>
			);
		case "error":
			return (
				<div className="font-mono text-xs text-destructive">
					[{entry.code}] {entry.message}
				</div>
			);
		default:
			// user 条目在回合组头部单独渲染
			return null;
	}
}

// M4 附件：文本类扩展名白名单（MIME text/* 另行放行；.env/.gitignore 等点文件按 basename 命中）
const TEXT_EXTENSIONS = new Set([
	"ts",
	"tsx",
	"js",
	"jsx",
	"json",
	"md",
	"txt",
	"log",
	"yaml",
	"yml",
	"toml",
	"py",
	"rs",
	"go",
	"java",
	"c",
	"cc",
	"h",
	"css",
	"html",
	"xml",
	"csv",
	"sh",
	"env",
	"gitignore",
	"lock",
]);
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 256 * 1024;

function isTextLike(name: string, mime: string): boolean {
	if (mime.startsWith("text/")) {
		return true;
	}
	const base = name.toLowerCase();
	if (base.startsWith(".") && TEXT_EXTENSIONS.has(base.slice(1))) {
		return true;
	}
	const dot = base.lastIndexOf(".");
	return dot >= 0 && TEXT_EXTENSIONS.has(base.slice(dot + 1));
}

// 光标前 @token 提取：@ 后只含路径字符（字母数字 / . _ -），token 内最后一个 / 前为目录部
const MENTION_RE = /@([A-Za-z0-9._\-/]*)$/;

// 附件 chip：path 为服务端返回的绝对路径；chip 移除仅客户端生效（服务端文件保留）
interface AttachmentChip {
	key: number;
	name: string;
	sizeKb: number;
	path: string;
}

// @ 补全弹层状态：tokenStart 为 draft 中 @ 的下标，items 为 fs/ls 过滤后的候选项
interface MentionState {
	tokenStart: number;
	items: FsEntry[];
	index: number;
	loading: boolean;
}

// 输入卡片：welcome 态与对话底部共用。上下布局（textarea 在上，按钮区在下）：
// - 空闲发送 = 新 turn；运行中发送 = 排队 next-turn（ListPlus 图标），取消钮移到 QueueBar
// - 底部左侧：权限切换（Shield）+ 添加附件（Paperclip）；右侧：发送/排队。图标按钮
//   tooltip 统一 side="top" + sideOffset={0}
// - `/` 补全按 builtin 分组（内置指令 / 提示词模板）；内置指令命中后服务端 200 {reply}
//   由 App 渲染本地 notice 气泡
// - 选文本附件立即上传，chip 可移除；发送时每个附件的 @<绝对路径> 独占一行追加
// - @ 触发工作区文件补全（防抖 200ms 调 fs/ls，Enter/点击插入 @<绝对路径>）
// tall：未选中会话的 welcome 态，输入框最小高度在默认基础上增加一半（76px → 114px）
function Composer({
	running,
	prompts,
	tall = false,
	hasSession,
	sessionId,
	permissionMode,
	permissionDisabled = false,
	onPermissionChange,
	onSend,
}: {
	running: boolean;
	prompts: PromptInfo[];
	tall?: boolean;
	hasSession: boolean;
	sessionId: string | null;
	permissionMode: PermissionMode;
	permissionDisabled?: boolean;
	onPermissionChange: (mode: PermissionMode) => void;
	onSend: (content: string) => void;
}): ReactElement {
	const [draft, setDraft] = useState("");
	const [attachments, setAttachments] = useState<AttachmentChip[]>([]);
	// 附件筛选/上传失败的行内提示（不重，不阻塞输入）
	const [attachError, setAttachError] = useState<string | null>(null);
	const [mention, setMention] = useState<MentionState | null>(null);
	const chipKey = useRef(0);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const mentionTimer = useRef<number | null>(null);
	// 递增请求号：过期响应丢弃（防抖窗口内光标已移动）
	const mentionReq = useRef(0);

	// 卸载时清掉防抖计时器
	useEffect(() => {
		return () => {
			if (mentionTimer.current !== null) {
				window.clearTimeout(mentionTimer.current);
			}
		};
	}, []);

	// 只补全命令名本身（输入空格后进入参数阶段，不再弹层）；按 builtin 分组展示
	const slash = /^\/([A-Za-z0-9_-]*)$/.exec(draft);
	const suggestions =
		slash === null
			? []
			: prompts.filter((p) => p.name.startsWith(slash[1] ?? ""));
	const builtinSuggestions = suggestions.filter((p) => p.builtin);
	const templateSuggestions = suggestions.filter((p) => !p.builtin);

	// @ 补全防抖入口：光标/token 变化后 200ms 才发 fs/ls
	const scheduleMention = (): void => {
		if (mentionTimer.current !== null) {
			window.clearTimeout(mentionTimer.current);
		}
		mentionTimer.current = window.setTimeout(runMention, 200);
	};

	const runMention = (): void => {
		const el = textareaRef.current;
		if (!hasSession || sessionId === null || el === null) {
			setMention(null);
			return;
		}
		const caret = el.selectionStart ?? 0;
		const m = MENTION_RE.exec(el.value.slice(0, caret));
		if (m === null || m[1] === undefined) {
			setMention(null);
			return;
		}
		const token = m[1];
		const slashIdx = token.lastIndexOf("/");
		const dirPart = slashIdx >= 0 ? token.slice(0, slashIdx) : "";
		const query = slashIdx >= 0 ? token.slice(slashIdx + 1) : token;
		const tokenStart = caret - token.length - 1;
		const req = ++mentionReq.current;
		setMention({ tokenStart, items: [], index: 0, loading: true });
		listFs(sessionId, dirPart)
			.then((entries) => {
				if (mentionReq.current !== req) {
					return;
				}
				const q = query.toLowerCase();
				const items = entries
					.filter((e) => e.name.toLowerCase().startsWith(q))
					.slice(0, 8);
				setMention((prev) =>
					prev !== null && prev.tokenStart === tokenStart
						? { ...prev, items, index: 0, loading: false }
						: prev,
				);
			})
			.catch(() => {
				// 目录不存在/越界等：静默关闭弹层
				if (mentionReq.current === req) {
					setMention(null);
				}
			});
	};

	// 选中候选项：用 @<绝对路径> 替换 @token，焦点与光标归位
	const applyMention = (entry: FsEntry): void => {
		const el = textareaRef.current;
		if (el === null || mention === null) {
			return;
		}
		const caret = el.selectionStart ?? draft.length;
		const inserted = `@${entry.path}`;
		setDraft(
			draft.slice(0, mention.tokenStart) + inserted + draft.slice(caret),
		);
		setMention(null);
		const pos = mention.tokenStart + inserted.length;
		requestAnimationFrame(() => {
			el.focus();
			el.setSelectionRange(pos, pos);
		});
	};

	// 读文件为文本（FileReader 封装成 Promise，便于逐文件上传）
	const readText = (file: File): Promise<string> =>
		new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				resolve(typeof reader.result === "string" ? reader.result : "");
			};
			reader.onerror = () => {
				reject(new Error("读取文件失败"));
			};
			reader.readAsText(file);
		});

	// 选中文件：过滤文本类 → 逐个立即上传 → chip；失败项行内提示
	const onPickFiles = async (
		e: ChangeEvent<HTMLInputElement>,
	): Promise<void> => {
		const files = Array.from(e.target.files ?? []);
		e.target.value = ""; // 允许再次选择同一文件
		if (files.length === 0) {
			return;
		}
		let notice: string | null = null;
		const accepted: { file: File; name: string; sizeKb: number }[] = [];
		for (const f of files) {
			if (attachments.length + accepted.length >= MAX_ATTACHMENTS) {
				notice = `最多 ${MAX_ATTACHMENTS} 个附件`;
				break;
			}
			if (!isTextLike(f.name, f.type)) {
				notice = "仅支持文本附件";
				continue;
			}
			if (f.size > MAX_ATTACHMENT_BYTES) {
				notice = "单个附件不超过 256KB";
				continue;
			}
			accepted.push({
				file: f,
				name: f.name,
				sizeKb: Math.max(1, Math.round(f.size / 1024)),
			});
		}
		setAttachError(notice);
		if (sessionId === null) {
			return;
		}
		for (const a of accepted) {
			try {
				const content = await readText(a.file);
				const { path } = await uploadFile(sessionId, a.name, content);
				const key = ++chipKey.current;
				setAttachments((prev) => [
					...prev,
					{ key, name: a.name, sizeKb: a.sizeKb, path },
				]);
			} catch (err) {
				setAttachError(
					`上传 ${a.name} 失败：${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	};

	const removeChip = (key: number): void => {
		setAttachments((prev) => prev.filter((c) => c.key !== key));
	};

	const submit = (): void => {
		const text = draft.trim();
		if (text === "" && attachments.length === 0) {
			return;
		}
		// 附件引用追加：每个 @<绝对路径> 独占一行（仅保留的 chip 参与）
		const content =
			attachments.length === 0
				? text
				: [text, ...attachments.map((a) => `@${a.path}`)]
						.filter((s) => s !== "")
						.join("\n");
		setDraft("");
		setAttachments([]);
		setAttachError(null);
		setMention(null);
		onSend(content);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		// @ 补全打开时优先接管键盘（换选中项 / 插入 / 关闭）
		if (mention !== null) {
			if (e.key === "ArrowDown" && mention.items.length > 0) {
				e.preventDefault();
				setMention({
					...mention,
					index: (mention.index + 1) % mention.items.length,
				});
				return;
			}
			if (e.key === "ArrowUp" && mention.items.length > 0) {
				e.preventDefault();
				setMention({
					...mention,
					index:
						(mention.index - 1 + mention.items.length) % mention.items.length,
				});
				return;
			}
			if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
				if (mention.items.length > 0) {
					e.preventDefault();
					applyMention(mention.items[mention.index] as FsEntry);
				}
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setMention(null);
				return;
			}
		}
		// isComposing 守卫：中文输入法组字中的 Enter 用于选词，不能发送
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			submit();
		}
	};

	// 附件按钮：统一用回形针图标（与「新建」类加号区分）；无会话禁用并提示先创建
	const attachButton = (
		<Button
			type="button"
			variant="ghost"
			size="icon"
			className="rounded-full"
			disabled={!hasSession}
			onClick={() => {
				fileInputRef.current?.click();
			}}
			aria-label="添加附件"
		>
			<Paperclip className="size-4" />
		</Button>
	);

	return (
		<form
			className="relative w-full"
			onSubmit={(e) => {
				e.preventDefault();
				submit();
			}}
		>
			{/* @ 补全弹层：目录在前（服务端已排序），最多 8 条 */}
			{mention !== null && (
				<div className="absolute bottom-full left-0 z-10 mb-2 w-full overflow-hidden rounded-xl border border-border-strong bg-background shadow-lg shadow-black/5">
					{mention.items.length === 0 ? (
						<div className="px-4 py-2 text-xs text-muted-foreground">
							{mention.loading ? "浏览工作区…" : "无匹配文件"}
						</div>
					) : (
						mention.items.map((entry, i) => (
							<button
								key={entry.path}
								type="button"
								className={cn(
									"flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-secondary",
									i === mention.index && "bg-secondary",
								)}
								// mousedown 先于 blur 触发，避免弹层先关导致点不中
								onMouseDown={(e) => {
									e.preventDefault();
									applyMention(entry);
								}}
							>
								{entry.kind === "dir" ? (
									<Folder className="size-3.5 shrink-0 text-muted-foreground" />
								) : (
									<File className="size-3.5 shrink-0 text-muted-foreground" />
								)}
								<span className="min-w-0 flex-1 truncate font-mono text-sm">
									{entry.name}
								</span>
							</button>
						))
					)}
				</div>
			)}
			{/* `/` 补全弹层：按 builtin 分区（内置指令 / 提示词模板） */}
			{suggestions.length > 0 && (
				<div className="absolute bottom-full left-0 z-10 mb-2 w-full overflow-hidden rounded-xl border border-border-strong bg-background shadow-lg shadow-black/5">
					{builtinSuggestions.length > 0 && (
						<div>
							<div className="px-4 pt-2 text-[11px] font-medium text-muted-foreground">
								内置指令
							</div>
							{builtinSuggestions.map((p) => (
								<button
									key={p.name}
									type="button"
									className="flex w-full flex-col items-start gap-0.5 px-4 py-2 text-left transition-colors hover:bg-secondary"
									onClick={() => {
										setDraft(`/${p.name} `);
									}}
								>
									<span className="font-mono text-sm">/{p.name}</span>
									{p.description !== "" && (
										<span className="text-xs text-muted-foreground">
											{p.description}
										</span>
									)}
								</button>
							))}
						</div>
					)}
					{templateSuggestions.length > 0 && (
						<div>
							<div className="px-4 pt-2 text-[11px] font-medium text-muted-foreground">
								提示词模板
							</div>
							{templateSuggestions.map((p) => (
								<button
									key={p.name}
									type="button"
									className="flex w-full flex-col items-start gap-0.5 px-4 py-2 text-left transition-colors hover:bg-secondary"
									onClick={() => {
										setDraft(`/${p.name} `);
									}}
								>
									<span className="font-mono text-sm">/{p.name}</span>
									{p.description !== "" && (
										<span className="text-xs text-muted-foreground">
											{p.description}
										</span>
									)}
								</button>
							))}
						</div>
					)}
				</div>
			)}
			{/* 附件 chip + 行内提示（位于输入卡片上方） */}
			{attachments.length > 0 && (
				<div className="mb-2 flex flex-wrap gap-1.5">
					{attachments.map((a) => (
						<span
							key={a.key}
							className="flex items-center gap-1.5 rounded-full border border-border-strong bg-background px-2.5 py-1 text-xs"
						>
							<span className="max-w-40 truncate">{a.name}</span>
							<span className="text-muted-foreground">{a.sizeKb}KB</span>
							<button
								type="button"
								className="text-muted-foreground transition-colors hover:text-foreground"
								onClick={() => {
									removeChip(a.key);
								}}
								aria-label={`移除附件 ${a.name}`}
							>
								<X className="size-3" />
							</button>
						</span>
					))}
				</div>
			)}
			{attachError !== null && (
				<div className="mb-2 text-xs text-destructive">{attachError}</div>
			)}
			<div className="flex flex-col gap-2 rounded-2xl border border-border-strong bg-background p-3 shadow-lg shadow-black/5">
				<Textarea
					ref={textareaRef}
					value={draft}
					onChange={(e) => {
						setDraft(e.target.value);
						scheduleMention();
					}}
					onClick={scheduleMention}
					onKeyDown={onKeyDown}
					onBlur={() => {
						setMention(null);
					}}
					placeholder={
						running
							? "任务运行中：回车排队；点击上方队列消息可转为 steer 注入"
							: "输入消息，Enter 发送"
					}
					rows={1}
					className={cn(
						"w-full resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0",
						tall ? "min-h-[114px]" : "min-h-[76px]",
					)}
				/>
				{/* 底部按钮区：左侧权限 + 附件（附件在权限之后），右侧发送/排队 */}
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-1">
						<PermissionSelect
							mode={permissionMode}
							disabled={permissionDisabled}
							onChange={onPermissionChange}
						/>
						<input
							ref={fileInputRef}
							type="file"
							multiple
							className="hidden"
							onChange={(e) => {
								void onPickFiles(e);
							}}
						/>
						{hasSession ? (
							<Tooltip>
								<TooltipTrigger asChild>{attachButton}</TooltipTrigger>
								{/* 图标按钮规则：气泡紧贴 svg 上方（sideOffset=0，见 web AGENTS.md） */}
								<TooltipContent side="top" sideOffset={0}>
									添加附件
								</TooltipContent>
							</Tooltip>
						) : (
							<Tooltip>
								<TooltipTrigger asChild>
									{/* 禁用按钮不触发 hover：包一层 span 承载 tooltip */}
									<span className="inline-flex">{attachButton}</span>
								</TooltipTrigger>
								<TooltipContent side="top" sideOffset={0}>
									先创建会话
								</TooltipContent>
							</Tooltip>
						)}
					</div>
					<Button
						type="submit"
						size="icon"
						className="rounded-full"
						disabled={draft.trim() === "" && attachments.length === 0}
						aria-label={running ? "排队" : "发送"}
					>
						{running ? (
							<ListPlus className="size-4" />
						) : (
							<Send className="size-4" />
						)}
					</Button>
				</div>
			</div>
		</form>
	);
}

// 单个回合组：右侧用户气泡 + 左侧头像栏（过程区 + 常驻条目 + 最终回答/流式段）
function TurnView({
	group,
	isLast,
	streaming,
	pendingApproval,
	pendingPlan,
	onApproval,
	approvalBusy,
	onPlanDecision,
}: {
	group: TurnGroup;
	isLast: boolean;
	streaming: ChatState["streaming"];
	pendingApproval: ChatState["pendingApproval"];
	pendingPlan: ChatState["pendingPlan"];
	onApproval: (decision: "allow" | "deny") => void;
	approvalBusy: boolean;
	onPlanDecision: (
		decision: "approve" | "reject" | "annotate",
		note?: string,
	) => void;
}): ReactElement {
	const finalEntry = findFinalAnswer(group.items);
	// 过程区 = 思考（assistant 文本）+ 工具卡片；plan/approval/error 常驻不参与折叠
	const processItems = group.items.filter(
		(e) => e !== finalEntry && isProcessItem(e),
	);
	const standingItems = group.items.filter(
		(e) => e !== finalEntry && !isProcessItem(e),
	);
	// 流式段只属于最后一个回合组，且视为最终回答生成中
	const streamingHere =
		isLast && streaming !== null && streaming.agentId === "main";
	// 最终回答已落库或正在生成时，过程区默认折叠；用户可手动展开/收起
	const defaultCollapsed = finalEntry !== undefined || streamingHere;
	const [override, setOverride] = useState<boolean | null>(null);
	const expanded = override !== null ? override : !defaultCollapsed;

	return (
		<div className="flex flex-col gap-4">
			{group.user !== null && (
				<MessageBubble variant="user" text={group.user.content} />
			)}
			{(processItems.length > 0 ||
				standingItems.length > 0 ||
				finalEntry !== undefined ||
				streamingHere) && (
				<div className="flex items-start gap-3">
					<img
						src="/main_agent.png"
						alt="main agent"
						className="mt-0.5 size-9 shrink-0 rounded-full bg-secondary object-cover"
					/>
					<div className="flex min-w-0 flex-1 flex-col gap-3">
						{processItems.length > 0 && (
							<div>
								<button
									type="button"
									className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
									onClick={() => {
										setOverride(!expanded);
									}}
								>
									{expanded ? (
										<ChevronDown className="size-3" />
									) : (
										<ChevronRight className="size-3" />
									)}
									思考与工具过程（{processItems.length}）
								</button>
								{expanded && (
									<div className="mt-2 flex flex-col gap-3">
										{processItems.map((entry) => (
											<TranscriptItem
												key={entry.id}
												entry={entry}
												pendingPlan={pendingPlan}
												onPlanDecision={onPlanDecision}
											/>
										))}
									</div>
								)}
							</div>
						)}
						{standingItems.map((entry) => (
							<TranscriptItem
								key={entry.id}
								entry={entry}
								pendingPlan={pendingPlan}
								onPlanDecision={onPlanDecision}
							/>
						))}
						{finalEntry !== undefined && (
							<TranscriptItem
								entry={finalEntry}
								pendingPlan={pendingPlan}
								onPlanDecision={onPlanDecision}
							/>
						)}
						{streamingHere && (
							<MessageBubble variant="streaming" text={streaming?.text ?? ""} />
						)}
						{/* 仅 tool 型审批内联审批条；plan 型由 plan 卡片承担 */}
						{isLast &&
							pendingApproval !== null &&
							pendingApproval.approvalType === "tool" && (
								<ApprovalPrompt
									summary={pendingApproval.summary}
									detail={pendingApproval.detail}
									onAnswer={onApproval}
									busy={approvalBusy}
								/>
							)}
					</div>
				</div>
			)}
		</div>
	);
}

// steer/queue 队列条（M4 重做）：固定展示于输入框上方（队列非空或回合运行中）。
// next-turn（排队）条目点击本体 = 转为 steer 注入（POST queue/:id/steer）、✕ 移除；
// next-step（注入中）条目只读；头部 = 计数 + 运行中圆点 + 取消钮（停止钮自 composer 迁来）。
// 请求在途时禁用行操作；steer/移除失败保留条目（错误经 App 顶栏透出）
function QueueBar({
	inbox,
	running,
	busy,
	onCancel,
	onSteer,
	onRemove,
}: {
	inbox: InboxSnapshot;
	running: boolean;
	busy: boolean;
	onCancel: () => void;
	onSteer: (messageId: string) => void;
	onRemove: (messageId: string) => void;
}): ReactElement | null {
	// 运行中默认展开；用户手动切换后尊重选择
	const [open, setOpen] = useState(running);
	const total = inbox.nextStep.length + inbox.nextTurn.length;
	if (total === 0 && !running) {
		return null;
	}
	return (
		<div className="mb-2 rounded-xl border border-border bg-secondary/40 px-3 py-2 text-xs">
			<div className="flex items-center gap-2 text-muted-foreground">
				<button
					type="button"
					className="flex min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:text-foreground"
					onClick={() => {
						setOpen((v) => !v);
					}}
				>
					{open ? (
						<ChevronDown className="size-3 shrink-0" />
					) : (
						<ChevronRight className="size-3 shrink-0" />
					)}
					{inbox.nextTurn.length > 0 && (
						<span>排队 ({inbox.nextTurn.length})</span>
					)}
					{inbox.nextStep.length > 0 && (
						<span>注入中 ({inbox.nextStep.length})</span>
					)}
					{total === 0 && <span>队列</span>}
				</button>
				{running && (
					<>
						<span className="size-1.5 animate-pulse rounded-full bg-brand" />
						<button
							type="button"
							className="flex size-6 items-center justify-center rounded-md text-destructive transition-colors hover:bg-accent"
							onClick={onCancel}
							aria-label="取消运行"
						>
							<Square className="size-3.5" />
						</button>
					</>
				)}
			</div>
			{open && total > 0 && (
				<ul className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto">
					{inbox.nextStep.map((m) => (
						<li key={m.id} className="flex items-center gap-2">
							<span className="shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-medium text-brand">
								注入中
							</span>
							<span className="min-w-0 truncate">{m.content}</span>
						</li>
					))}
					{inbox.nextTurn.map((m) => (
						<li key={m.id} className="group flex items-center gap-2">
							{/* 点击本体 = 转为 steer 注入（服务端从 next-turn 挪到 next-step） */}
							<button
								type="button"
								className="flex min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:text-foreground disabled:opacity-50"
								disabled={busy}
								title="点击转为 steer 注入"
								onClick={() => {
									onSteer(m.id);
								}}
							>
								<span className="min-w-0 truncate">{m.content}</span>
							</button>
							<button
								type="button"
								className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 disabled:opacity-50"
								disabled={busy}
								aria-label="移除排队消息"
								onClick={() => {
									onRemove(m.id);
								}}
							>
								<X className="size-3.5" />
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

interface ChatViewProps {
	state: ChatState;
	hasSession: boolean;
	welcome: boolean;
	prompts: PromptInfo[];
	// M4：内置指令（/help、/permission）200 {reply} 的本地气泡（App 持有，会话切换清空）
	notices: string[];
	// M4 新建会话首条消息创建失败（如 cwd 400）：composer 上方一行红字
	createError: string | null;
	// 当前会话 id（附件上传与 @ 补全的 fs/ls 依赖；welcome 态为 null）
	sessionId: string | null;
	permissionMode: PermissionMode;
	permissionBusy?: boolean;
	onPermissionChange: (mode: PermissionMode) => void;
	// 队列操作在途时禁用行操作（steer/移除单飞）
	queueBusy?: boolean;
	onSteerQueued: (messageId: string) => void;
	onRemoveQueued: (messageId: string) => void;
	onSend: (content: string) => void;
	onCancel: () => void;
	onApproval: (decision: "allow" | "deny") => void;
	// 审批应答提交中：审批条按钮转 loading 并禁用，防重复点击
	approvalBusy?: boolean;
	onPlanDecision: (
		decision: "approve" | "reject" | "annotate",
		note?: string,
	) => void;
}

export function ChatView({
	state,
	hasSession,
	welcome,
	prompts,
	notices,
	createError,
	sessionId,
	permissionMode,
	permissionBusy = false,
	onPermissionChange,
	queueBusy = false,
	onSteerQueued,
	onRemoveQueued,
	onSend,
	onCancel,
	onApproval,
	approvalBusy = false,
	onPlanDecision,
}: ChatViewProps): ReactElement {
	const scrollRef = useRef<HTMLDivElement>(null);

	// 新事件/流式增量到达时滚到底部（依赖即“活动计数”，effect 内无需读取）
	// biome-ignore lint/correctness/useExhaustiveDependencies: 滚动跟随活动计数，刻意不读具体值
	useEffect(() => {
		const el = scrollRef.current;
		if (el !== null) {
			el.scrollTop = el.scrollHeight;
		}
	}, [state.transcript.length, state.streaming]);

	// welcome 态（点“新建会话”后、首条消息前）：logo 与输入框垂直居中，不在列表新增会话
	if (welcome) {
		return (
			<main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 px-4">
				<div className="flex flex-col items-center gap-3">
					<img
						src="/logo.png"
						alt="hotpot"
						className="h-14 w-14 rounded-2xl object-contain"
					/>
					<span className="text-lg font-semibold tracking-tight">
						有什么可以帮你？
					</span>
				</div>
				<div className="w-full max-w-2xl">
					{createError !== null && (
						<div className="mb-2 text-center text-xs text-destructive">
							{createError}
						</div>
					)}
					<Composer
						tall
						running={false}
						prompts={prompts}
						hasSession={false}
						sessionId={null}
						permissionMode={permissionMode}
						permissionDisabled
						onPermissionChange={onPermissionChange}
						onSend={onSend}
					/>
				</div>
			</main>
		);
	}

	const groups = groupTranscript(state.transcript);
	const lastIndex = groups.length - 1;

	return (
		<main className="flex min-h-0 flex-1 flex-col">
			<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
					{groups.map((group, i) => (
						<TurnView
							key={group.id}
							group={group}
							isLast={i === lastIndex}
							streaming={state.streaming}
							pendingApproval={state.pendingApproval}
							pendingPlan={state.pendingPlan}
							onApproval={onApproval}
							approvalBusy={approvalBusy}
							onPlanDecision={onPlanDecision}
						/>
					))}
					{/* 内置指令回复的本地气泡：居中弱化文本行，不进对话流、不落库 */}
					{notices.map((notice, i) => (
						<div
							// 顺序追加、切换会话即清空，下标即可作 key
							// biome-ignore lint/suspicious/noArrayIndexKey: 只追加不重排，下标稳定
							key={i}
							className="whitespace-pre-wrap text-center text-xs text-muted-foreground"
						>
							{notice}
						</div>
					))}
				</div>
			</div>
			{hasSession && (
				<div className="px-4 pb-10 pt-2">
					<div className="mx-auto max-w-3xl">
						{createError !== null && (
							<div className="mb-2 text-xs text-destructive">{createError}</div>
						)}
						<QueueBar
							inbox={state.inbox}
							running={state.turn === "running"}
							busy={queueBusy}
							onCancel={onCancel}
							onSteer={onSteerQueued}
							onRemove={onRemoveQueued}
						/>
						<Composer
							running={state.turn === "running"}
							prompts={prompts}
							hasSession
							sessionId={sessionId}
							permissionMode={permissionMode}
							permissionDisabled={permissionBusy}
							onPermissionChange={onPermissionChange}
							onSend={onSend}
						/>
					</div>
				</div>
			)}
		</main>
	);
}
