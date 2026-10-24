// HTTP 外壳（M3）：Hono REST + SSE。
// - 会话路由挂 /api/sessions*，设置路由挂 /api/settings（用户级模型设置读写）；
//   错误统一 {error: string} 形态 + 合适状态码
// - SSE（GET /:id/events）：帧格式 `id: <seq>` + `data: <WireEvent JSON>`，每 15s 一条
//   `: ping` 注释保活；断线（ReadableStream cancel）即退订
// - 重连补发：?after= 优先于 Last-Event-ID 头，交给 manager.subscribeResuming——
//   命中 ring buffer 窗口走增量；掉出窗口走全量日志重放（seq 经 hub.replay 重新分配，
//   与 live 流连续）
// - 订阅在 Response 返回（首字节发出）之前完成注册：客户端收到 200 即补发完毕、
//   live 通道就绪，彻底排除「连接已通、订阅未注册」的竞态
// - sink 自包 try/catch：manager 的 emit 是同步广播，sink 抛错会杀死广播循环

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { type Context, Hono } from "hono";
import { z } from "zod";
import {
	PickerTimeoutError,
	PickerUnavailableError,
} from "./directory-picker.ts";
import type { SessionManager } from "./session-manager.ts";
import { PromptCommandError, SessionApiError } from "./session-manager.ts";
import {
	putModelSettingsSchema,
	readModelSettings,
	writeModelSettings,
} from "./settings-store.ts";
import type { WireEvent } from "./wire.ts";

// cwd 与 workspaceId 互斥：两者都传由路由层 400
const createSessionSchema = z.object({
	cwd: z.string().optional(),
	workspaceId: z.string().optional(),
});
const createWorkspaceSchema = z.object({
	path: z.string(),
});
const renameWorkspaceSchema = z.object({
	title: z.string(),
});
const reorderWorkspacesSchema = z.object({
	ids: z.array(z.string()),
});
const messageSchema = z.object({
	content: z.string(),
});
const approvalSchema = z.object({
	decision: z.enum(["allow", "deny"]),
});
const planSchema = z.object({
	decision: z.enum(["approve", "reject", "annotate"]),
	note: z.string().optional(),
});
// M2 权限切换：mode 三档枚举，非法值由 zod 拦 400
const putPermissionSchema = z.object({
	mode: z.enum(["readonly", "workspace", "full"]),
});
// M2 文本附件上传：name 由 manager 净化（剥路径分隔符与 ..），content 纯文本
const uploadSchema = z.object({
	name: z.string(),
	content: z.string(),
});

// 读取 JSON body：空 body 视为 {}；非法 JSON 返回 undefined（调用方转 400）
async function readJsonBody(c: Context): Promise<unknown> {
	const text = await c.req.text();
	if (text.trim() === "") return {};
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

// 解析 SSE 的 after：query 参数 ?after= 优先，其次 Last-Event-ID 头；
// 非法值返回 NaN（调用方转 400），默认为 null
function resolveAfterSeq(c: Context): number | null {
	const query = c.req.query("after");
	const header = c.req.header("Last-Event-ID");
	const raw = query ?? header;
	if (raw === undefined) return null;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) return Number.NaN;
	return n;
}

const SSE_HEADERS = {
	"Content-Type": "text/event-stream; charset=utf-8",
	"Cache-Control": "no-cache, no-transform",
	Connection: "keep-alive",
};
const PING_INTERVAL_MS = 15000;

