// 工作区注册表：持久化工作区实体及其会话归属
// 存储 <home>/workspaces.json，结构 { version: 1, workspaces: WorkspaceRecord[] }；
// 数组顺序即侧栏展示顺序（新建插到头部）。写盘用 tmp + rename 原子替换，
// 损坏的存储报 invalid-storage 而不是静默清空，避免毁掉用户数据。

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
	mkdir,
	readFile,
	realpath,
	rename,
	stat,
	writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { resolveHome } from "../session/store.ts";

export interface WorkspaceRecord {
	id: string;
	// canonical realpath：去重、归属判定都以它为准
	path: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	// 会话展示顺序：先前再后；一个会话最多属于一个工作区
	sessionIds: string[];
}

export class WorkspaceError extends Error {
	readonly code:
		| "invalid-path"
		| "invalid-title"
		| "name-conflict"
		| "not-found"
		| "invalid-order"
		| "invalid-storage";

	constructor(code: WorkspaceError["code"], message: string) {
		super(message);
		this.name = "WorkspaceError";
		this.code = code;
	}
}

export interface WorkspaceRegistry {
	list(): WorkspaceRecord[];
	create(
		path: string,
	): Promise<{ workspace: WorkspaceRecord; created: boolean }>;
	rename(id: string, title: string): Promise<WorkspaceRecord>;
	remove(id: string): Promise<void>;
	reorder(ids: string[]): Promise<WorkspaceRecord[]>;
	attachSession(
		workspaceId: string,
		sessionId: string,
	): Promise<WorkspaceRecord>;
	detachSession(sessionId: string): Promise<void>;
	findByPath(path: string): WorkspaceRecord | null;
	workspaceForSession(sessionId: string): WorkspaceRecord | null;
}

// 读盘错误的原始描述：WorkspaceError 之外的异常只取 message 供报错使用
function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

// 结构校验：只接受完整记录；缺字段或类型不对都视为存储损坏
function isWorkspaceRecord(value: unknown): value is WorkspaceRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Partial<Record<keyof WorkspaceRecord, unknown>>;
	return (
		typeof record.id === "string" &&
		typeof record.path === "string" &&
		typeof record.title === "string" &&
		typeof record.createdAt === "string" &&
		typeof record.updatedAt === "string" &&
		isStringArray(record.sessionIds)
	);
}

function cloneRecord(record: WorkspaceRecord): WorkspaceRecord {
	return { ...record, sessionIds: [...record.sessionIds] };
}

// 解析存储文件；缺文件 = 空注册表，读取失败/JSON 坏/结构坏/版本不对 = invalid-storage
async function readWorkspaces(filePath: string): Promise<WorkspaceRecord[]> {
	let text: string;
	try {
		text = await readFile(filePath, "utf8");
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") {
			return [];
		}
		throw new WorkspaceError(
			"invalid-storage",
			`cannot read workspace registry ${filePath}: ${errorMessage(err)}`,
		);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text) as unknown;
	} catch (err) {
		throw new WorkspaceError(
			"invalid-storage",
			`workspace registry is not valid JSON: ${filePath} (${errorMessage(err)})`,
		);
	}
	if (typeof raw !== "object" || raw === null) {
		throw new WorkspaceError(
			"invalid-storage",
			`workspace registry has invalid shape: ${filePath}`,
		);
	}
	const storage = raw as { version?: unknown; workspaces?: unknown };
	if (storage.version !== 1) {
		throw new WorkspaceError(
			"invalid-storage",
			`unsupported workspace registry version in ${filePath}: ${String(storage.version)}`,
		);
	}
	if (!Array.isArray(storage.workspaces)) {
		throw new WorkspaceError(
			"invalid-storage",
			`workspace registry is missing the workspaces array: ${filePath}`,
		);
	}
	const records: WorkspaceRecord[] = [];
	const ids = new Set<string>();
	for (const item of storage.workspaces) {
		if (!isWorkspaceRecord(item)) {
			throw new WorkspaceError(
				"invalid-storage",
				`workspace registry contains an invalid record: ${filePath}`,
			);
		}
		if (ids.has(item.id)) {
			throw new WorkspaceError(
				"invalid-storage",
				`workspace registry contains duplicate id ${item.id}: ${filePath}`,
			);
		}
		ids.add(item.id);
		records.push(cloneRecord(item));
	}
	return records;
}

class FileWorkspaceRegistry implements WorkspaceRegistry {
	private readonly home: string;
	private readonly filePath: string;
	private workspaces: WorkspaceRecord[];

	constructor(home: string, workspaces: WorkspaceRecord[]) {
		this.home = home;
		this.filePath = join(home, "workspaces.json");
		this.workspaces = workspaces;
	}

	list(): WorkspaceRecord[] {
		return this.workspaces.map(cloneRecord);
	}

	async create(
		path: string,
	): Promise<{ workspace: WorkspaceRecord; created: boolean }> {
		// resolve 会把相对路径补成绝对路径，所以绝对性必须按原始输入判断
		const resolved = resolve(path);
		if (!isAbsolute(path)) {
			throw new WorkspaceError(
				"invalid-path",
				`workspace path must be absolute: ${path}`,
			);
		}
		let canonical: string;
		try {
			canonical = await realpath(resolved);
		} catch (err) {
			throw new WorkspaceError(
				"invalid-path",
				`workspace path does not exist: ${path} (${errorMessage(err)})`,
			);
		}
		let directory = false;
		try {
			directory = (await stat(canonical)).isDirectory();
		} catch (err) {
			throw new WorkspaceError(
				"invalid-path",
				`cannot stat workspace path: ${path} (${errorMessage(err)})`,
			);
		}
		if (!directory) {
			throw new WorkspaceError(
				"invalid-path",
				`workspace path is not a directory: ${path}`,
			);
		}
		const existing = this.workspaces.find(
			(workspace) => workspace.path === canonical,
		);
		if (existing) {
			return { workspace: cloneRecord(existing), created: false };
		}
		const now = new Date().toISOString();
		const record: WorkspaceRecord = {
			id: randomUUID(),
			path: canonical,
			title: basename(canonical),
			createdAt: now,
			updatedAt: now,
			sessionIds: [],
		};
		// 新建工作区排在最前（与 dsh 一致：最近添加的在侧栏顶部）
		this.workspaces.unshift(record);
		await this.persist();
		return { workspace: cloneRecord(record), created: true };
	}

