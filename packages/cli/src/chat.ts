// 行式交互主逻辑（M2 编排入口）：runChat 驱动「输入一行 → runMainTurn → 渲染事件」循环。
// 主循环不再碰 runTurn/工具注册表：main agent 只有 spawn_workers 元工具，
// 用户消息经 orchestrator 的 runMainTurn 走首轮提示词路由（trivial 直答 / simple 直派 /
// complex 首轮出计划等审批）→ worker 内联执行 → 摘要回传；
// 本文件只负责终端 I/O、审批装配（含审计落盘）、事件渲染与 next-turn 补发。
// IO 全部经 ChatInput/ChatOutput 两个最小接口注入：bin 入口给真实终端实现，测试给脚本化实现。
// 另含进程入口的组装函数 runChatCli 与 argv 解析 parseChatArgs。

import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { LlmAdapter, ModelInfo } from "@hotpot/ai";
import {
	type AgentEvent,
	ApprovalChain,
	createAuditedApprovalChain,
	createHookChain,
	createSession,
	discoverPromptTemplates,
	discoverSkills,
	expandTemplate,
	featureEnabled,
	isSlashInput,
	loadSettings,
	type ModelTier,
	type PermissionMode,
	resolveHome,
	resolveSlashCommand,
	resumeSession,
	type Session,
	type Settings,
} from "@hotpot/core";
import {
	closeMcpConnections,
	connectMcpServers,
	createInbox,
	createPermissionModeChainHead,
	createPermissionModeDecorator,
	createRuntime,
	type McpConnection,
	type OrchestrationEvent,
	type OrchestrationRuntime,
	resolveModel,
	runMainTurn,
	type WorkerToolDecorator,
} from "@hotpot/orchestrator";
import {
	APP_VERSION,
	createTelemetryRuntime,
	sessionEndEvent,
	sessionStartEvent,
} from "@hotpot/telemetry";
import { createTerminalApproval } from "./approval-ui.ts";
import { createTerminalPlanApproval } from "./plan-approval.ts";

// 输入抽象：readLine 返回 null 表示 EOF；interrupt 对应 Ctrl-C（中断当前回合）
export interface ChatInput {
	readLine(): Promise<string | null>;
	setInterruptHandler(cb: (() => void) | null): void;
	close(): void;
}

export interface ChatOutput {
	write(text: string): void;
}

export interface RunChatOptions {
	cwd: string;
	settings: Settings;
	home?: string;
	sessionPath?: string;
	// tier 默认取 settings.mainAgentTier，再默认 "high"
	tier?: ModelTier;
	// 测试注入点：默认时按 ModelRef 解析真实适配器（orchestrator 的 resolveModel）
	llm?: { adapter: LlmAdapter; model: ModelInfo };
	input: ChatInput;
	output: ChatOutput;
	// 告警通道（如未知模型兜底）；默认写 output
	warn?: (text: string) => void;
	// 测试注入点：遥测上报用的 fetch，默认走全局 fetch
	telemetryFetch?: typeof fetch;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

// 工具入参摘要：input 来自 runTurn 的 JSON.parse，恒为 JSON-safe；防御性 try/catch 兜底
function summarizeInput(input: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(input) ?? "";
	} catch {
		text = String(input);
	}
	return truncate(text, 120);
}

// 渲染 core 的 AgentEvent。tool_call 不调 present：present 对原始 LLM 输入可能同步抛错，
// 这里只展示名称与参数摘要（已知 minor 遗留，见 Task 10 报告）
function renderAgentEvent(event: AgentEvent, output: ChatOutput): void {
	switch (event.type) {
		case "text":
			output.write(event.delta);
			break;
		case "tool_call":
			output.write(`\n[tool] ${event.name}(${summarizeInput(event.input)})\n`);
			break;
		case "tool_result": {
			const tag = event.output.isError === true ? "[error] " : "";
			output.write(
				`[tool_result] ${tag}${truncate(event.output.content, 500)}\n`,
			);
			break;
		}
		case "done":
			// stop 是正常出口只补换行；其余 stopReason（aborted/max_tokens/error 等）按文本展示
			output.write(
				event.stopReason === "stop" ? "\n" : `\n[done: ${event.stopReason}]\n`,
			);
			break;
		case "error":
			output.write(`\n[error: ${event.error.code}] ${event.error.message}\n`);
			break;
	}
}

