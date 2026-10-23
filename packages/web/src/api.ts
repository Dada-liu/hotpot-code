// REST client：与 server/src/app.ts 的路由契约一一对应。
// 错误统一抛出带服务端 message 的 Error，由调用方（App）兜底展示。

import type {
	FsEntry,
	InboxSnapshot,
	PermissionMode,
	UploadResponse,
} from "./protocol.ts";

export type { FsEntry, InboxSnapshot, PermissionMode } from "./protocol.ts";

export interface SessionSummary {
	id: string;
	cwd: string;
	createdAt: string;
	turn: "running" | "idle";
}

// GET /api/sessions/:id/usage 的响应镜像（server usage.ts UsageSummary 的子集）
export interface UsageSummary {
	total: { input: number; output: number };
	byTier: Record<string, { input: number; output: number; count: number }>;
	byAgent: Record<string, { input: number; output: number }>;
	// M4 功能用量（开关 + 事件/工具调用计数）
	features: Record<
		string,
		{ enabled: boolean; events: number; toolCalls: number }
	>;
}

// GET /api/sessions/:id/prompts 的响应项（M4 prompt templates）
// M3：builtin 标记区分内置指令（/help、/permission）与 prompt templates，`/` 菜单据此分组
export interface PromptInfo {
	name: string;
	description: string;
	builtin: boolean;
}

// 非 2xx 统一抛出带服务端 message 的 Error；2xx 直接返回（不读响应体）
async function ensureOk(res: Response): Promise<void> {
	if (res.ok) {
		return;
	}
	let message = `HTTP ${res.status}`;
	try {
		const body = (await res.json()) as { error?: unknown };
		if (typeof body.error === "string") {
			message = body.error;
		}
	} catch {
		// 非 JSON 错误体：保留状态码作为 message
	}
	throw new Error(message);
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
	const res = await fetch(path, init);
	await ensureOk(res);
	return res.json();
}

function post(path: string, body?: unknown): Promise<unknown> {
	return request(path, {
		method: "POST",
		headers:
			body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

function put(path: string, body: unknown): Promise<unknown> {
	return request(path, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

// DELETE 常无响应体（204）：只走状态检查，失败抛出带服务端 message 的 Error
async function del(path: string): Promise<void> {
	const res = await fetch(path, { method: "DELETE" });
	await ensureOk(res);
}

export async function listSessions(): Promise<SessionSummary[]> {
	const body = (await request("/api/sessions")) as {
		sessions: SessionSummary[];
	};
	return body.sessions;
}

export async function createSession(cwd?: string): Promise<string> {
	const body = (await post(
		"/api/sessions",
		cwd === undefined ? {} : { cwd },
	)) as {
		id: string;
	};
	return body.id;
}

// DELETE 无响应体（204）：只走状态检查，失败抛出带服务端 message 的 Error
export async function deleteSession(sessionId: string): Promise<void> {
	const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
		method: "DELETE",
	});
	await ensureOk(res);
}

// 归档：结束运行中的回合并全部落盘，服务端摘托管但保留磁盘日志
export async function archiveSession(sessionId: string): Promise<void> {
	await post(`/api/sessions/${encodeURIComponent(sessionId)}/archive`);
}

// POST messages：普通输入 202（消息挂进 turn 串行链，响应体 {}）；
// 内置指令命中 200 {reply}——回复由客户端渲染本地 notice 气泡，不进对话流
export async function sendMessage(
	sessionId: string,
	content: string,
): Promise<{ reply?: string }> {
	return (await post(
		`/api/sessions/${encodeURIComponent(sessionId)}/messages`,
		{
			content,
		},
	)) as { reply?: string };
}

export async function steerMessage(
	sessionId: string,
	content: string,
): Promise<void> {
	await post(`/api/sessions/${encodeURIComponent(sessionId)}/steer`, {
		content,
	});
}

export async function cancelTurn(sessionId: string): Promise<void> {
	await post(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`);
}

export async function answerApproval(
	sessionId: string,
	requestId: string,
	decision: "allow" | "deny",
): Promise<void> {
	await post(
		`/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(requestId)}`,
		{ decision },
	);
}

export async function answerPlan(
	sessionId: string,
	decision: "approve" | "reject" | "annotate",
	note?: string,
): Promise<void> {
	await post(`/api/sessions/${encodeURIComponent(sessionId)}/plan`, {
		decision,
		...(note === undefined ? {} : { note }),
	});
}

export async function getUsage(sessionId: string): Promise<UsageSummary> {
	return (await request(
		`/api/sessions/${encodeURIComponent(sessionId)}/usage`,
	)) as UsageSummary;
}

export async function listPrompts(sessionId: string): Promise<PromptInfo[]> {
	const body = (await request(
		`/api/sessions/${encodeURIComponent(sessionId)}/prompts`,
	)) as { prompts: PromptInfo[] };
	return body.prompts;
}

export async function getInbox(sessionId: string): Promise<InboxSnapshot> {
	return (await request(
		`/api/sessions/${encodeURIComponent(sessionId)}/inbox`,
	)) as InboxSnapshot;
}

// M3 权限模式：GET 是权威（服务端重启后 fold permission/changed 恢复最后档位）
export async function getPermission(
	sessionId: string,
): Promise<PermissionMode> {
	const body = (await request(
		`/api/sessions/${encodeURIComponent(sessionId)}/permission`,
	)) as { mode: PermissionMode };
	return body.mode;
}

export async function setPermission(
	sessionId: string,
	mode: PermissionMode,
): Promise<void> {
	await put(`/api/sessions/${encodeURIComponent(sessionId)}/permission`, {
		mode,
	});
}

// M3 队列变更：next-turn 消息点击转 steer 注入（409 回合未运行 / 404 未命中）
export async function steerQueued(
	sessionId: string,
	messageId: string,
): Promise<void> {
	await post(
		`/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(messageId)}/steer`,
	);
}

// M3 队列变更：移除 next-turn 排队消息（404 未命中）
export async function removeQueued(
	sessionId: string,
	messageId: string,
): Promise<void> {
	await del(
		`/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(messageId)}`,
	);
}

// M3 文本附件上传：立即上传拿绝对路径，发送时以 @<path> 追加进消息文本
export async function uploadFile(
	sessionId: string,
	name: string,
	content: string,
): Promise<UploadResponse> {
	return (await post(`/api/sessions/${encodeURIComponent(sessionId)}/uploads`, {
		name,
		content,
	})) as UploadResponse;
}

// M3 @ 补全：列会话工作区目录直接子级（dirPart 为相对目录，"" = cwd 自身）
export async function listFs(
	sessionId: string,
	dir: string,
): Promise<FsEntry[]> {
	const body = (await request(
		`/api/sessions/${encodeURIComponent(sessionId)}/fs/ls?path=${encodeURIComponent(dir)}`,
	)) as { entries: FsEntry[] };
	return body.entries;
}

// GET/PUT /api/settings 的模型设置视图（server settings-store.ts 的 ModelSettingsView 镜像）
export interface ModelRefWire {
	provider: string;
	model: string;
	apiKey: string;
	baseUrl?: string;
}

export type ModelTier = "high" | "medium" | "low";

export interface ModelSettings {
	models: Record<ModelTier, ModelRefWire>;
	mainAgentTier?: ModelTier;
}

export async function getModelSettings(): Promise<ModelSettings> {
	return (await request("/api/settings")) as ModelSettings;
}

export async function updateModelSettings(
	settings: ModelSettings,
): Promise<ModelSettings> {
	return (await request("/api/settings", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(settings),
	})) as ModelSettings;
}