	async rename(id: string, title: string): Promise<WorkspaceRecord> {
		const trimmed = title.trim();
		if (trimmed === "") {
			throw new WorkspaceError("invalid-title", "workspace title is empty");
		}
		const target = this.workspaces.find((workspace) => workspace.id === id);
		if (!target) {
			throw new WorkspaceError("not-found", `unknown workspace: ${id}`);
		}
		const conflict = this.workspaces.some(
			(workspace) => workspace.id !== id && workspace.title === trimmed,
		);
		if (conflict) {
			throw new WorkspaceError(
				"name-conflict",
				`workspace title already in use: ${trimmed}`,
			);
		}
		target.title = trimmed;
		target.updatedAt = new Date().toISOString();
		await this.persist();
		return cloneRecord(target);
	}

	// 只注销注册：路径、目录与会话日志都保留，会话落入未分组
	async remove(id: string): Promise<void> {
		const index = this.workspaces.findIndex((workspace) => workspace.id === id);
		if (index === -1) {
			throw new WorkspaceError("not-found", `unknown workspace: ${id}`);
		}
		this.workspaces.splice(index, 1);
		await this.persist();
	}

	async reorder(ids: string[]): Promise<WorkspaceRecord[]> {
		const currentIds = new Set(
			this.workspaces.map((workspace) => workspace.id),
		);
		if (ids.length !== this.workspaces.length) {
			throw new WorkspaceError(
				"invalid-order",
				"workspace order must contain every workspace exactly once",
			);
		}
		const seen = new Set<string>();
		for (const id of ids) {
			if (!currentIds.has(id) || seen.has(id)) {
				throw new WorkspaceError(
					"invalid-order",
					"workspace order must contain every workspace exactly once",
				);
			}
			seen.add(id);
		}
		const byId = new Map(
			this.workspaces.map((workspace) => [workspace.id, workspace]),
		);
		const ordered: WorkspaceRecord[] = [];
		for (const id of ids) {
			const record = byId.get(id);
			if (!record) {
				throw new WorkspaceError("invalid-order", `unknown workspace: ${id}`);
			}
			ordered.push(record);
		}
		this.workspaces = ordered;
		await this.persist();
		return this.list();
	}

	async attachSession(
		workspaceId: string,
		sessionId: string,
	): Promise<WorkspaceRecord> {
		const target = this.workspaces.find(
			(workspace) => workspace.id === workspaceId,
		);
		if (!target) {
			throw new WorkspaceError(
				"not-found",
				`unknown workspace: ${workspaceId}`,
			);
		}
		const existingIndex = target.sessionIds.indexOf(sessionId);
		let changed = false;
		// 一会话只属一个工作区：先从其它工作区移出
		for (const workspace of this.workspaces) {
			if (workspace === target) {
				continue;
			}
			const index = workspace.sessionIds.indexOf(sessionId);
			if (index !== -1) {
				workspace.sessionIds.splice(index, 1);
				changed = true;
			}
		}
		if (existingIndex === -1) {
			target.sessionIds.push(sessionId);
			target.updatedAt = new Date().toISOString();
			changed = true;
		}
		// 已在目标工作区时保持原位置，也不刷新 updatedAt（幂等重挂）
		if (changed) {
			await this.persist();
		}
		return cloneRecord(target);
	}

	async detachSession(sessionId: string): Promise<void> {
		let changed = false;
		for (const workspace of this.workspaces) {
			const index = workspace.sessionIds.indexOf(sessionId);
			if (index !== -1) {
				workspace.sessionIds.splice(index, 1);
				changed = true;
			}
		}
		if (changed) {
			await this.persist();
		}
	}

	findByPath(path: string): WorkspaceRecord | null {
		let canonical: string;
		try {
			canonical = realpathSync(resolve(path));
		} catch {
			// 路径不存在或不可访问：视为未注册（调用侧常见的 cwd 探测不应抛错）
			return null;
		}
		const record = this.workspaces.find(
			(workspace) => workspace.path === canonical,
		);
		return record ? cloneRecord(record) : null;
	}

	workspaceForSession(sessionId: string): WorkspaceRecord | null {
		const record = this.workspaces.find((workspace) =>
			workspace.sessionIds.includes(sessionId),
		);
		return record ? cloneRecord(record) : null;
	}

	// 先写 <file>.tmp 再 rename 覆盖：读者要么看到旧文件，要么看到新文件，不会读到半截 JSON
	private async persist(): Promise<void> {
		const storage = { version: 1, workspaces: this.workspaces };
		await mkdir(this.home, { recursive: true });
		const tmpPath = `${this.filePath}.tmp`;
		await writeFile(tmpPath, `${JSON.stringify(storage, null, "\t")}\n`);
		await rename(tmpPath, this.filePath);
	}
}

export async function openWorkspaceRegistry(opts?: {
	home?: string;
}): Promise<WorkspaceRegistry> {
	const home = resolveHome(opts?.home);
	const workspaces = await readWorkspaces(join(home, "workspaces.json"));
	return new FileWorkspaceRegistry(home, workspaces);
}
