import { type ComponentProps, forwardRef } from "react";
import { cn } from "@/lib/utils";

// React 18 下函数组件不会收到 ref（也不会透传给内部 textarea）：
// composer 的 @ 补全依赖 textareaRef 读光标与 value，必须 forwardRef。
const Textarea = forwardRef<HTMLTextAreaElement, ComponentProps<"textarea">>(
	({ className, ...props }, ref) => (
		<textarea
			ref={ref}
			data-slot="textarea"
			className={cn(
				"flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:ring-destructive/40",
				className,
			)}
			{...props}
		/>
	),
);
Textarea.displayName = "Textarea";

export { Textarea };
