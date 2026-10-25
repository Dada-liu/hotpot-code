// 工作区降级弹窗：仅在系统原生选择器不可用（501）时使用，直接展示手填路径输入。
// 保留 pick 模式（startInManual=false）供其他入口复用：
// - 选中目录 → POST /api/workspaces（重复路径返回既有记录）→ onCreated 后关闭；
// - 用户取消（path=null）→ 静默关闭；
// - 501 / picker-unavailable → 降级为手填路径（同一创建接口）；
// - 其他错误（路径非法、超时等）→ 行内红字 + 重试（重新打开选择器）。
// 系统对话框是模态的：选择期间浏览器请求保持在途，UI 显示等待态并禁用操作。

import { Loader2 } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	createWorkspace,
	PickerUnavailableError,
	pickDirectory,
	type WorkspaceWire,
} from "../api.ts";

type Phase = "picking" | "creating" | "manual" | "error";

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

interface WorkspacePickerDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated: (workspace: WorkspaceWire) => void;
	// true：打开即进入手填路径模式（宿主已确认没有原生选择器）
	startInManual?: boolean;
}

export function WorkspacePickerDialog({
	open,
	onOpenChange,
	onCreated,
	startInManual = false,
}: WorkspacePickerDialogProps): ReactElement {
	const [phase, setPhase] = useState<Phase>("picking");
	const [error, setError] = useState<string | null>(null);
	const [manualPath, setManualPath] = useState("");
	const [manualError, setManualError] = useState<string | null>(null);
	const [manualBusy, setManualBusy] = useState(false);
	// 重试计数：变化时重新触发目录选择 effect
	const [attempt, setAttempt] = useState(0);
	// 已启动的 attempt（StrictMode 下 effect 会执行两次，避免弹两个系统对话框）
	const startedFor = useRef<number | null>(null);
	// 每次打开/重试递增：关闭后作废在途请求的响应
	const requestGen = useRef(0);
	// 供异步回调读取最新打开状态（关闭后忽略迟到的响应）
	const openRef = useRef(open);

	// biome-ignore lint/correctness/useExhaustiveDependencies: 仅在打开/重试时触发；回调变化不重开选择器
	useEffect(() => {
		openRef.current = open;
		if (!open) {
			startedFor.current = null;
			requestGen.current += 1;
			return;
		}
		if (startedFor.current === attempt) {
			return;
		}
		startedFor.current = attempt;
		setManualError(null);
		// 降级入口：宿主已确认没有原生选择器，直接进入手填路径
		if (startInManual) {
			setPhase("manual");
			return;
		}
		const gen = requestGen.current + 1;
		requestGen.current = gen;
		const alive = (): boolean => requestGen.current === gen;
		setPhase("picking");
		setError(null);
		void pickDirectory()
			.then(async ({ path }) => {
				if (!alive()) {
					return;
				}
				if (path === null) {
					// 用户取消：静默关闭
					onOpenChange(false);
					return;
				}
				setPhase("creating");
				try {
					const { workspace } = await createWorkspace(path);
					if (!alive()) {
						return;
					}
					onCreated(workspace);
					onOpenChange(false);
				} catch (e) {
					if (!alive()) {
						return;
					}
					setError(errorMessage(e));
					setPhase("error");
				}
			})
			.catch((e: unknown) => {
				if (!alive()) {
					return;
				}
				if (e instanceof PickerUnavailableError) {
					setPhase("manual");
					return;
				}
				setError(errorMessage(e));
				setPhase("error");
			});
	}, [open, attempt]);

	const submitManual = async (): Promise<void> => {
		const path = manualPath.trim();
		if (path === "") {
			setManualError("请输入目录路径");
			return;
		}
		if (manualBusy) {
			return;
		}
		setManualBusy(true);
		setManualError(null);
		try {
			const { workspace } = await createWorkspace(path);
			if (!openRef.current) {
				return;
			}
			onCreated(workspace);
			onOpenChange(false);
		} catch (e) {
			setManualError(errorMessage(e));
		} finally {
			setManualBusy(false);
		}
	};

	// 系统选择器/创建请求在途时禁止关闭（X、遮罩、Esc 都走这里）；
	// 取消选择与成功关闭由异步回调直接调用 onOpenChange
	const handleOpenChange = (next: boolean): void => {
		if (!next && (phase === "picking" || phase === "creating" || manualBusy)) {
			return;
		}
		onOpenChange(next);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>添加工作区</DialogTitle>
					<DialogDescription>
						工作区用于在侧栏按目录分组会话；不会创建或修改文件夹。
					</DialogDescription>
				</DialogHeader>
				{phase === "picking" && (
					<div className="flex flex-col items-center gap-3 py-8 text-sm text-muted-foreground">
						<Loader2 className="size-5 animate-spin text-brand" />
						系统目录选择器已打开…
						<p className="text-xs">
							系统对话框为模态窗口，请完成选择或取消后返回。
						</p>
					</div>
				)}
				{phase === "creating" && (
					<div className="flex flex-col items-center gap-3 py-8 text-sm text-muted-foreground">
						<Loader2 className="size-5 animate-spin text-brand" />
						正在添加工作区…
					</div>
				)}
				{phase === "manual" && (
					<>
						<div className="flex flex-col gap-2">
							<p className="text-sm text-muted-foreground">
								当前环境无法打开系统目录选择器，请手动输入目录路径
							</p>
							<Input
								value={manualPath}
								disabled={manualBusy}
								onChange={(e) => {
									setManualPath(e.target.value);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										void submitManual();
									}
								}}
								placeholder="/path/to/workspace"
								autoFocus
							/>
							{manualError !== null && (
								<p className="text-xs text-destructive">{manualError}</p>
							)}
						</div>
						<DialogFooter>
							<Button
								variant="ghost"
								disabled={manualBusy}
								onClick={() => {
									onOpenChange(false);
								}}
							>
								取消
							</Button>
							<Button
								disabled={manualBusy}
								onClick={() => {
									void submitManual();
								}}
							>
								{manualBusy ? "添加中…" : "添加"}
							</Button>
						</DialogFooter>
					</>
				)}
				{phase === "error" && (
					<>
						<div className="flex flex-col gap-2">
							<p className="text-sm text-destructive">{error}</p>
							<p className="text-xs text-muted-foreground">
								可重试打开系统目录选择器，或取消后稍后再试。
							</p>
						</div>
						<DialogFooter>
							<Button
								variant="ghost"
								onClick={() => {
									onOpenChange(false);
								}}
							>
								取消
							</Button>
							<Button
								onClick={() => {
									setAttempt((a) => a + 1);
								}}
							>
								重试
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
