// 目录选择器单测：注入假 spawn，不弹真实系统对话框。
// 假子进程在 microtask 里回放 stdout/stderr/close，保证 pickDirectory 已挂好监听。

import type { HotpotChildProcess, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	PickerTimeoutError,
	PickerUnavailableError,
	pickDirectory,
} from "../src/directory-picker.ts";

// 每个 spawn 调用对应一条 behavior；超时用例用 hang 模拟系统模态框不返回
interface FakeBehavior {
	stdout?: string;
	stderr?: string;
	code?: number | null;
	error?: { message: string; code?: string };
	hang?: boolean;
}

class FakeStream {
	private readonly dataListeners: ((chunk: { toString(): string }) => void)[] =
		[];

	on(event: "data", listener: (chunk: { toString(): string }) => void): void {
		if (event === "data") this.dataListeners.push(listener);
	}

	removeAllListeners(): void {
		this.dataListeners.length = 0;
	}

	destroy(): void {}

	emit(text: string): void {
		const chunk = { toString: () => text };
		for (const listener of this.dataListeners) listener(chunk);
	}
}

class FakeChild implements HotpotChildProcess {
	pid = 1;
	stdin = null;
	stdout = new FakeStream();
	stderr = new FakeStream();
	killed = 0;
	private readonly errorListeners: ((err: Error) => void)[] = [];
	private readonly closeListeners: ((
		code: number | null,
		signal: string | null,
	) => void)[] = [];

	kill(_signal?: string): boolean {
		this.killed += 1;
		return true;
	}

	unref(): void {}

	on(event: "error", listener: (err: Error) => void): void;
	on(
		event: "exit",
		listener: (code: number | null, signal: string | null) => void,
	): void;
	on(
		event: "close",
		listener: (code: number | null, signal: string | null) => void,
	): void;
	on(
		event: "error" | "exit" | "close",
		listener:
			| ((err: Error) => void)
			| ((code: number | null, signal: string | null) => void),
	): void {
		if (event === "error") {
			this.errorListeners.push(listener as (err: Error) => void);
		} else {
			this.closeListeners.push(
				listener as (code: number | null, signal: string | null) => void,
			);
		}
	}

	emitError(err: Error): void {
		for (const listener of this.errorListeners) listener(err);
	}

	emitClose(code: number | null): void {
		for (const listener of this.closeListeners) listener(code, null);
	}
}

interface SpawnRecord {
	command: string;
	args: string[];
	child: FakeChild;
}

function createSpawn(behaviors: FakeBehavior[]): {
	spawnFn: typeof spawn;
	calls: SpawnRecord[];
} {
	const calls: SpawnRecord[] = [];
	const spawnFn: typeof spawn = (command, args) => {
		const behavior = behaviors[calls.length];
		if (behavior === undefined) {
			throw new Error(`未预期的 spawn 调用: ${command}`);
		}
		const child = new FakeChild();
		calls.push({ command, args: [...args], child });
		queueMicrotask(() => {
			if (behavior.error !== undefined) {
				child.emitError(
					Object.assign(new Error(behavior.error.message), {
						code: behavior.error.code,
					}),
				);
				return;
			}
			if (behavior.stdout !== undefined) child.stdout.emit(behavior.stdout);
			if (behavior.stderr !== undefined) child.stderr.emit(behavior.stderr);
			if (behavior.hang === true) return;
			child.emitClose(behavior.code ?? 0);
		});
		return child;
	};
	return { spawnFn, calls };
}

function enoent(command: string): FakeBehavior {
	return { error: { message: `spawn ${command} ENOENT`, code: "ENOENT" } };
}

describe("pickDirectory", () => {
	it("darwin 成功：osascript 输出去掉末尾换行", async () => {
		const { spawnFn, calls } = createSpawn([
			{ stdout: "/Users/me/proj\n", code: 0 },
		]);
		await expect(pickDirectory({ platform: "darwin", spawnFn })).resolves.toBe(
			"/Users/me/proj",
		);
		expect(calls[0]?.command).toBe("osascript");
		expect(calls[0]?.args[0]).toBe("-e");
		expect(calls[0]?.args[1]).toContain("choose folder");
	});

	it("darwin 用户取消（exit 1 + User canceled）→ null", async () => {
		const { spawnFn } = createSpawn([
			{ stderr: "execution error: User canceled. (-128)\n", code: 1 },
		]);
		await expect(pickDirectory({ platform: "darwin", spawnFn })).resolves.toBe(
			null,
		);
	});

	it("darwin 意外失败（stderr 无取消标记）→ 抛错", async () => {
		const { spawnFn } = createSpawn([
			{ stderr: "execution error: something broke (-1)\n", code: 1 },
		]);
		await expect(
			pickDirectory({ platform: "darwin", spawnFn }),
		).rejects.toThrow(/osascript 执行失败/);
	});

	it("win32 成功：powershell -STA 输出路径", async () => {
		const { spawnFn, calls } = createSpawn([
			{ stdout: "C:\\work\\proj", code: 0 },
		]);
		await expect(pickDirectory({ platform: "win32", spawnFn })).resolves.toBe(
			"C:\\work\\proj",
		);
		expect(calls[0]?.command).toBe("powershell.exe");
		expect(calls[0]?.args.slice(0, 3)).toEqual([
			"-NoProfile",
			"-STA",
			"-Command",
		]);
	});

	it("win32 用户取消（exit 3）→ null", async () => {
		const { spawnFn } = createSpawn([{ code: 3 }]);
		await expect(pickDirectory({ platform: "win32", spawnFn })).resolves.toBe(
			null,
		);
	});

	it("linux：zenity 不存在时回退 kdialog 并返回路径", async () => {
		const { spawnFn, calls } = createSpawn([
			enoent("zenity"),
			{ stdout: "/home/me/proj\n", code: 0 },
		]);
		await expect(pickDirectory({ platform: "linux", spawnFn })).resolves.toBe(
			"/home/me/proj",
		);
		expect(calls.map((c) => c.command)).toEqual(["zenity", "kdialog"]);
		expect(calls[1]?.args).toEqual(["--getexistingdirectory"]);
	});

	it("linux：zenity 取消（exit 1）→ null，不再尝试 kdialog", async () => {
		const { spawnFn, calls } = createSpawn([{ code: 1 }]);
		await expect(pickDirectory({ platform: "linux", spawnFn })).resolves.toBe(
			null,
		);
		expect(calls).toHaveLength(1);
	});

	it("linux：zenity 与 kdialog 都不存在 → PickerUnavailableError", async () => {
		const { spawnFn } = createSpawn([enoent("zenity"), enoent("kdialog")]);
		await expect(
			pickDirectory({ platform: "linux", spawnFn }),
		).rejects.toBeInstanceOf(PickerUnavailableError);
	});

	it("超时：kill 子进程并抛 PickerTimeoutError", async () => {
		const { spawnFn, calls } = createSpawn([{ hang: true }]);
		await expect(
			pickDirectory({ platform: "darwin", spawnFn, timeoutMs: 20 }),
		).rejects.toBeInstanceOf(PickerTimeoutError);
		expect(calls[0]?.child.killed).toBe(1);
	});

	it("不支持的平台 → PickerUnavailableError 且不 spawn", async () => {
		const { spawnFn, calls } = createSpawn([]);
		await expect(
			pickDirectory({ platform: "aix", spawnFn }),
		).rejects.toBeInstanceOf(PickerUnavailableError);
		expect(calls).toHaveLength(0);
	});
});
