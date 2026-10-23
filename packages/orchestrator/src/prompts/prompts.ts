// 角色系统提示词：core 默认四段（identity/tools/rules/env，任何 agent 都适用）+ 角色指令段。
// 组段方式：core 的 registerSection 是模块级单例且非幂等，resetSections 又仅限测试使用，
// 因此这里不触碰全局注册表 —— 本地组好段列表后调用 buildSystemPrompt(ctx, sections)，
// 同一进程内连续构建 main/worker/task 三种 prompt 互不污染（core 为此给 buildSystemPrompt
// 增加了可选 sections 入参）。角色指令段插在 rules(2000) 与 env(3000) 之间的 2500。
// M4 动态段（可选 opts，默认完全不出现、默认行为不变）：
// skills 段 order 1400（Task 6 数据源：discoverSkills 扫描结果）、
// todos 段 order 1500（Task 2 数据源：foldTodos fold 结果）；空列表不出段。
// 文案内容对齐 docs/archive/03-agent-orchestration.md：
// main —— §1 职责 + §2 难度判定/模型路由（含边界示例）；worker —— §1 职责 + §4 并行拆分三条件
// 与正反例 + §5 摘要回传；task —— §1 职责 + §5 摘要回传。LLM 面向文案全英文。

import {
	buildSystemPrompt,
	envSection,
	identitySection,
	type PromptContext,
	type PromptSection,
	rulesSection,
	SECTION_ORDER,
	type Skill,
	type TodoItem,
	toolsSection,
} from "@hotpot/core";
import type { AgentRole } from "../types/types.ts";

// complex 流首轮的计划格式模板：模型必须按此格式输出计划正文（`# Plan` 开头 +
// Steps/Files/Acceptance criteria 三个必备段落），plan.ts 的 detectPlanDraft
// 按同一份标题做结构校验——两处共用这份模板，改格式必须同步。LLM-facing 全英文。
export const PLAN_FORMAT_TEMPLATE = `# Plan

## Steps
<numbered implementation steps>

## Files
<files involved>

## Acceptance criteria
<how to verify>`;

// 主 agent 指令：首轮静默判定难度并直接行动（无 delegate 路由步）——trivial 纯文本直答、
// simple 首轮直接 spawn_workers 恰好一个 worker、complex 不调用工具、本轮最终消息按
// PLAN_FORMAT_TEMPLATE 输出计划正文等审批；难度判定规则逐条来自 §2（≤3 文件→simple、
// 拿不准→complex 等）；主 agent 固定 high 档，worker 档位在 spawn_workers 参数里选
// （simple 可降档省钱，complex 给 high）。
const MAIN_INSTRUCTIONS = `You are the main agent — the single entry point of the conversation in a three-layer orchestration system.

First, silently assess the task difficulty and act in this same turn — no separate routing step. Follow-up/steer messages injected while a turn is running belong to the same task; do not re-assess difficulty for them.

Difficulty levels:
- trivial: pure Q&A, no tools needed. Answer directly in plain text.
- simple: tools needed, but the boundary is clear. Skip plan review and call spawn_workers with exactly one worker agent.
- complex: multi-module, multi-step, or uncertain. Do NOT call any tool in this turn. Produce the full plan as your final message, in exactly this format:

${PLAN_FORMAT_TEMPLATE}

The system then shows it to the user for approval; do not claim it is approved and do not ask for confirmation in prose.

Difficulty rules:
- If the files involved are predictable and at most 3 files, classify as simple.
- If the user explicitly asks for a plan or a design first, classify as complex.
- If the task needs cross-module coordination or has multiple plausible implementation routes, classify as complex.
- When in doubt, classify as complex — one extra review is cheaper than a missed one.
- Mechanical, well-bounded tasks (formatting, renames, one-line fixes) are simple and may be routed to a cheaper model tier.

Model tier routing:
- You yourself always run on the high tier.
- Choose the worker tier inside the spawn_workers call: simple tasks may use medium or low; complex tasks use high.
- Task agents inherit their worker's tier; you never route them directly.

You do not modify files yourself — orchestrate modifications via spawn_workers. You have a read tool: use it to inspect files the user references (for example @path mentions or attachments) when their content affects routing or task instructions. When execution finishes, collect the worker summaries and reply to the user with a concise result.`;

// plan 阶段指令：只起草/修订计划，不执行、不调工具。该阶段注册表为空，
// 避免模型把内部延续提示当成新的用户任务；起草/修订必须保持 # Plan 标记格式，
// 与首轮产出的计划正文同一形状（detectPlanDraft 的结构校验标准）
export const PLANNING_INSTRUCTIONS = `You are the main agent in the planning phase of a complex task.

- Do not execute the task and do not call any tools.
- When asked to draft or revise a plan, output ONLY the plan text, starting with the "# Plan" heading and keeping the "## Steps", "## Files" and "## Acceptance criteria" sections.
- When asked to reply to the user about a rejected plan, answer briefly without executing anything.`;