// 渲染单个 OrchestrationEvent：core AgentEvent 之外补充编排语义事件 ——
// agent_spawn 标记子 agent 诞生（task 截断 80 字符），plan 记录计划审批流的状态迁移
// （drafted 附带 plan 全文，便于用户就地审阅；批准/拒绝/修订耗尽只打状态行）
function renderEvent(event: OrchestrationEvent, output: ChatOutput): void {
	if (event.type === "agent_spawn") {
		output.write(
			`\n[spawn] ${event.agentId} (tier=${event.tier}): ${truncate(event.task, 80)}\n`,
		);
		return;
	}
	if (event.type === "plan") {
		if (event.phase === "drafted" && event.plan !== undefined) {
			output.write(`\n[plan] drafted:\n${event.plan}\n`);
		} else {
			output.write(`\n[plan] ${event.phase}\n`);
		}
		return;
	}
	renderAgentEvent(event, output);
}

export async function runChat(opts: RunChatOptions): Promise<void> {
	const { input, output } = opts;
	const warn = opts.warn ?? ((text: string) => output.write(`${text}\n`));
	const settings = opts.settings;
	// 会话时长从进程进入 REPL 前算起，包含模型解析与装配耗时
	const sessionStartedAt = Date.now();
	const tier = opts.tier ?? settings.mainAgentTier ?? "high";
	const ref = settings.models[tier];

	let adapter: LlmAdapter;
	let model: ModelInfo;
	if (opts.llm) {
		adapter = opts.llm.adapter;
		model = opts.llm.model;
	} else {
		const resolved = resolveModel(ref);
		if (resolved.warning) {
			warn(resolved.warning);
		}
		adapter = resolved.adapter;
		model = resolved.model;
	}

	// --session 恢复已有会话（后续事件追加到同一文件），否则新建
	const session: Session = opts.sessionPath
		? await resumeSession(opts.sessionPath)
		: await createSession(opts.cwd, opts.home);
	output.write(
		`会话: ${session.filePath}（tier=${tier}, model=${model.id}）\n`,
	);
	output.write("输入消息开始对话；/exit 退出，Ctrl-C 中断当前回合\n");

	// M5 遥测旁路：未启用或 endpoint 不可用时为 null，后续上报点全部跳过。
	// enqueue 只入队，flush 异步执行且吞掉网络失败，不会阻塞或打断对话。
	const telemetry = createTelemetryRuntime(settings, {
		home: opts.home,
		appVersion: APP_VERSION,
		fetchImpl: opts.telemetryFetch,
	});
	if (telemetry !== null) {
		telemetry.client.enqueue(
			sessionStartEvent({
				sessionId: session.id,
				// --session 走 resumeSession，其余是新建会话
				resumed: opts.sessionPath !== undefined,
				appVersion: APP_VERSION,
				features: settings.features,
				os: process.platform,
				nodeVersion: process.version,
			}),
		);
	}
	// session_end 的累计值：turn 数含 followup 补发，errors 按 turn_end 的 outcome 统计
	let telemetryTurns = 0;
	let telemetryErrors = 0;

	// M4 Feature⑦ MCP：开关（features.mcp，默认开）打开且配置了 server 才连接。
	// 单 server 失败由 connectMcpServers 内部告警跳过，不阻塞启动；连接成功逐个
	// 落盘 mcp/attached（会话级事件，不进模型历史），REPL 结束 finally 统一关闭
	const mcpConnections: McpConnection[] = [];
	if (
		featureEnabled(settings.features, "mcp") &&
		settings.mcpServers !== undefined &&
		Object.keys(settings.mcpServers).length > 0
	) {
		mcpConnections.push(
			...(await connectMcpServers(settings.mcpServers, {
				cwd: opts.cwd,
				warn,
			})),
		);
		for (const conn of mcpConnections) {
			await session.append({
				type: "mcp/attached",
				id: randomUUID(),
				ts: new Date().toISOString(),
				server: conn.name,
				transport: conn.transport,
				tools: conn.tools.map((t) => t.name),
			});
			output.write(
				`[mcp] attached: ${conn.name} (${conn.transport}) — ${conn.tools.length} tools\n`,
			);
		}
	}

	// 审批装配：终端 handler 挂内层链，整体经 createAuditedApprovalChain 落盘 asked/decided。
	// 审计包装的 agentId 在装配期固定为 "main"：ApprovalChain.ask 不带 agentId，
	// worker 发起的 command/write 询问也记在同一 id 下（core 包装层的既有契约）。
	// full 模式链头由 createPermissionModeChainHead 动态裁决（执行时读 holder：
	// full 任何询问直接放行，永不打断用户；其余模式委托终端 handler）。默认 workspace
	const mode: PermissionMode = settings.permission?.mode ?? "workspace";
	const permissionHolder: { mode: PermissionMode } = { mode };
	const baseApproval = new ApprovalChain();
	baseApproval.use(
		createPermissionModeChainHead(
			permissionHolder,
			createTerminalApproval(input, output),
		),
	);
	const approval = createAuditedApprovalChain(baseApproval, {
		session,
		agentId: "main",
	});

	// decorateWorkerTool 总是设置：包装在 execute 时读 holder.mode 动态分派——
	// readonly 下 worker/task 的 bash/write/edit 逐个预审批；workspace/full 原样放行。
	// read 无副作用（isConcurrencySafe），任何模式下都不包、不询问。
	// 下层注册表由编排层内部装配，包装只能经 runtime.decorateWorkerTool 闭包带进去
	const decorateWorkerTool: WorkerToolDecorator =
		createPermissionModeDecorator(permissionHolder);

	// M4 Feature④ skill：开关（features.skills，默认开）打开时扫描
	// skillsDirs（相对 cwd 解析）→ <home>/skills → <cwd>/.hotpot/skills。
	// discoverSkills 同名去重、后扫描者胜，因此优先级 项目级 > home > skillsDirs；
	// 项目级只查 cwd 一级、不向上逐级（已知边界，见 orchestrator README）。
	// 清单经 runtime.skills 注入三角色 prompt，worker/task 的 read 命中 SKILL.md
	// 路径时落盘 skill/loaded
	const skills = featureEnabled(settings.features, "skills")
		? await discoverSkills([
				...(settings.skillsDirs ?? []).map((d) => resolve(opts.cwd, d)),
				join(resolveHome(opts.home), "skills"),
				join(opts.cwd, ".hotpot", "skills"),
			])
		: [];

	// M4 Feature⑤ prompt templates：/命令 的模板来源。
	// 与 skill 同款目录优先级（后扫描覆盖先扫描 = 项目级最高）
	const promptTemplates = featureEnabled(settings.features, "promptTemplates")
		? await discoverPromptTemplates([
				...(settings.promptsDirs ?? []).map((d) => resolve(opts.cwd, d)),
				join(resolveHome(opts.home), "prompts"),
				join(opts.cwd, ".hotpot", "prompts"),
			])
		: [];

	// M4 Feature③ hooks：开关（features.hooks，默认开）打开时构造生命周期链。
	// 配置只来自用户级 settings（项目级白名单不含 hooks）；session_start 在
	// runtime 装配完成后触发一次，pre/post tool 由 runTurn 触发，turn_end 由回合包装层触发
	const hooks = featureEnabled(settings.features, "hooks")
		? createHookChain(settings.hooks, {
				session,
				cwd: opts.cwd,
				agentId: "main",
			})
		: undefined;

	const baseRuntime = createRuntime({
		session,
		cwd: opts.cwd,
		approval,
		models: settings.models,
		maxParallelTasks: settings.maxParallelTasks,
		planMaxRevisions: settings.planMaxRevisions,
		decorateWorkerTool,
		permissionMode: permissionHolder,
		features: settings.features,
		skills,
		mcpTools: mcpConnections.flatMap((c) => c.tools),
		webSearch: settings.webSearch,
		hooks,
	});
	// 测试注入点：opts.llm 覆盖 runtime 的档位解析（main/worker 共用同一录制适配器），
	// 与 orchestrator 测试 makeRuntime 的展开覆盖同法。
	// agent_spawn 已由 runMainTurn 事件流直产（M3），renderEvent 的 agent_spawn
	// 分支直接渲染 [spawn] 行，无需再在 spawn 调用点同步打印
	const runtime: OrchestrationRuntime = {
		...baseRuntime,
		...(opts.llm
			? {
					resolveModel: (_t: ModelTier) => ({
						adapter,
						model,
						apiKey: ref.apiKey,
						baseUrl: ref.baseUrl,
					}),
				}
			: {}),
	};

	// 会话级钩子：runtime 装配完成后触发一次（进程内一次；CLI 与 server 各开一次会话文件
	// 时各触发一次，属预期）。失败不阻塞 REPL——HookChain.run 自身不 reject
	await hooks?.run("session_start", {});

	// steer/queue 双队列：turn 结束后消费 next-turn（followup 补发为新用户消息）；
	// turn 内注入走 next-step —— runMainTurn 经 pollInbox 在每个 step 顶部拉取
	const inbox = createInbox(session, "main", {
		onCancel: () => currentTurn?.abort(),
	});
	const onPlanApproval = createTerminalPlanApproval(input, output);

	// Ctrl-C：回合中 abort 当前 runMainTurn（并触发 inbox.cancel 同一路径）；空闲时不退出进程，只重印提示符
	let currentTurn: AbortController | null = null;
	input.setInterruptHandler(() => {
		if (currentTurn) {
			currentTurn.abort();
			inbox.cancel();
		} else {
			output.write("\n（输入 /exit 退出）\n> ");
		}
	});

	// 单回合：user_msg 落盘由 runMainTurn 以 main 身份负责，这里只迭代事件流并渲染。
	// 遥测按 turn 一个采集器：start 入队、逐事件 observe、finally 折算出明细并立即 flush
	const runOneTurn = async (content: string): Promise<void> => {
		const ac = new AbortController();
		currentTurn = ac;
		const collector =
			telemetry === null
				? null
				: telemetry.createCollector(session, {
						turnId: randomUUID(),
						features: settings.features,
					});
		let planRejected = false;
		try {
			if (telemetry !== null && collector !== null) {
				telemetry.client.enqueue(collector.start());
			}
			for await (const event of runMainTurn({
				runtime,
				userMessage: content,
				signal: ac.signal,
				mainTier: tier,
				onPlanApproval,
				inbox,
			})) {
				renderEvent(event, output);
				// 计划被用户拒绝属于主动中止，采集器据此判 aborted
				if (event.type === "plan" && event.phase === "denied") {
					planRejected = true;
				}
				collector?.observe(event);
			}
		} catch (err) {
			// runTurn 自身兜底 LLM/工具错误；这里防的是会话文件读失败等意外，回合出错不退出 REPL
			output.write(
				`\n[error] ${err instanceof Error ? err.message : String(err)}\n`,
			);
		} finally {
			currentTurn = null;
			if (telemetry !== null && collector !== null) {
				try {
					const events = await collector.finish({
						aborted: ac.signal.aborted,
						planRejected,
					});
					for (const event of events) {
						telemetry.client.enqueue(event);
					}
					telemetryTurns += 1;
					if (
						events.some(
							(event) => event.type === "turn_end" && event.outcome === "error",
						)
					) {
						telemetryErrors += 1;
					}
				} catch {
					// 采集失败只丢本 turn 的遥测，不影响回合结果与后续对话
				}
				void telemetry.client.flush();
			}
		}
	};

	// M4 Feature⑤：把 `/name args` 展开为模板正文并落 prompt/invoked。
	// 返回 null 表示「看起来是命令但未命中模板」；非斜杠输入原样返回。
	const expandPromptInput = async (content: string): Promise<string | null> => {
		if (promptTemplates.length === 0 || !isSlashInput(content)) {
			return content;
		}
		const matched = resolveSlashCommand(content, promptTemplates);
		if (matched === null) {
			return null;
		}
		const expanded = expandTemplate(matched.template, matched.args);
		await session.append({
			type: "prompt/invoked",
			id: randomUUID(),
			ts: new Date().toISOString(),
			agentId: "main",
			name: matched.template.name,
			args: matched.args.join(" "),
			content: expanded,
		});
		return expanded;
	};

	try {
		for (;;) {
			output.write("> ");
			const line = await input.readLine();
			if (line === null || line.trim() === "/exit") {
				break;
			}
			const content = line.trim();
			if (content === "") {
				continue;
			}
			let message = content;
			try {
				const expanded = await expandPromptInput(content);
				if (expanded === null) {
					const name = content.slice(1).split(/\s+/)[0] ?? "";
					output.write(
						`未知命令：/${name}。可用命令：${promptTemplates.map((t) => `/${t.name}`).join(", ")}\n`,
					);
					continue;
				}
				message = expanded;
			} catch (err) {
				output.write(
					`[error] ${err instanceof Error ? err.message : String(err)}\n`,
				);
				continue;
			}
			await runOneTurn(message);
			// turn 结束后 drain next-turn 队列（followup），按序补发为新的用户消息
			let followups = await inbox.drainNextTurn();
			while (followups.length > 0) {
				for (const followup of followups) {
					await runOneTurn(followup.content);
				}
				followups = await inbox.drainNextTurn();
			}
		}
	} finally {
		input.setInterruptHandler(null);
		// MCP 连接统一关闭：stdio 子进程与 HTTP 会话都在这里收尾，关闭失败不阻塞退出
		await closeMcpConnections(mcpConnections);
		if (telemetry !== null) {
			telemetry.client.enqueue(
				sessionEndEvent({
					sessionId: session.id,
					startedAt: sessionStartedAt,
					turns: telemetryTurns,
					errors: telemetryErrors,
				}),
			);
			// close 只做一次有界尝试发送残余批次（含 session_end）；失败由客户端内部吞掉，不影响退出码
			await telemetry.client.close();
		}
	}
	output.write("再见\n");
}

