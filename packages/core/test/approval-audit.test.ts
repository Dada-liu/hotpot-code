import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditedApprovalChain } from "../src/approval/audit.ts";
import { ApprovalChain, allowAllHandler } from "../src/approval/chain.ts";
import type { SessionEvent } from "../src/session/events.ts";
import { createSession, loadSession } from "../src/session/store.ts";

// 每个用例一个临时 home，隔离落盘的会话日志
let home: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-approval-audit-test-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

function approvalEvents(events: SessionEvent[]): SessionEvent[] {
	return events.filter((e) => e.type.startsWith("approval/"));
}

describe("createAuditedApprovalChain", () => {
	it("ask 放行：落盘 asked 后 decided，payload 与请求一致且 requestId 关联", async () => {
		const session = await createSession("/Users/test/project", home);
		const inner = new ApprovalChain();
		inner.use(async () => "allow");
		const chain = createAuditedApprovalChain(inner, {
			session,
			agentId: "main",
		});

		const req = {
			kind: "command",
			summary: "删除构建目录",
			detail: "rm -rf build/",
		} as const;
		const decision = await chain.ask(req);
		expect(decision).toBe("allow");

		const { events } = await loadSession(session.filePath);
		const approval = approvalEvents(events);
		expect(approval.map((e) => e.type)).toEqual([
			"approval/asked",
			"approval/decided",
		]);

		const asked = approval[0];
		if (asked?.type !== "approval/asked") {
			throw new Error("expected approval/asked event");
		}
		expect(asked.agentId).toBe("main");
		expect(asked.id).toBeTruthy();
		expect(asked.ts).toBeTruthy();
		expect(asked.payload).toEqual({
			kind: "command",
			summary: "删除构建目录",
			detail: "rm -rf build/",
		});

		const decided = approval[1];
		if (decided?.type !== "approval/decided") {
			throw new Error("expected approval/decided event");
		}
		expect(decided.requestId).toBe(asked.id);
		expect(decided.decision).toBe("approved");
	});

	it("inner deny：decision 映射为 denied 落盘", async () => {
		const session = await createSession("/Users/test/project", home);
		const inner = new ApprovalChain();
		inner.use(async () => "deny");
		const chain = createAuditedApprovalChain(inner, {
			session,
			agentId: "main",
		});

		const decision = await chain.ask({
			kind: "write",
			summary: "覆盖配置文件",
			detail: "write .hotpot/settings.json",
		});
		expect(decision).toBe("deny");

		const { events } = await loadSession(session.filePath);
		const approval = approvalEvents(events);
		expect(approval.map((e) => e.type)).toEqual([
			"approval/asked",
			"approval/decided",
		]);
		const decided = approval[1];
		if (decided?.type !== "approval/decided") {
			throw new Error("expected approval/decided event");
		}
		expect(decided.decision).toBe("denied");
	});

	it("asked 事件带传入的 agentId，decided 经 requestId 关联回 asked", async () => {
		const session = await createSession("/Users/test/project", home);
		const inner = new ApprovalChain();
		inner.use(async () => "allow");
		const chain = createAuditedApprovalChain(inner, {
			session,
			agentId: "worker-1",
		});

		await chain.ask({
			kind: "command",
			summary: "运行测试",
			detail: "pnpm test",
		});

		const { events } = await loadSession(session.filePath);
		const approval = approvalEvents(events);
		expect(approval).toHaveLength(2);
		const asked = approval[0];
		if (asked?.type !== "approval/asked") {
			throw new Error("expected approval/asked event");
		}
		// v1 格式里 decided 无 agentId 字段：agent 归属经 requestId 回溯 asked 事件
		expect(asked.agentId).toBe("worker-1");
		const decided = approval[1];
		if (decided?.type !== "approval/decided") {
			throw new Error("expected approval/decided event");
		}
		expect(decided.requestId).toBe(asked.id);
	});

	it("asked id 透传为 requestId：内层 handler 与落盘审计共用同一 id", async () => {
		const session = await createSession("/Users/test/project", home);
		const inner = new ApprovalChain();
		let seenRequestId: string | undefined;
		inner.use(async (req) => {
			seenRequestId = req.requestId;
			return "allow";
		});
		const chain = createAuditedApprovalChain(inner, {
			session,
			agentId: "main",
		});

		await chain.ask({
			kind: "command",
			summary: "运行测试",
			detail: "pnpm test",
		});

		const { events } = await loadSession(session.filePath);
		const asked = approvalEvents(events).find(
			(e) => e.type === "approval/asked",
		);
		if (asked?.type !== "approval/asked") {
			throw new Error("expected approval/asked event");
		}
		// 广播级 requestId 与落盘 asked id 统一，decided 才能经同一 id 关联，
		// 前端按 requestId 匹配 decided 日志清除 pending 审批
		expect(seenRequestId).toBe(asked.id);
	});

	it("use 委托给 inner：包装层注册的 handler 参与裁决", async () => {
		const session = await createSession("/Users/test/project", home);
		const inner = new ApprovalChain();
		const chain = createAuditedApprovalChain(inner, {
			session,
			agentId: "main",
		});
		// 通过包装层注册 handler；若未委托给 inner，fail-closed 会返回 deny
		chain.use(async () => "allow");

		const decision = await chain.ask({
			kind: "command",
			summary: "列出目录",
			detail: "ls",
		});
		expect(decision).toBe("allow");
	});
});

// M1：full 权限模式的链头处理器——任何请求直接 allow，且短路其后注册的 handler
describe("allowAllHandler", () => {
	it("作为链头时直接 allow，后续 handler 不会执行", async () => {
		const chain = new ApprovalChain();
		chain.use(async () => "allow");
		let laterRan = false;
		chain.use(async () => {
			laterRan = true;
			return "deny";
		});

		const decision = await chain.ask({
			kind: "command",
			summary: "清理",
			detail: "rm -rf build/",
		});
		expect(decision).toBe("allow");
		expect(laterRan).toBe(false);
	});

	it("经审计包装后仍落盘 asked/decided(approved) 审计对", async () => {
		const session = await createSession("/Users/test/project", home);
		const inner = new ApprovalChain();
		inner.use(allowAllHandler);
		const chain = createAuditedApprovalChain(inner, {
			session,
			agentId: "main",
		});

		const decision = await chain.ask({
			kind: "write",
			summary: "覆盖文件",
			detail: "write note.txt",
		});
		expect(decision).toBe("allow");

		const { events } = await loadSession(session.filePath);
		const approval = approvalEvents(events);
		expect(approval.map((e) => e.type)).toEqual([
			"approval/asked",
			"approval/decided",
		]);
		const decided = approval[1];
		if (decided?.type !== "approval/decided") {
			throw new Error("expected approval/decided event");
		}
		expect(decided.decision).toBe("approved");
	});
});