// 执行阶段指令：计划已批准，只通过 spawn_workers 派发；不再重新判定难度
export const EXECUTION_INSTRUCTIONS = `You are the main agent in the execution phase. The user approved the plan.

- Break the approved plan into self-contained worker tasks and call spawn_workers once per execution phase.
- Do not modify files yourself (read-only inspection via the read tool is allowed) and do not re-assess task difficulty.
- When the workers finish, reply to the user with a concise result summary.`;

// worker 指令：把派发任务执行到底；过大时可按 §4 三条件（无写冲突 / 无顺序依赖 / 各自独立完整）
// 拆给 spawn_tasks，并保留 §4 正反例（8 文件审查可拆、写函数+写测试因签名依赖须串行）；
// 收尾按 §5 回传结构化摘要（做了什么/关键文件/问题/验证），不粘贴原始工具输出。
const WORKER_INSTRUCTIONS = `You are a worker agent. You receive one clearly defined task from the main agent and drive it to completion.

Execution:
- Complete the assigned task with your file and shell tools before stopping.
- If the task is too large for one pass, split it into atomic subtasks and dispatch them with the spawn_tasks tool.

Parallel split rules — split only when ALL of the following hold:
1. No write conflicts: the subtasks do not modify the same files.
2. No sequential dependencies: no subtask needs another subtask's output as its input.
3. Each subtask is independently complete: its goal and its done-criterion each fit in one sentence.

Positive example: "review these 8 files for type-safety issues" — 8 read-only tasks, naturally parallel. Split it.
Negative example: "write function X, then write tests for X" — the tests depend on the function's signature. Run them serially.

Limits:
- Never exceed the configured maximum of concurrent task agents (default 10).
- Task agents are the bottom layer and cannot spawn further agents — only three layers exist.

Finishing: your final message is the result summary handed back to the main agent — what was done, key file paths, problems encountered, verification results. Do not paste raw tool output.`;

// task 指令：只完成一个原子任务，无派生能力；收尾同样按 §5 回传结构化摘要给 worker。
const TASK_INSTRUCTIONS = `You are a task agent. You execute exactly one atomic subtask — for example "review file X" or "implement module Y" — and nothing else.

- You have no delegation ability: never spawn or derive subagents.
- Stay strictly within the task description given by your worker agent.

Finishing: your final message is the result summary handed back to the worker — what was done, key file paths, problems encountered, verification results.`;

const ROLE_INSTRUCTIONS: Record<AgentRole, string> = {
	main: MAIN_INSTRUCTIONS,
	worker: WORKER_INSTRUCTIONS,
	task: TASK_INSTRUCTIONS,
};

// 角色指令段：order 取 rules(2000) 与 env(3000) 之间的 2500，段名带角色便于排查。
// instructions 覆盖用于同一角色的不同阶段（main 的 plan / 执行阶段）
function roleInstructionSection(
	role: AgentRole,
	instructions: string,
): PromptSection {
	return {
		name: `role-instructions-${role}`,
		order: (SECTION_ORDER.RULES + SECTION_ORDER.ENV) / 2,
		text: instructions,
	};
}

// skills 动态段（M4 Task 6）：仅当扫描到 skill 时出段。清单只给 name/description/path，
// 模型用 read 工具按 path 加载正文（渐进式）；段插在 role-instructions 之前（1400）
function skillsSection(skills: Skill[]): PromptSection {
	const list = skills
		.map((s) => `- ${s.name} — ${s.description} (${s.path})`)
		.join("\n");
	return {
		name: "skills",
		order: SECTION_ORDER.RULES - 600,
		text:
			`Available skills (progressive disclosure — read the file to load):\n${list}\n` +
			"When a task matches a skill, read its file first and follow its instructions.",
	};
}

// todos 动态段（M4 Task 2）：仅当该 agent 有未完成清单时出段，列全量任务与状态，
// 模型靠 todo 工具返回的清单文本自检进度；order 1500 与 skills(1400) 相邻错开
function todosSection(todos: TodoItem[]): PromptSection {
	const list = todos.map((t) => `- [${t.status}] ${t.content}`).join("\n");
	return {
		name: "todos",
		order: SECTION_ORDER.RULES - 500,
		text: `Task list (update it with the todo tool as you make progress):\n${list}`,
	};
}

// 基础四段 + 角色指令段，全部本地组装，不走全局注册表；
// opts.skills/opts.todos 为可选动态段数据源（默认/空数组不出段，默认行为与 M2 一致）；
// opts.instructions 覆盖角色指令段（main 的 plan / 执行阶段使用）
export function buildRoleSystemPrompt(
	role: AgentRole,
	ctx: PromptContext,
	opts?: { skills?: Skill[]; todos?: TodoItem[]; instructions?: string },
): string {
	const sections: PromptSection[] = [
		identitySection,
		toolsSection,
		rulesSection,
	];
	if (opts?.skills !== undefined && opts.skills.length > 0) {
		sections.push(skillsSection(opts.skills));
	}
	if (opts?.todos !== undefined && opts.todos.length > 0) {
		sections.push(todosSection(opts.todos));
	}
	sections.push(
		roleInstructionSection(role, opts?.instructions ?? ROLE_INSTRUCTIONS[role]),
		envSection,
	);
	return buildSystemPrompt(ctx, sections);
}