// 真实终端输入：readline 逐行 + SIGINT 转发。
// TTY raw 模式下 ^C 只触发 readline 的 SIGINT 事件、不产生进程信号；管道模式相反——两个都挂，abort 幂等
export function createTerminalChatInput(): ChatInput {
	const rl = createInterface({ input: process.stdin });
	const queue: string[] = [];
	let waiting: ((line: string | null) => void) | null = null;
	let closed = false;
	let interruptHandler: (() => void) | null = null;

	const onSigint = () => {
		interruptHandler?.();
	};

	rl.on("line", (line) => {
		if (waiting) {
			const resolve = waiting;
			waiting = null;
			resolve(line);
		} else {
			// 回合进行中用户提前键入的行排队，回合结束后按序消费
			queue.push(line);
		}
	});
	rl.on("close", () => {
		closed = true;
		if (waiting) {
			const resolve = waiting;
			waiting = null;
			resolve(null);
		}
	});
	rl.on("SIGINT", onSigint);

	return {
		readLine(): Promise<string | null> {
			const queued = queue.shift();
			if (queued !== undefined) {
				return Promise.resolve(queued);
			}
			if (closed) {
				return Promise.resolve(null);
			}
			return new Promise<string | null>((resolve) => {
				waiting = resolve;
			});
		},
		setInterruptHandler(cb: (() => void) | null): void {
			interruptHandler = cb;
			if (cb) {
				process.on("SIGINT", onSigint);
			} else {
				process.removeListener("SIGINT", onSigint);
			}
		},
		close(): void {
			process.removeListener("SIGINT", onSigint);
			rl.close();
		},
	};
}

