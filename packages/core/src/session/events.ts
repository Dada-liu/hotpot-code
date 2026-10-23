// 会话事件类型（v1 定稿）：字段对齐 docs/archive/02-architecture.md 第 5 节
// M1 只写入 meta/user_msg/assistant_msg/tool_call/tool_result/error；
// M2 起 agent_spawn、approval/*、inbox/spliced 已由编排层（packages/orchestrator）产出。
// M4 新增 todo/set、hook/fired、skill/loaded、prompt/invoked、mcp/attached 五个变体
// （功能开关/钩子/skill/prompt 模板/MCP 挂载的落盘记录，均不进模型历史，
// 与 inbox/spliced 同待遇——deriveMessages 不折叠，由各自 fold 纯函数重建状态）。
// agent_end 为下层 agent turn 收尾事件（web 卡片状态数据源），同样不进模型历史。
// permission/changed 为权限模式切换审计（M1），亦不进模型历史。
// internal_msg 为编排层内部延续提示（如 plan 起草/批准 kickoff）：deriveMessages 按
// user 角色折入模型历史，但不属于用户输入，UI 不渲染（与 user_msg 区分）。
// 文档第 5 节还列了 turn/start|turn/end 与 request_header，M1 暂不需要，未纳入本联合。
// 契约纪律：只允许新增变体，既有变体字段不改（v1 定稿，未来真需要变更走 v2 迁移）。

import type { ContentBlock, Usage } from "@hotpot/ai";
import type { PermissionMode } from "../config/config.ts";

// 模型档位：主 agent 固定 high，worker/task 按难度路由（docs/archive/03-agent-orchestration.md 第 8 节）
export type ModelTier = "high" | "medium" | "low";

// steer 队列：next-turn 排队等 turn 结束，next-step 当前 step 结束即注入
export type InboxQueue = "next-turn" | "next-step";

// inbox/spliced 携带的排队消息；带 id 以便崩溃恢复后去重
export type InboxMessage = { id: string; content: string };

// M4 todo 工具的任务项：todo/set 携带全量列表快照（last-write-wins fold）
export type TodoItem = {
	content: string;
	status: "pending" | "in_progress" | "completed";
};

// M4 钩子事件：配置键为 Claude Code 形状（SessionStart/PreToolUse/PostToolUse/Stop），
// Stop 映射为 turn_end；HookEvent 供 hook/fired 事件与 Task 7 的 HookChain 共用
export type HookEvent = "session_start" | "pre_tool" | "post_tool" | "turn_end";

export type SessionEvent =
	// meta 是文件首行，无 id/ts；formatVersion 恒为 1，真出现 v2 需求时再加迁移
	| {
			type: "meta";
			sessionId: string;
			createdAt: string;
			cwd: string;
			formatVersion: 1;
	  }
	| {
			type: "user_msg";
			id: string;
			ts: string;
			agentId: string;
			content: string;
	  }
	// 内部延续提示：由编排层写入、进入模型历史，但不是用户输入，UI 不展示
	| {
			type: "internal_msg";
			id: string;
			ts: string;
			agentId: string;
			content: string;
	  }
	| {
			type: "assistant_msg";
			id: string;
			ts: string;
			agentId: string;
			content: ContentBlock[];
			usage: Usage;
			model: string;
			tier: ModelTier;
	  }
	| {
			type: "tool_call";
			id: string;
			ts: string;
			agentId: string;
			name: string;
			input: unknown;
	  }
	// tool_result 通过 toolCallId 关联上游调用；agentId 标记结果归属（derive 按它过滤）。
	// 默认 "main"：M1 旧日志的 tool_result 无此字段，视为主 agent 的结果（向后兼容）
	| {
			type: "tool_result";
			id: string;
			ts: string;
			agentId?: string;
			toolCallId: string;
			content: string;
			isError: boolean;
	  }
	| {
			type: "agent_spawn";
			id: string;
			ts: string;
			parentAgentId: string;
			agentId: string;
			role: string;
			task: string;
			tier: ModelTier;
	  }
	// agent_end：下层 agent（worker/task）内联 turn 收尾时由编排层落盘（outcome 由
	// abort/error/无 summary 判定）；web 右侧面板据此翻转卡片状态（failed 不回退），
	// 与 todo/set 同待遇——不进模型历史，derive 不折叠
	| {
			type: "agent_end";
			id: string;
			ts: string;
			agentId: string;
			outcome: "done" | "failed";
	  }
	| {
			type: "approval/asked";
			id: string;
			ts: string;
			agentId: string;
			payload: Record<string, unknown>;
	  }
	// note 为可选审批备注（如拒绝理由）；audited 包装层不填，编排层 plan 流程自行 append 时使用
	| {
			type: "approval/decided";
			id: string;
			ts: string;
			requestId: string;
			decision: "approved" | "denied";
			note?: string;
	  }
	| {
			type: "inbox/spliced";
			id: string;
			ts: string;
			agentId: string;
			queue: InboxQueue;
			messages: InboxMessage[];
	  }
	// —— M4 新增变体（start）：均不进模型历史，derive 不折叠 ——
	// todo/set：todo 工具的全量列表快照（last-write-wins fold 重建当前清单）
	| {
			type: "todo/set";
			id: string;
			ts: string;
			agentId: string;
			todos: TodoItem[];
	  }
	// hook/fired：钩子命令执行记录；agentId 可选（session_start 等会话级钩子无归属 agent）
	| {
			type: "hook/fired";
			id: string;
			ts: string;
			agentId?: string;
			hook: HookEvent;
			command: string;
			exitCode: number;
			durationMs: number;
	  }
	// skill/loaded：模型经 read 加载了某个 SKILL.md（skill 渐进式的加载落盘）
	| {
			type: "skill/loaded";
			id: string;
			ts: string;
			agentId: string;
			skill: string;
			path: string;
	  }
	// prompt/invoked：/命令 模板展开记录；只有 main agent 发起，agentId 恒为 "main"
	| {
			type: "prompt/invoked";
			id: string;
			ts: string;
			agentId: "main";
			name: string;
			args: string;
			content: string;
	  }
	// mcp/attached：MCP server 挂载记录（会话级，无 agentId）；tools 为桥接后的工具名列表
	| {
			type: "mcp/attached";
			id: string;
			ts: string;
			server: string;
			transport: "stdio" | "http";
			tools: string[];
	  }
	// permission/changed：权限模式切换记录（用户经 UI 改写 runtime 持有者，或 settings 装配初始化），
	// 仅审计与恢复用——不进模型历史，derive 不折叠，reducer 不渲染（与 agent_end 同待遇）
	| {
			type: "permission/changed";
			id: string;
			ts: string;
			mode: PermissionMode;
			source: "user" | "settings";
	  }
	| {
			type: "error";
			id: string;
			ts: string;
			agentId: string;
			code: string;
			message: string;
	  };
