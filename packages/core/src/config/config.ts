// settings.json 加载：双层配置（用户级 + 项目级）+ zod 校验 + apiKey 的 $ENV 插值
// 用户级 <home>/settings.json 必填（含 models 与凭证）；home 解析复用 session/store.ts 的 resolveHome
// （参数 > HOTPOT_HOME > ~/.hotpot），避免两处规则漂移。项目级自 cwd 向上逐级查找
// .hotpot/settings.json，可选（找不到则跳过）；用收窄 schema 只解析白名单字段
// （mainAgentTier/maxParallelTasks/planMaxRevisions），未知字段（含 models/permission）静默剥离，
// 凭证与权限永远只来自用户级，规避恶意仓库窃取凭证或提升工具执行权限。
// $ENV 插值：仅对用户级 apiKey 做；apiKey 整串形如 "$NAME" 时取环境变量；未设置（或为空）直接抛错并带变量名——
// 静默传空 key 会把配置错误推迟成难以排查的远端 401（Review Focus 4）

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { resolveHome } from "../session/store.ts";

const modelRefSchema = z.object({
	provider: z.string().min(1),
	model: z.string().min(1),
	apiKey: z.string().min(1),
	baseUrl: z.string().min(1).optional(),
});

// 三档模型配置 schema：server 设置弹窗读写用户级 settings.json 时复用，保持单一事实源
export const modelsSchema = z.object({
	high: modelRefSchema,
	medium: modelRefSchema,
	low: modelRefSchema,
});
export type ModelsSettings = z.infer<typeof modelsSchema>;

// M4 功能开关：全部 optional boolean，读取侧统一经 featureEnabled 的 `?? true` 默认全开
const featuresSchema = z.object({
	todo: z.boolean().optional(),
	hooks: z.boolean().optional(),
	skills: z.boolean().optional(),
	promptTemplates: z.boolean().optional(),
	webSearch: z.boolean().optional(),
	webFetch: z.boolean().optional(),
	mcp: z.boolean().optional(),
});

// M4 hooks：Claude Code 配置形状（SessionStart/PreToolUse/PostToolUse/Stop，Stop 映射 turn_end）。
// matcher 为工具名精确匹配或 "*"；hooks 列表只支持 command 类型
const hookCommandSchema = z.object({
	type: z.literal("command"),
	command: z.string().min(1),
});
const hookMatcherSchema = z.object({
	matcher: z.string(),
	hooks: z.array(hookCommandSchema),
});
const hooksSchema = z.object({
	SessionStart: z.array(hookMatcherSchema).optional(),
	PreToolUse: z.array(hookMatcherSchema).optional(),
	PostToolUse: z.array(hookMatcherSchema).optional(),
	Stop: z.array(hookMatcherSchema).optional(),
});

// M4 webSearch 后端配置：duckduckgo（无 key）或 custom（baseUrl + 可选凭证/头）
const webSearchSchema = z.object({
	backend: z.enum(["duckduckgo", "custom"]),
	apiKey: z.string().optional(),
	baseUrl: z.string().optional(),
	headers: z.record(z.string(), z.string()).optional(),
});

// M4 MCP server 配置：stdio（command 进程）或 streamable HTTP（url）二选一
const mcpStdioServerSchema = z.object({
	command: z.string().min(1),
	args: z.array(z.string()).optional(),
	env: z.record(z.string(), z.string()).optional(),
});
const mcpHttpServerSchema = z.object({
	url: z.string().min(1),
	headers: z.record(z.string(), z.string()).optional(),
});
const mcpServersSchema = z.record(
	z.string(),
	z.union([mcpStdioServerSchema, mcpHttpServerSchema]),
);

// M5 telemetry：用户级主动上报配置。token 可为字面值或整串 "$ENV"，
// 插值由运行时 helper 负责，schema 只校验类型，保持与其他接口字段一致的解析语义。
// endpoint 允许空串/空白（表示「清空本机配置」，运行时继续回退到环境变量/源码常量），
// flushIntervalMs 允许 0（表示不定时 flush）：遥测是旁路，无效配置应退化为 no-op，
// 而不是让 loadSettings 抛错、拖垮整个 CLI/server 启动
const telemetrySchema = z.object({
	enabled: z.boolean().optional(),
	endpoint: z.string().optional(),
	token: z.string().optional(),
	flushIntervalMs: z.number().int().nonnegative().optional(),
});

// 权限三档（M1 定案，替代旧 approval.policy）：
// - readonly：read 类自动放行，其余一切 worker 工具逐个经用户审批
// - ask-on-dangerous：仅危险操作询问（默认档）
// - full：全部自动放行（链头 allowAllHandler），永不打断用户
const PERMISSION_MODES = ["readonly", "ask-on-dangerous", "full"] as const;
const permissionSchema = z.object({
	mode: z.enum(PERMISSION_MODES).optional(),
});
export type PermissionMode = (typeof PERMISSION_MODES)[number];

const settingsSchema = z.object({
	models: modelsSchema,
	mainAgentTier: z.enum(["high", "medium", "low"]).optional(),
	maxParallelTasks: z.number().int().positive().optional(),
	planMaxRevisions: z.number().int().positive().optional(),
	permission: permissionSchema.optional(),
	features: featuresSchema.optional(),
	hooks: hooksSchema.optional(),
	webSearch: webSearchSchema.optional(),
	mcpServers: mcpServersSchema.optional(),
	skillsDirs: z.array(z.string()).optional(),
	promptsDirs: z.array(z.string()).optional(),
	telemetry: telemetrySchema.optional(),
});