const USAGE = "用法: hotpot chat [--session <path>] [--tier high|medium|low]";

export interface ChatCliArgs {
	sessionPath?: string;
	tier?: ModelTier;
}

export function parseChatArgs(argv: string[]): ChatCliArgs {
	const [command, ...rest] = argv;
	if (command !== "chat") {
		throw new Error(`未知命令: ${command ?? "(空)"}\n${USAGE}`);
	}
	const args: ChatCliArgs = {};
	for (let i = 0; i < rest.length; i++) {
		const flag = rest[i];
		if (flag === "--session") {
			const value = rest[i + 1];
			if (value === undefined) {
				throw new Error(`--session 缺少路径参数\n${USAGE}`);
			}
			args.sessionPath = value;
			i += 1;
		} else if (flag === "--tier") {
			const value = rest[i + 1];
			if (value !== "high" && value !== "medium" && value !== "low") {
				throw new Error(`--tier 只接受 high|medium|low\n${USAGE}`);
			}
			args.tier = value;
			i += 1;
		} else {
			throw new Error(`未知参数: ${flag}\n${USAGE}`);
		}
	}
	return args;
}

// bin 入口的组装：argv → loadSettings → 终端 IO → runChat；返回进程退出码
export async function runChatCli(argv: string[]): Promise<number> {
	let args: ChatCliArgs;
	try {
		args = parseChatArgs(argv);
	} catch (err) {
		process.stderr.write(
			`${err instanceof Error ? err.message : String(err)}\n`,
		);
		return 1;
	}
	let settings: Settings;
	try {
		settings = loadSettings({ cwd: process.cwd() });
	} catch (err) {
		process.stderr.write(
			`加载配置失败：${err instanceof Error ? err.message : String(err)}\n`,
		);
		return 1;
	}
	const input = createTerminalChatInput();
	try {
		await runChat({
			cwd: process.cwd(),
			settings,
			sessionPath: args.sessionPath,
			tier: args.tier,
			input,
			output: process.stdout,
			warn: (text) => process.stderr.write(`${text}\n`),
		});
		return 0;
	} catch (err) {
		process.stderr.write(
			`${err instanceof Error ? err.message : String(err)}\n`,
		);
		return 1;
	} finally {
		input.close();
	}
}
