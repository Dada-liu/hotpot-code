import { describe, expect, it } from "vitest";
import {
	agentNameFromTask,
	sessionNameFromPrompt,
} from "../src/lib/session-name.ts";

describe("sessionNameFromPrompt", () => {
	it("20 字符以内全取", () => {
		expect(sessionNameFromPrompt("帮我重构登录模块")).toBe("帮我重构登录模块");
		expect(sessionNameFromPrompt("b".repeat(20))).toBe("b".repeat(20));
	});

	it("多行取第一行", () => {
		expect(sessionNameFromPrompt("第一行\n第二行")).toBe("第一行");
	});

	it("去掉首尾空白", () => {
		expect(sessionNameFromPrompt("   spaced  ")).toBe("spaced");
	});

	it("超过 20 字符且无分隔符时取前 20 字符", () => {
		expect(sessionNameFromPrompt("a".repeat(30))).toBe("a".repeat(20));
	});

	it("超过 20 字符时按第一个句子分隔符取前半段", () => {
		expect(
			sessionNameFromPrompt("在当前目录创建三个文本文件，分别是 a.txt"),
		).toBe("在当前目录创建三个文本文件");
		expect(
			sessionNameFromPrompt("hello, world this is a very long prompt"),
		).toBe("hello");
	});

	it("分隔符位置超过 20 字符时兜底截到 20", () => {
		expect(sessionNameFromPrompt(`${"a".repeat(25)}，后面还有`)).toBe(
			"a".repeat(20),
		);
	});

	it("分隔符在首位时不取空串，回退前 20 字符", () => {
		expect(sessionNameFromPrompt("。12345678901234567890123")).toBe(
			"。1234567890123456789",
		);
	});

	it("支持中英文句号/逗号/顿号/换行等多种分隔符", () => {
		expect(
			sessionNameFromPrompt("完成报表。然后用邮件发送给团队和其他相关同事"),
		).toBe("完成报表");
		expect(
			sessionNameFromPrompt("买牛奶、鸡蛋和面包还有很多其他东西要顺便买回来"),
		).toBe("买牛奶");
	});

	it("空与纯空白回退为“新会话”", () => {
		expect(sessionNameFromPrompt("")).toBe("新会话");
		expect(sessionNameFromPrompt("   \n  ")).toBe("新会话");
	});
});

describe("agentNameFromTask", () => {
	it("10 字符以内全取", () => {
		expect(agentNameFromTask("创建 a.txt")).toBe("创建 a.txt");
		expect(agentNameFromTask("c".repeat(10))).toBe("c".repeat(10));
	});

	it("超过 10 字符且无分隔符时取前 10 字符", () => {
		expect(agentNameFromTask("d".repeat(15))).toBe("d".repeat(10));
	});

	it("超过 10 字符时按第一个句子分隔符取前半段", () => {
		expect(
			agentNameFromTask("在当前工作目录创建三个文本文件，分别写入文件名"),
		).toBe("在当前工作目录创建三");
	});

	it("分隔符位置超过 10 字符时兜底截到 10", () => {
		expect(agentNameFromTask(`${"e".repeat(15)}，后续省略`)).toBe(
			"e".repeat(10),
		);
	});

	it("空任务返回空串（调用方回退 agentId）", () => {
		expect(agentNameFromTask("")).toBe("");
		expect(agentNameFromTask("   \n  ")).toBe("");
	});
});
