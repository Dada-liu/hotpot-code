// 与服务端 wire.ts 的契约镜像，改动需双侧同步。
// 本包不依赖 @hotpot/core（避免把 node 包拖进 vite 解析），
// 这里只镜像 UI 需要的字段子集，结构上与 server/src/wire.ts 保持一致。

// 消息内容块（core ContentBlock 的子集：文本与工具调用；
// tool_result 块不落会话事件，结果走 tool_result 事件按 toolCallId 配对）
export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "tool_call"; id: string; name: string; input: unknown };

// steer/queue 队列消息（inbox/spliced 与 GET /inbox 共用形状）
export interface InboxMessage {
	id: string;
	content: string;
}

export interface InboxSnapshot {
	nextTurn: InboxMessage[];
	nextStep: InboxMessage[];
}

// todo 工具任务项：todo/set 事件携带全量快照，last-write-wins 折叠
export interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed";
}

// M3 权限模式（core PermissionMode 的镜像）：readonly 读放行 / ask-on-dangerous 危险操作询问 / full 全放行
export type PermissionMode = "readonly" | "ask-on-dangerous" | "full";

// POST /:id/uploads 响应：上传后的绝对路径（消息内以 @<path> 引用）
export interface UploadResponse {
	path: string;
}

// GET /:id/fs/ls 目录项：path 为绝对路径（kind 只有 file|dir）
export interface FsEntry {
	name: string;
	path: string;
	kind: "file" | "dir";
}

// GET /:id 会话详情响应（UI 用到的字段子集；M3 起带权限模式初始档位）
export interface SessionDetail {
	id: string;
	cwd: string;
	createdAt: string;
	turn: "running" | "idle";
	permissionMode: PermissionMode;
}

// 会话事件（SessionEvent 联合的镜像子集）
export type SessionEvent =
	// meta 是文件首行，无 id/ts
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
	// 编排层内部延续提示：进入模型历史，但 UI 不渲染
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
			// server 侧 usage/tier 恒有；镜像为可选以兼容历史日志与测试构造
			// （tier 默认语义与 core 一致：默认视为 "high"）
			usage?: { input: number; output: number };
			tier?: string;
	  }
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
			tier: string;
	  }
	// agent_end：下层 agent turn 收尾落盘；reducer 据此翻转右侧面板卡片状态（failed 不回退）
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
			queue: "next-turn" | "next-step";
			messages: InboxMessage[];
	  }
	// M3 权限模式切换审计：仅审计与恢复用，UI 不渲染（与 hook/fired 同待遇）
	| {
			type: "permission/changed";
			id: string;
			ts: string;
			mode: PermissionMode;
			source: "user" | "settings";
	  }
	// M4 新增事件（与 core/src/session/events.ts 逐字段一致；UI 不渲染，按 id 去重即可）
	| {
			type: "todo/set";
			id: string;
			ts: string;
			agentId: string;
			todos: TodoItem[];
	  }
	| {
			type: "hook/fired";
			id: string;
			ts: string;
			agentId?: string;
			hook: "session_start" | "pre_tool" | "post_tool" | "turn_end";
			command: string;
			exitCode: number;
			durationMs: number;
	  }
	| {
			type: "skill/loaded";
			id: string;
			ts: string;
			agentId: string;
			skill: string;
			path: string;
	  }
	| {
			type: "prompt/invoked";
			id: string;
			ts: string;
			agentId: "main";
			name: string;
			args: string;
			content: string;
	  }
	| {
			type: "mcp/attached";
			id: string;
			ts: string;
			server: string;
			transport: "stdio" | "http";
			tools: string[];
	  }
	| {
			type: "error";
			id: string;
			ts: string;
			agentId: string;
			code: string;
			message: string;
	  };

// 与服务端 wire.ts 的契约镜像，改动需双侧同步（事件定义逐字段照抄）
export type WireEvent =
	| { seq: number; kind: "log"; event: SessionEvent }
	| { seq: number; kind: "delta"; agentId: string; text: string }
	| {
			seq: number;
			kind: "turn";
			phase: "start" | "end";
			stopReason?: string;
			error?: string;
	  }
	| {
			seq: number;
			kind: "plan";
			phase: "drafted" | "approved" | "denied" | "revision_exhausted";
			plan?: string;
			// 计划正文所在的 assistant_msg id：渲染时隐藏正文气泡，只保留计划卡片
			messageIds?: string[];
	  }
	| {
			seq: number;
			kind: "spawn";
			agentId: string;
			role: "worker" | "task";
			tier: string;
			task: string;
			parentAgentId: string;
	  }
	| {
			seq: number;
			kind: "approval";
			requestId: string;
			approvalType: "tool" | "plan";
			summary: string;
			detail?: string;
			plan?: string;
	  }
	// M3 权限模式切换瞬态：落在 durable permission/changed 之后到达
	| {
			seq: number;
			kind: "permission";
			mode: PermissionMode;
	  };
