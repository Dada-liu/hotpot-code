// M4 Feature③：权限切换器——composer 左下角 Shield 图标 + 弹层三档单选。
// 当前档位取自 chat.permissionMode；点击由 App 乐观更新 + PUT /permission，
// wire permission 事件是最终权威（弹层只读展示，不写服务端）。
// 弹层文案只用中文：只读 / 危险操作询问 / 完全权限 + 一行解释，不展示内部枚举值。
// 无会话（welcome 态）或请求在途时禁用，防误触与并发改写。

import { Check, Shield } from "lucide-react";
import {
	type ReactElement,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { PermissionMode } from "../api.ts";

// 三档说明文案（与 core 审批语义对应；内部枚举值不展示）
const MODES: { mode: PermissionMode; label: string; hint: string }[] = [
	{
		mode: "readonly",
		label: "只读",
		hint: "读自动放行，其余操作需逐个审批",
	},
	{
		mode: "ask-on-dangerous",
		label: "危险操作询问",
		hint: "遇到危险操作时询问",
	},
	{
		mode: "full",
		label: "完全权限",
		hint: "全部自动放行，永不打断",
	},
];

export function PermissionSelect({
	mode,
	disabled = false,
	onChange,
}: {
	mode: PermissionMode;
	disabled?: boolean;
	onChange: (mode: PermissionMode) => void;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);

	// 点击弹层外 / Escape 关闭
	useEffect(() => {
		if (!open) {
			return;
		}
		const onPointerDown = (e: PointerEvent): void => {
			if (
				rootRef.current !== null &&
				!rootRef.current.contains(e.target as Node)
			) {
				setOpen(false);
			}
		};
		const onKeyDown = (e: KeyboardEvent): void => {
			if (e.key === "Escape") {
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	const pick = useCallback(
		(next: PermissionMode): void => {
			setOpen(false);
			if (next !== mode) {
				onChange(next);
			}
		},
		[mode, onChange],
	);

	return (
		<div ref={rootRef} className="relative shrink-0">
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="rounded-full"
						disabled={disabled}
						onClick={() => {
							setOpen((v) => !v);
						}}
						aria-label="权限模式"
					>
						<Shield className="size-4" />
					</Button>
				</TooltipTrigger>
				{/* 图标按钮规则：气泡紧贴 svg 上方（sideOffset=0，见 web AGENTS.md） */}
				<TooltipContent side="top" sideOffset={0}>
					权限模式
				</TooltipContent>
			</Tooltip>
			{open && (
				<div className="absolute bottom-full left-0 z-20 mb-2 w-72 overflow-hidden rounded-xl border border-border-strong bg-background shadow-lg shadow-black/5">
					<div className="border-b px-4 py-2 text-xs font-medium text-muted-foreground">
						权限模式
					</div>
					{MODES.map(({ mode: m, label, hint }) => (
						<button
							key={m}
							type="button"
							className="flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-secondary"
							onClick={() => {
								pick(m);
							}}
						>
							<span
								className={cn(
									"mt-0.5 flex size-4 shrink-0 items-center justify-center",
									m === mode ? "text-brand" : "text-transparent",
								)}
							>
								<Check className="size-4" />
							</span>
							<span className="flex min-w-0 flex-col gap-0.5">
								<span className="text-sm">{label}</span>
								<span className="text-xs text-muted-foreground">{hint}</span>
							</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}
