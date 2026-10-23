// 按角色装配工具注册表，规则钉死（docs/archive/03-agent-orchestration.md §1）：
// - main：编排元工具 + read（M1 起唯一的文件工具，不套 decorate/skill 追踪）——
//   @提及/附件的文件内容由模型自行 read（绝对路径、无目录监禁）
// - worker：四个基础工具 + 元工具（元工具携带 spawn_tasks，可并行拆分）
// - task：只有四个基础工具，无派生能力（metaTools 直接忽略）
// 四件套与 createToolRegistry 复用 core 实现；metaTools 由上层注入，便于测试用桩替换。
// M4 起第一参为 OrchestrationRuntime：四件套的 decorate（runtime.decorateWorkerTool）
// 与 feature 派生的基础外工具（featureEnabled 开关 + runtime 透传字段）都经 runtime 判读；
// 装饰只作用于四件套，feature 外工具裸注册（Review Focus 1）。
// worker 另有 createWorkerRegistry 工厂：元工具不是外部注入的桩，而是闭包绑定该
// worker（agentId/tier）的真实 spawn_tasks —— 派生的 task 以此 worker 为 parent、
// 继承其档位；spawn_workers/run-worker 内联 worker turn 一律走这个工厂，
// 嵌套 spawn_tasks 才可用。main/task 仍用 createRoleRegistry。

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
	bashTool,
	createToolRegistry,
	createWebFetchTool,
	createWebSearchTool,
	editTool,
	featureEnabled,
	type ModelTier,
	readTool,
	type ToolDefinition,
	type ToolRegistry,
	todoTool,
	writeTool,
} from "@hotpot/core";
import type {
	OrchestrationRuntime,
	WorkerToolDecorator,
} from "../runtime/runtime.ts";
import { createSpawnTasksTool } from "../tools/spawn-tasks.ts";
import type { AgentRole } from "../types/types.ts";

// feature 派生的基础外工具（worker/task 追加；main 永远只有元工具，不进这里）。
// 开关一律经 featureEnabled（`?? true` 默认全开）；todo（Task 2）、web_fetch（Task 3）、
// web_search（Task 4，尚需 runtime.webSearchBackend 已解析，默认由 createRuntime 装配）、
// mcpTools（Task 5 样板，已并入）。
// 返回的工具裸注册：不套 decorateWorkerTool（policy 包装只包四件套）
function featureDerivedTools(
	runtime: OrchestrationRuntime,
): ToolDefinition<unknown>[] {
	const tools: ToolDefinition<unknown>[] = [];
	if (featureEnabled(runtime.features, "todo")) {
		tools.push(todoTool);
	}
	if (featureEnabled(runtime.features, "webFetch")) {
		tools.push(createWebFetchTool());
	}
	if (
		featureEnabled(runtime.features, "webSearch") &&
		runtime.webSearchBackend !== undefined
	) {
		tools.push(createWebSearchTool(runtime.webSearchBackend));
	}
	if (featureEnabled(runtime.features, "mcp")) {
		tools.push(...(runtime.mcpTools ?? []));
	}
	return tools;
}

// —— M4 Feature④ skill 加载追踪 ——
// read 工具的追踪包装：模型 read 的路径（相对 ctx.cwd 解析后）命中已知 skill 的
// SKILL.md 时，经 ctx.session.append 落盘一条 skill/loaded。两个前置条件：开关
// features.skills 打开（featureEnabled 默认开）且 runtime.skills 非空——装配层在
// 开关关闭时根本不扫描、不传 skills，这里是第二道门，保证「关闭双无」。
// seen 集合按 session 归组（WeakMap<Session, Set<path>>）：注册表每次装配 worker/task
// 都新建，每会话每文件只记一次必须跨注册表存活；session 回收后集合随之释放。
// read 返回 isError（文件竞态删除等）不算加载，不记事件。
const skillLoadSeen = new WeakMap<object, Set<string>>();

function withSkillTracking(
	runtime: OrchestrationRuntime,
	tool: ToolDefinition<unknown>,
): ToolDefinition<unknown> {
	if (!featureEnabled(runtime.features, "skills")) {
		return tool;
	}
	const skills = runtime.skills;
	if (skills === undefined || skills.length === 0) {
		return tool;
	}
	const byPath = new Map(skills.map((s) => [s.path, s]));
	return {
		...tool,
		execute: async (args, ctx) => {
			const output = await tool.execute(args, ctx);
			if (output.isError === true) {
				return output;
			}
			const pathArg = readPathArg(args);
			if (pathArg === undefined) {
				return output;
			}
			const skill = byPath.get(resolve(ctx.cwd, pathArg));
			if (skill === undefined) {
				return output;
			}
			let seen = skillLoadSeen.get(ctx.session);
			if (seen === undefined) {
				seen = new Set();
				skillLoadSeen.set(ctx.session, seen);
			}
			if (seen.has(skill.path)) {
				return output;
			}
			seen.add(skill.path);
			await ctx.session.append({
				type: "skill/loaded",
				id: randomUUID(),
				ts: new Date().toISOString(),
				agentId: ctx.agentId,
				skill: skill.name,
				path: skill.path,
			});
			return output;
		},
	};
}

// 从 read 的未知入参里安全取 path：注册表把 ToolDefinition<T> 擦除为 unknown，
// 这里按形状窄化，非对象/无 path 直接放弃追踪（执行已由 schema.parse 校验过）
function readPathArg(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) {
		return undefined;
	}
	const path = (args as { path?: unknown }).path;
	return typeof path === "string" && path !== "" ? path : undefined;
}

export function createRoleRegistry(
	runtime: OrchestrationRuntime,
	role: AgentRole,
	metaTools: readonly ToolDefinition<unknown>[],
): ToolRegistry {
	const registry = createToolRegistry();
	if (role === "main") {
		// M1：main 的唯一文件工具是 read，裸注册——不套 decorateWorkerTool
		// （main 不消费权限预审批）也不套 skill 追踪（追踪只面向 worker/task 的
		// SKILL.md 渐进式加载）。main 仍无 write/edit/bash，写操作只能经 spawn_workers
		registry.register(readTool);
	}
	if (role !== "main") {
		// worker / task 都有文件四件套；逐个 register 让泛型 T 各自推断，避免数组型变问题。
		// decorate 只在这里作用于四件套；read 额外包 skill 追踪（任何 policy 下都包，
		// 追踪无副作用、只读会话日志）
		const decorate: WorkerToolDecorator | undefined =
			runtime.decorateWorkerTool;
		for (const tool of [bashTool, readTool, writeTool, editTool]) {
			const decorated = decorate ? decorate(tool) : tool;
			registry.register(
				tool.name === "read"
					? withSkillTracking(runtime, decorated)
					: decorated,
			);
		}
		for (const tool of featureDerivedTools(runtime)) {
			registry.register(tool);
		}
	}
	if (role !== "task") {
		// main / worker 挂元工具；task 是底层，忽略任何派生能力
		for (const tool of metaTools) {
			registry.register(tool);
		}
	}
	return registry;
}

// worker 注册表工厂：四件套 + 绑定到该 worker 的 spawn_tasks（闭包携带 agentId/tier）
export function createWorkerRegistry(
	runtime: OrchestrationRuntime,
	worker: { agentId: string; tier: ModelTier },
): ToolRegistry {
	return createRoleRegistry(runtime, "worker", [
		createSpawnTasksTool(runtime, worker),
	]);
}