// 项目级收窄 schema：只含 4 个白名单字段；zod 默认 strip 静默丢弃 models 等未知字段。
// 安全理由（M4 定案）：M4/M5 新增字段一律仅用户级 —— hooks/mcpServers 涉及任意命令执行，
// 项目级注入即 RCE；skillsDirs/promptsDirs 决定磁盘扫描范围，features/webSearch 影响外发流量，
// telemetry 的 endpoint/token 更不能由仓库改写（否则会把遥测与凭证导向攻击者），
// 均不允许恶意仓库经 .hotpot/settings.json 篡改
const projectSettingsSchema = z.object({
	mainAgentTier: z.enum(["high", "medium", "low"]).optional(),
	maxParallelTasks: z.number().int().positive().optional(),
	planMaxRevisions: z.number().int().positive().optional(),
});

export type ModelRef = z.infer<typeof modelRefSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type Features = z.infer<typeof featuresSchema>;
export type HooksConfig = z.infer<typeof hooksSchema>;
export type WebSearchConfig = z.infer<typeof webSearchSchema>;
export type McpServersConfig = z.infer<typeof mcpServersSchema>;
export type TelemetryConfig = z.infer<typeof telemetrySchema>;
type ProjectSettings = z.infer<typeof projectSettingsSchema>;

// 功能开关统一读取口：默认全开（`?? true`）。关闭开关 = 不注册工具/不挂钩子/不扫描目录，
// 注册表与装配层一律经这里判读，不直接裸读 settings.features?.x
export function featureEnabled(
	features: Settings["features"] | undefined,
	key: keyof NonNullable<Settings["features"]>,
): boolean {
	return features?.[key] ?? true;
}

// apiKey 的 $ENV 引用要求整串匹配，避免误伤字面值里恰好含 $ 的 key
const ENV_REF_PATTERN = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

function resolveApiKey(tier: string, apiKey: string, path: string): string {
	const match = ENV_REF_PATTERN.exec(apiKey);
	if (!match) {
		return apiKey;
	}
	const name = match[1];
	const value = name === undefined ? undefined : process.env[name];
	if (value === undefined || value === "") {
		throw new Error(
			`settings file ${path}: models.${tier}.apiKey references environment variable "$${name}", but it is not set`,
		);
	}
	return value;
}

// 读取并 JSON.parse；失败抛含路径的错误，区分「找不到/不可读」与「非法 JSON」
function readJsonFile(path: string): unknown {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		throw new Error(`settings file not found or unreadable: ${path}`);
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error(`settings file is not valid JSON: ${path}`);
	}
}

// 校验失败统一抛错：列出每个字段的问题与位置
function invalidSettings(
	path: string,
	issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): never {
	const detail = issues
		.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
		.join("; ");
	throw new Error(`invalid settings in ${path}: ${detail}`);
}

// 用户级：必填，含 models 与凭证；校验通过后仅对 apiKey 做 $ENV 插值
function loadUserSettingsFrom(path: string): Settings {
	const parsed = settingsSchema.safeParse(readJsonFile(path));
	if (!parsed.success) {
		invalidSettings(path, parsed.error.issues);
	}
	const settings = parsed.data;
	for (const tier of ["high", "medium", "low"] as const) {
		settings.models[tier].apiKey = resolveApiKey(
			tier,
			settings.models[tier].apiKey,
			path,
		);
	}
	return settings;
}

// 项目级：收窄 schema，只解析白名单字段；未知字段（含 models）被 strip，也不做 $ENV 插值
function loadProjectSettings(path: string): ProjectSettings {
	const parsed = projectSettingsSchema.safeParse(readJsonFile(path));
	if (!parsed.success) {
		invalidSettings(path, parsed.error.issues);
	}
	return parsed.data;
}

// 自 cwd 向上逐级查找 .hotpot/settings.json，找到即返回其绝对路径；到文件系统根仍未找到返回 null
function findProjectSettingsPath(cwd: string): string | null {
	let dir = resolve(cwd);
	for (;;) {
		const candidate = join(dir, ".hotpot", "settings.json");
		if (existsSync(candidate)) {
			return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

// 合并：用户级为底，项目级白名单字段覆盖；permission 不在项目 schema 中，始终保留用户级值
function mergeSettings(user: Settings, project: ProjectSettings): Settings {
	return { ...user, ...project };
}

// 同步读取 + 双层合并 + 插值；任何失败都抛出含文件路径与具体原因的错误
export function loadSettings(options?: {
	home?: string;
	cwd?: string;
}): Settings {
	const userPath = join(resolveHome(options?.home), "settings.json");
	const user = loadUserSettingsFrom(userPath);
	const projectPath = findProjectSettingsPath(options?.cwd ?? process.cwd());
	// 无项目配置，或向上查找恰好落在用户级 home 自身（非项目配置）时，直接返回用户级
	if (projectPath === null || projectPath === userPath) {
		return user;
	}
	return mergeSettings(user, loadProjectSettings(projectPath));
}