async function handleEvents(
	manager: SessionManager,
	id: string,
	afterSeq: number | null,
): Promise<Response> {
	const encoder = new TextEncoder();
	const holder: {
		controller: ReadableStreamDefaultController<Uint8Array> | null;
	} = { controller: null };
	let unsubscribe: (() => void) | null = null;
	let pingTimer: ReturnType<typeof setInterval> | null = null;
	let cleaned = false;
	const cleanup = (): void => {
		if (cleaned) return;
		cleaned = true;
		if (pingTimer !== null) clearInterval(pingTimer);
		unsubscribe?.();
	};
	// sink 自包 try/catch：enqueue 失败（流已关闭）只清理本连接，不上抛进广播循环
	const write = (e: WireEvent): void => {
		const controller = holder.controller;
		if (controller === null) return;
		try {
			controller.enqueue(
				encoder.encode(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`),
			);
		} catch {
			cleanup();
		}
	};
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			holder.controller = controller;
		},
		cancel() {
			cleanup();
		},
	});
	// 订阅（含补发重放）先完成，再返回 Response：首字节到达时 live 通道必已就绪
	unsubscribe = await manager.subscribeResuming(id, afterSeq, write);
	pingTimer = setInterval(() => {
		const controller = holder.controller;
		if (controller === null) return;
		try {
			controller.enqueue(encoder.encode(": ping\n\n"));
		} catch {
			cleanup();
		}
	}, PING_INTERVAL_MS);
	return new Response(stream, { headers: SSE_HEADERS });
}

export interface AppOptions {
	// settings.json 所在 home（测试注入临时目录；缺省 resolveHome → ~/.hotpot）
	home?: string;
}

export function createApp(
	manager: SessionManager,
	opts: AppOptions = {},
): Hono {
	const app = new Hono();

	app.onError((err, c) => {
		return c.json(
			{ error: err instanceof Error ? err.message : String(err) },
			500,
		);
	});

	// 受管会话存在性：内存 managed 表未命中时降级 attachById 恢复磁盘上的会话
	// （CLI/其他进程创建的会话经 listSessions 可见，也必须能打开与订阅）；
	// attach 同样未命中才 404。attachById 是异步的，调用方必须 await
	const requireSession = async (id: string) => {
		const rec = manager.get(id);
		if (rec !== null) return rec;
		return manager.attachById(id);
	};

	app.get("/api/sessions", async (c) => {
		const sessions = await manager.list();
		return c.json({
			sessions: sessions.map((s) => ({
				id: s.id,
				cwd: s.cwd,
				createdAt: s.createdAt,
				turn: s.running ? "running" : "idle",
			})),
		});
	});

	app.post("/api/sessions", async (c) => {
		const body = await readJsonBody(c);
		const parsed = createSessionSchema.safeParse(body);
		if (!parsed.success) {
			return c.json(
				{ error: "body 需为 {cwd?: string, workspaceId?: string}" },
				400,
			);
		}
		if (
			parsed.data.cwd !== undefined &&
			parsed.data.workspaceId !== undefined
		) {
			return c.json({ error: "cwd 与 workspaceId 互斥，只能传其一" }, 400);
		}
		try {
			// 工作区绑定：路径来自注册表记录（校验在 manager 内完成）
			if (parsed.data.workspaceId !== undefined) {
				const rec = await manager.createInWorkspace(parsed.data.workspaceId);
				return c.json({ id: rec.id }, 201);
			}
			// M2：显式 cwd 须 resolve 后存在且为目录，否则 400（缺省仍用 process.cwd()）
			let cwd = parsed.data.cwd ?? process.cwd();
			if (parsed.data.cwd !== undefined) {
				cwd = resolve(parsed.data.cwd);
				try {
					if (!(await stat(cwd)).isDirectory()) {
						return c.json({ error: `cwd 不是目录: ${cwd}` }, 400);
					}
				} catch {
					return c.json({ error: `cwd 不存在: ${cwd}` }, 400);
				}
			}
			const rec = await manager.create(cwd);
			return c.json({ id: rec.id }, 201);
		} catch (err) {
			if (err instanceof SessionApiError) {
				return c.json({ error: err.message }, err.status);
			}
			throw err;
		}
	});

	// ---- 工作区注册表（web 侧栏分组）----
	// 记录原样返回：id/path/title/createdAt/updatedAt/sessionIds（数组顺序即展示顺序）

	app.get("/api/workspaces", async (c) => {
		return c.json({ workspaces: await manager.listWorkspaces() });
	});

	app.post("/api/workspaces", async (c) => {
		const body = await readJsonBody(c);
		const parsed = createWorkspaceSchema.safeParse(body);
		if (!parsed.success) {
			return c.json({ error: "body 需为 {path: string}" }, 400);
		}
		try {
			return c.json(await manager.createWorkspace(parsed.data.path));
		} catch (err) {
			if (err instanceof SessionApiError) {
				return c.json({ error: err.message }, err.status);
			}
			throw err;
		}
	});

	// 排序必须完整覆盖现有 id（长度相同、无重复、无未知 id），否则 400
	app.put("/api/workspaces/order", async (c) => {
		const body = await readJsonBody(c);
		const parsed = reorderWorkspacesSchema.safeParse(body);
		if (!parsed.success) {
			return c.json({ error: "body 需为 {ids: string[]}" }, 400);
		}
		try {
			return c.json({
				workspaces: await manager.reorderWorkspaces(parsed.data.ids),
			});
		} catch (err) {
			if (err instanceof SessionApiError) {
				return c.json({ error: err.message }, err.status);
			}
			throw err;
		}
	});

	app.patch("/api/workspaces/:id", async (c) => {
		const body = await readJsonBody(c);
		const parsed = renameWorkspaceSchema.safeParse(body);
		if (!parsed.success) {
			return c.json({ error: "body 需为 {title: string}" }, 400);
		}
		try {
			const workspace = await manager.renameWorkspace(
				c.req.param("id"),
				parsed.data.title,
			);
			return c.json({ workspace });
		} catch (err) {
			if (err instanceof SessionApiError) {
				return c.json({ error: err.message }, err.status);
			}
			throw err;
		}
	});

	// 只注销注册：目录与会话日志保留，会话落入未分组
	app.delete("/api/workspaces/:id", async (c) => {
		try {
			await manager.removeWorkspace(c.req.param("id"));
			return c.body(null, 204);
		} catch (err) {
			if (err instanceof SessionApiError) {
				return c.json({ error: err.message }, err.status);
			}
			throw err;
		}
	});

	// 系统原生目录选择器：取消 200 {path:null}；无可用后端 501；超时 504；其他失败 500。
	// body 忽略（客户端无需传参），因此这里不读请求体
	app.post("/api/directory-picker/pick", async (c) => {
		try {
			return c.json({ path: await manager.pickDirectory() });
		} catch (err) {
			if (err instanceof PickerUnavailableError) {
				return c.json({ code: "picker-unavailable", error: err.message }, 501);
			}
			if (err instanceof PickerTimeoutError) {
				return c.json({ error: err.message }, 504);
			}
			return c.json(
				{ error: err instanceof Error ? err.message : String(err) },
				500,
			);
		}
	});

	app.get("/api/sessions/:id", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		const usage = await manager.usage(rec.id);
		return c.json({
			id: rec.id,
			cwd: rec.cwd,
			createdAt: rec.createdAt,
			filePath: rec.filePath,
			turn: rec.running ? "running" : "idle",
			// M2：权限切换器初始档位（web 进入会话时免再查 /permission）
			permissionMode: manager.permission(rec.id),
			usage,
		});
	});

	app.get("/api/sessions/:id/events", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		const afterSeq = resolveAfterSeq(c);
		if (Number.isNaN(afterSeq)) {
			return c.json({ error: "after 需为非负整数" }, 400);
		}
		return handleEvents(manager, rec.id, afterSeq);
	});

	// 归档会话：结束运行中的回合并全部落盘，摘托管但保留磁盘日志（之后可重新打开/删除）
	app.post("/api/sessions/:id/archive", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		const ok = await manager.archive(rec.id);
		if (!ok) return c.json({ error: "会话不存在" }, 404);
		return c.json({});
	});

	// 删除会话：运行中 409（先取消再删）；删除 = close 收尾 + 删磁盘日志，之后任何入口均 404
	app.delete("/api/sessions/:id", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		if (rec.running) {
			return c.json({ error: "会话运行中，请先取消再删除" }, 409);
		}
		const ok = await manager.delete(rec.id);
		if (!ok) return c.json({ error: "会话不存在" }, 404);
		return c.body(null, 204);
	});

	app.post("/api/sessions/:id/messages", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		const body = await readJsonBody(c);
		const parsed = messageSchema.safeParse(body);
		if (!parsed.success) {
			return c.json({ error: "body 需为 {content: string}" }, 400);
		}
		try {
			const outcome = await manager.send(rec.id, parsed.data.content);
			// 内置指令（/help、/permission）：不进模型、不落盘，200 本地应答；
			// 普通消息保持 202（已挂进 turn 串行链）
			if (outcome.reply !== null) {
				return c.json({ reply: outcome.reply }, 200);
			}
		} catch (err) {
			// 未知斜杠命令与内置指令参数错误：400 并带原因（消息不进入回合）
			if (err instanceof PromptCommandError) {
				return c.json({ error: err.message }, 400);
			}
			if (err instanceof SessionApiError) {
				return c.json({ error: err.message }, err.status);
			}
			throw err;
		}
		return c.json({}, 202);
	});

	// M2 权限模式读写（web 权限切换器）。PUT 走统一切换路径：改运行时持有者 →
	// 落 permission/changed → 广播 wire permission（durable log 先于瞬态事件到达）
	app.get("/api/sessions/:id/permission", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		return c.json({ mode: manager.permission(rec.id) });
	});

	app.put("/api/sessions/:id/permission", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		const body = await readJsonBody(c);
		const parsed = putPermissionSchema.safeParse(body);
		if (!parsed.success) {
			return c.json(
				{ error: 'body 需为 {mode: "readonly"|"workspace"|"full"}' },
				400,
			);
		}
		await manager.setPermission(rec.id, parsed.data.mode);
		return c.json({ mode: parsed.data.mode });
	});

	// M2 队列变更（web 队列条）：steer 仅运行中有意义（空闲无 next-step 消费方 → 409）；
	// 未命中消息 id → 404（inbox 变更动词未命中不落盘）
	app.post("/api/sessions/:id/queue/:messageId/steer", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		if (!rec.running) {
			return c.json({ error: "会话回合未在运行，无法 steer 队列消息" }, 409);
		}
		const ok = await manager.steerQueued(rec.id, c.req.param("messageId"));
		if (!ok) return c.json({ error: "队列中不存在该消息" }, 404);
		return c.json({}, 202);
	});

	app.delete("/api/sessions/:id/queue/:messageId", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		const ok = await manager.removeQueued(rec.id, c.req.param("messageId"));
		if (!ok) return c.json({ error: "队列中不存在该消息" }, 404);
		return c.body(null, 204);
	});

	// M2 文本附件上传：写 <home>/uploads/<sessionId>/<counter>-<净化名>（绝不覆盖），
	// 返回绝对路径供消息内 @<path> 引用；NUL/超 512KB/超 10 个分别 400/413/413
	app.post("/api/sessions/:id/uploads", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		const body = await readJsonBody(c);
		const parsed = uploadSchema.safeParse(body);
		if (!parsed.success) {
			return c.json(
				{ error: "body 需为 {name: string, content: string}" },
				400,
			);
		}
		try {
			const { path } = await manager.saveUpload(
				rec.id,
				parsed.data.name,
				parsed.data.content,
			);
			return c.json({ path }, 201);
		} catch (err) {
			if (err instanceof SessionApiError) {
				return c.json({ error: err.message }, err.status);
			}
			throw err;
		}
	});

	// M2 会话工作区浏览（web @ 补全）：只列目录直接子级；realpath 后 startsWith
	// 校验防逃逸（cwd 自身可列；越界/不存在 → 400）
	app.get("/api/sessions/:id/fs/ls", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		try {
			return c.json(await manager.listFs(rec.id, c.req.query("path") ?? ""));
		} catch (err) {
			if (err instanceof SessionApiError) {
				return c.json({ error: err.message }, err.status);
			}
			throw err;
		}
	});

	// M2：`/` 菜单数据源——内置指令（builtin: true）置顶 + prompt templates（builtin: false），
	// web 端按标记分区展示
	app.get("/api/sessions/:id/prompts", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		return c.json({ prompts: manager.prompts(rec.id) });
	});

	// M4 Feature②：steer/queue 两队列快照（web 队列条；队列变更同时经 inbox/spliced 落盘）
	app.get("/api/sessions/:id/inbox", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		return c.json(manager.inbox(rec.id));
	});

	app.post("/api/sessions/:id/steer", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		const body = await readJsonBody(c);
		const parsed = messageSchema.safeParse(body);
		if (!parsed.success) {
			return c.json({ error: "body 需为 {content: string}" }, 400);
		}
		await manager.steer(rec.id, parsed.data.content);
		return c.json({}, 202);
	});

	app.post("/api/sessions/:id/cancel", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		manager.cancel(rec.id);
		return c.json({}, 202);
	});

	app.post("/api/sessions/:id/approvals/:requestId", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		const body = await readJsonBody(c);
		const parsed = approvalSchema.safeParse(body);
		if (!parsed.success) {
			return c.json({ error: 'body 需为 {decision: "allow"|"deny"}' }, 400);
		}
		const ok = manager.answerToolApproval(
			rec.id,
			c.req.param("requestId"),
			parsed.data.decision,
		);
		if (!ok) return c.json({ error: "未知 requestId" }, 404);
		return c.json({});
	});

	app.post("/api/sessions/:id/plan", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		const body = await readJsonBody(c);
		const parsed = planSchema.safeParse(body);
		if (!parsed.success) {
			return c.json(
				{ error: 'body 需为 {decision: "approve"|"reject"|"annotate", note?}' },
				400,
			);
		}
		if (parsed.data.decision !== "approve" && parsed.data.note === undefined) {
			return c.json({ error: "reject/annotate 需附 note" }, 400);
		}
		const decision =
			parsed.data.decision === "approve"
				? { kind: "approve" as const }
				: parsed.data.decision === "reject"
					? { kind: "reject" as const, note: parsed.data.note ?? "" }
					: { kind: "annotate" as const, note: parsed.data.note ?? "" };
		const ok = manager.answerPlan(rec.id, decision);
		if (!ok) return c.json({ error: "无待审批的 plan" }, 404);
		return c.json({});
	});

	app.get("/api/sessions/:id/usage", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		return c.json(await manager.usage(rec.id));
	});

	// 模型设置（web 设置弹窗）：只读写用户级 settings.json 的 models/mainAgentTier 切片，
	// 其余字段原样保留；读失败（缺文件/坏 JSON/不合规）抛错走 onError 500
	app.get("/api/settings", async (c) => {
		return c.json(readModelSettings(opts.home));
	});

	app.put("/api/settings", async (c) => {
		const body = await readJsonBody(c);
		const parsed = putModelSettingsSchema.safeParse(body);
		if (!parsed.success) {
			return c.json(
				{
					error:
						"body 需为 {models: {high|medium|low: {provider, model, apiKey, baseUrl?}}, mainAgentTier?}",
				},
				400,
			);
		}
		writeModelSettings(parsed.data, opts.home);
		return c.json(readModelSettings(opts.home));
	});

	return app;
}
