// 右侧面板：只展示 work / task agent 卡片（main agent 不展示）。显隐由 App 控制：
// worker 运行期间自动展示（可用顶栏开关/头部 X 收起），全部任务完成即整体消失；无空态。
// 卡片状态（running/done/failed）数据源：durable 的 agent_end 日志事件（failed 不回退），
// log(error) 即时标 failed；turn(end) 不翻转 agent 状态
// 卡片 = 状态感头像（运行中切 *_active.webp 动图）+ 前端派生的短显示名（限 10 字符）
// + role/tier/状态徽标 + todo 清单 + 当前工具；task 卡片渲染在所属 worker 卡片内部
// （左边线 + 缩进 + 弱化底色）；点击卡片头部区域弹出详情弹窗：
// 任务提示词全文 + 该 agent 的实时输出（复用主对话区 TranscriptItem）。

import { Check, Circle, Loader2, Wrench, X } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { agentNameFromTask } from "@/lib/session-name";
import { cn } from "@/lib/utils";
import type { TodoItem } from "../protocol.ts";
import type {
	AgentNode,
	AgentStatus,
	TranscriptEntry,
	UsageTotals,
} from "../state/reducer.ts";
import { TranscriptItem } from "./ChatView.tsx";

interface AgentPanelProps {
	agents: AgentNode[];
	usage: UsageTotals;
	open: boolean;
	sessionName: string;
	// agent 详情弹窗按 agentId 过滤主 transcript 复用渲染（SSE 实时追加）
	transcript: TranscriptEntry[];
	// todo 工具清单：按 agentId 折叠的快照（todo/set 实时更新）
	todosByAgent: Record<string, TodoItem[]>;
	onToggle: () => void;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

// token 数紧凑格式：1234 → 1.2k
function compact(n: number): string {
	if (n >= 1000) {
		return `${(n / 1000).toFixed(1)}k`;
	}
	return String(n);
}

// 卡片显示名：前端按同一规则从任务描述派生（限 10 字符），空结果回退 agentId
function displayName(node: AgentNode): string {
	return agentNameFromTask(node.task) || node.agentId;
}

// 头像：加载失败回退为首字母圆点
function Avatar({
	src,
	label,
	className,
}: {
	src: string;
	label: string;
	className?: string;
}): ReactElement {
	const [broken, setBroken] = useState(false);
	if (broken) {
		return (
			<span
				className={cn(
					"flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-muted-foreground",
					className,
				)}
				aria-hidden="true"
			>
				{label.slice(0, 1).toUpperCase()}
			</span>
		);
	}
	return (
		<img
			className={cn(
				"size-9 shrink-0 rounded-full bg-secondary object-cover",
				className,
			)}
			src={src}
			alt={label}
			onError={() => {
				setBroken(true);
			}}
		/>
	);
}

// 状态徽标：running 橙色转圈 / done 黑勾 / failed 深橙
function StatusBadge({ status }: { status: AgentStatus }): ReactElement {
	if (status === "running") {
		return (
			<Badge
				variant="outline"
				className="gap-1 border-brand/30 bg-brand-soft text-[11px] text-brand"
			>
				<Loader2 className="size-3 animate-spin" />
				running
			</Badge>
		);
	}
	if (status === "failed") {
		return (
			<Badge variant="destructive" className="text-[11px]">
				failed
			</Badge>
		);
	}
	return (
		<Badge variant="secondary" className="gap-1 text-[11px]">
			<Check className="size-3" />
			done
		</Badge>
	);
}

// worker/task 形象图按运行状态切换 active 版本
function nodeAvatarSrc(node: AgentNode): string {
	const active = node.status === "running";
	if (node.role === "task") {
		return active ? "/task_agent_active.webp" : "/task_agent.png";
	}
	return active ? "/work_agent_active.webp" : "/work_agent.png";
}

function roleBadgeClass(isTask: boolean): string {
	return cn(
		"text-[10px] font-normal",
		isTask ? "text-muted-foreground" : "border-brand/30 text-brand",
	);
}

// role/tier/状态徽标组
function NodeBadges({ node }: { node: AgentNode }): ReactElement {
	const isTask = node.role === "task";
	return (
		<div className="mt-1 flex flex-wrap items-center gap-1.5">
			<Badge variant="outline" className={roleBadgeClass(isTask)}>
				{isTask ? "Task" : "Worker"}
			</Badge>
			<Badge
				variant="outline"
				className="text-[10px] font-normal text-muted-foreground"
			>
				{node.tier}
			</Badge>
			<StatusBadge status={node.status} />
		</div>
	);
}

// todo 工具清单：状态栏下方实时渲染（todo/set 快照驱动）。
// pending 空心圆 / in_progress 橙色转圈 / completed 黑勾删除线
function TodoList({ todos }: { todos: TodoItem[] }): ReactElement {
	return (
		<ul className="mt-1.5 flex flex-col gap-1 border-t border-dashed pt-1.5">
			{todos.map((t) => (
				<li
					key={t.content}
					className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
					title={t.content}
				>
					{t.status === "completed" ? (
						<Check className="size-3 shrink-0 text-foreground" />
					) : t.status === "in_progress" ? (
						<Loader2 className="size-3 shrink-0 animate-spin text-brand" />
					) : (
						<Circle className="size-3 shrink-0" />
					)}
					<span
						className={cn(
							"truncate",
							t.status === "completed" && "line-through",
						)}
					>
						{t.content}
					</span>
				</li>
			))}
		</ul>
	);
}

// 单个 agent 卡片：头部区域（头像/名字/徽标/todo 清单/当前工具）点击弹出详情；
// 子 agent（task）渲染在卡片内部，作为本卡片的一部分表达层级
function AgentCard({
	node,
	agents,
	todosByAgent,
	onSelect,
}: {
	node: AgentNode;
	agents: AgentNode[];
	todosByAgent: Record<string, TodoItem[]>;
	onSelect: (agentId: string) => void;
}): ReactElement {
	const running = node.status === "running";
	const isTask = node.role === "task";
	const name = displayName(node);
	const todos = todosByAgent[node.agentId];
	const children = agents.filter((a) => a.parentAgentId === node.agentId);
	const openDetail = (): void => {
		onSelect(node.agentId);
	};
	return (
		<Card
			className={cn(
				"gap-2 rounded-xl p-3",
				isTask ? "bg-secondary/50" : "bg-card",
				running && "border-brand/50 shadow-sm",
			)}
		>
			{/* 头部区域：整段可点（含 task 子卡片时也只有头部打开本 agent 详情） */}
			<button
				type="button"
				onClick={openDetail}
				className="block w-full cursor-pointer rounded-lg bg-transparent text-left transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
			>
				<div className="flex items-start gap-2.5">
					<Avatar
						src={nodeAvatarSrc(node)}
						label={node.role}
						className={cn(
							isTask && "size-8",
							running && "ring-2 ring-brand/40",
						)}
					/>
					<div className="min-w-0 flex-1">
						<div
							className="truncate text-[13px] font-medium leading-snug"
							title={name}
						>
							{truncate(name, 42)}
						</div>
						<NodeBadges node={node} />
					</div>
				</div>
				{todos !== undefined && todos.length > 0 && <TodoList todos={todos} />}
				{node.currentTool !== undefined && (
					<div className="mt-1.5 flex items-center gap-1.5 border-t border-dashed pt-1.5 text-[11px] text-muted-foreground">
						<Wrench className="size-3 shrink-0" />
						<span className="truncate font-mono" title={node.currentTool}>
							{truncate(node.currentTool, 30)}
						</span>
					</div>
				)}
			</button>
			{children.length > 0 && (
				/* task 子卡片：左边线 + 缩进，视觉上并入 worker 卡片 */
				<div className="ml-1 flex flex-col gap-2 border-l-2 border-border/70 pl-2.5">
					{children.map((child) => (
						<AgentCard
							key={child.agentId}
							node={child}
							agents={agents}
							todosByAgent={todosByAgent}
							onSelect={onSelect}
						/>
					))}
				</div>
			)}
		</Card>
	);
}

// agent 详情弹窗内容：头部（头像/名字/徽标）+ 任务提示词全文 + 按 agentId 过滤的实时输出。
// plan/approval 条目无 agentId 字段且为 main 专属；子 agent 的 transcript 不会出现，传空即可
function AgentDetail({
	node,
	transcript,
}: {
	node: AgentNode;
	transcript: TranscriptEntry[];
}): ReactElement {
	const running = node.status === "running";
	const name = displayName(node);
	const entries = transcript.filter(
		(e) =>
			e.kind !== "plan" && e.kind !== "approval" && e.agentId === node.agentId,
	);
	return (
		<div className="flex flex-col gap-3">
			<DialogTitle className="sr-only">{name}</DialogTitle>
			<Card className="gap-2.5 rounded-xl p-3">
				<div className="flex items-start gap-2.5">
					<Avatar
						src={nodeAvatarSrc(node)}
						label={node.role}
						className={cn("size-10", running && "ring-2 ring-brand/40")}
					/>
					<div className="min-w-0 flex-1">
						<div className="truncate text-sm font-medium" title={name}>
							{name}
						</div>
						<div className="font-mono text-[10px] text-muted-foreground">
							{node.agentId}
						</div>
						<NodeBadges node={node} />
					</div>
				</div>
				{running && node.currentTool !== undefined && (
					<div className="flex items-center gap-1.5 border-t border-dashed pt-2 text-[11px] text-muted-foreground">
						<Wrench className="size-3 shrink-0" />
						<span className="truncate font-mono" title={node.currentTool}>
							{truncate(node.currentTool, 34)}
						</span>
					</div>
				)}
			</Card>
			<Card className="gap-1.5 rounded-xl bg-secondary/50 p-3">
				<div className="text-[11px] font-medium text-muted-foreground">
					任务提示词
				</div>
				<div className="whitespace-pre-wrap break-words text-xs leading-relaxed">
					{node.task}
				</div>
			</Card>
			<div className="flex flex-col gap-2">
				<div className="text-[11px] font-medium text-muted-foreground">
					实时输出
				</div>
				{entries.length > 0 ? (
					<div className="flex flex-col gap-2.5">
						{entries.map((entry) => (
							<TranscriptItem
								key={entry.id}
								entry={entry}
								pendingPlan={null}
								onPlanDecision={() => undefined}
							/>
						))}
					</div>
				) : (
					<div className="py-3 text-center text-xs text-muted-foreground">
						{running ? "等待输出…" : "无输出"}
					</div>
				)}
			</div>
		</div>
	);
}

export function AgentPanel({
	agents,
	usage,
	open,
	sessionName,
	transcript,
	todosByAgent,
	onToggle,
}: AgentPanelProps): ReactElement | null {
	// 详情弹窗选中的 agent；会话切换时 App 以 key 重建本组件，状态自然归零
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const selected = selectedId
		? (agents.find((a) => a.agentId === selectedId) ?? null)
		: null;
	// 显隐由 App 控制：worker 运行期间展示（可收起），全部完成即隐藏；无空态
	if (!open) {
		return null;
	}
	return (
		<aside className="flex h-full w-80 shrink-0 flex-col border-l bg-secondary/40">
			<div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
				<img
					src="/main_agent.png"
					alt="main agent"
					className="size-9 rounded-md object-cover"
				/>
				<span
					className="min-w-0 flex-1 truncate text-sm font-medium"
					title={sessionName}
				>
					{truncate(sessionName, 22)}
				</span>
				<Button
					variant="ghost"
					size="icon"
					className="size-8"
					onClick={onToggle}
					aria-label="收起面板"
				>
					<X className="size-4" />
				</Button>
			</div>
			<ScrollArea className="min-h-0 flex-1">
				<div className="flex flex-col gap-2.5 p-3">
					{agents
						.filter((a) => a.parentAgentId === "main")
						.map((node) => (
							<AgentCard
								key={node.agentId}
								node={node}
								agents={agents}
								todosByAgent={todosByAgent}
								onSelect={setSelectedId}
							/>
						))}
				</div>
			</ScrollArea>
			{/* 用量卡片：按 tier 分组 */}
			<div className="shrink-0 p-3 pt-0">
				<Card className="gap-1.5 rounded-xl p-3 text-xs">
					<div className="text-[11px] font-medium text-muted-foreground">
						用量
					</div>
					{Object.entries(usage.byTier).map(([tier, bucket]) => (
						<div key={tier} className="flex items-center justify-between gap-2">
							<span className="font-mono text-[11px] text-muted-foreground">
								{tier}
							</span>
							<span className="font-mono text-[11px]">
								in {compact(bucket.input)} · out {compact(bucket.output)} ·{" "}
								{bucket.count} 次
							</span>
						</div>
					))}
					<div className="mt-1 flex items-center justify-between gap-2 border-t border-dashed pt-1.5">
						<span className="font-mono text-[11px] font-medium">total</span>
						<span className="font-mono text-[11px] font-medium">
							in {compact(usage.total.input)} · out{" "}
							{compact(usage.total.output)}
						</span>
					</div>
				</Card>
			</div>
			<Dialog
				open={selected !== null}
				onOpenChange={(next) => {
					if (!next) {
						setSelectedId(null);
					}
				}}
			>
				<DialogContent className="max-h-[80vh] gap-0 overflow-y-auto sm:max-w-xl">
					{selected !== null && (
						<AgentDetail node={selected} transcript={transcript} />
					)}
				</DialogContent>
			</Dialog>
		</aside>
	);
}
