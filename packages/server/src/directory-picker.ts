// 系统原生目录选择器：macOS osascript、Windows PowerShell FolderBrowserDialog、
// Linux zenity/kdialog。取消返回 null，平台不支持抛 PickerUnavailableError，
// 系统模态框超时则 kill 子进程并抛 PickerTimeoutError。
//
// 设计要点：
// - spawnFn 可注入，单测不弹真实对话框
// - 只在 close（stdio 全部关闭）时结算，避免丢掉末尾输出
// - ENOENT 与执行失败分开：Linux 靠它决定是否回退 kdialog

import { spawn } from "node:child_process";

// 默认给用户留足操作时间；超时后强制关掉系统对话框
const DEFAULT_TIMEOUT_MS = 120_000;

const PROMPT = "选择工作区目录";

// Windows PowerShell 脚本：-STA 是 FolderBrowserDialog 的硬要求；
// 用户取消时以退出码 3 区分于真正的执行失败
const WINDOWS_SCRIPT = `Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='${PROMPT}'; if($d.ShowDialog() -eq 'OK'){[Console]::Out.Write($d.SelectedPath)}else{exit 3}`;

export class PickerUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PickerUnavailableError";
	}
}

export class PickerTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PickerTimeoutError";
	}
}

export interface PickDirectoryOptions {
	platform?: string;
	timeoutMs?: number;
	spawnFn?: typeof spawn;
}

interface CommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

// 子进程没起来（ENOENT 等）与正常退出区分开；Linux 用它判断是否回退
class CommandSpawnError extends Error {
	readonly code: string | undefined;

	constructor(message: string, code: string | undefined) {
		super(message);
		this.name = "CommandSpawnError";
		this.code = code;
	}
}

// 跑一条命令并把 stdout/stderr 收全：close 时结算，超时先 kill 再拒绝
function runCommand(
	command: string,
	args: string[],
	spawnFn: typeof spawn,
	timeoutMs: number,
): Promise<CommandResult> {
	return new Promise<CommandResult>((resolvePromise, rejectPromise) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let child: ReturnType<typeof spawn>;
		try {
			child = spawnFn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			rejectPromise(err instanceof Error ? err : new Error(String(err)));
			return;
		}
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			rejectPromise(
				new PickerTimeoutError(
					`系统目录选择器超时（${timeoutMs}ms），已关闭对话框`,
				),
			);
		}, timeoutMs);
		const settle = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (err) => {
			const code = (err as { code?: string }).code;
			settle(() =>
				rejectPromise(
					new CommandSpawnError(`无法启动 ${command}: ${err.message}`, code),
				),
			);
		});
		child.on("close", (code) => {
			settle(() => resolvePromise({ code, stdout, stderr }));
		});
	});
}

// 成功退出必须是非空路径；空输出说明后端行为异常，按真实失败处理
function requirePath(stdout: string): string {
	const picked = stdout.trim();
	if (picked === "") {
		throw new Error("目录选择器未返回路径");
	}
	return picked;
}

function failureMessage(command: string, result: CommandResult): string {
	const detail = result.stderr.trim();
	return `${command} 执行失败（退出码 ${String(result.code)}）${detail === "" ? "" : `: ${detail}`}`;
}

async function pickOnDarwin(
	spawnFn: typeof spawn,
	timeoutMs: number,
): Promise<string | null> {
	const result = await runCommand(
		"osascript",
		["-e", `POSIX path of (choose folder with prompt "${PROMPT}")`],
		spawnFn,
		timeoutMs,
	);
	if (result.code === 0) {
		return requirePath(result.stdout);
	}
	// osascript 的用户取消是 "execution error: User canceled. (-128)"
	if (/user canceled/i.test(result.stderr)) {
		return null;
	}
	throw new Error(failureMessage("osascript", result));
}

async function pickOnWindows(
	spawnFn: typeof spawn,
	timeoutMs: number,
): Promise<string | null> {
	const result = await runCommand(
		"powershell.exe",
		["-NoProfile", "-STA", "-Command", WINDOWS_SCRIPT],
		spawnFn,
		timeoutMs,
	);
	// 脚本约定：取消 exit 3，成功 exit 0 并输出 SelectedPath
	if (result.code === 3) {
		return null;
	}
	if (result.code === 0) {
		return requirePath(result.stdout);
	}
	throw new Error(failureMessage("powershell.exe", result));
}

async function pickOnLinux(
	spawnFn: typeof spawn,
	timeoutMs: number,
): Promise<string | null> {
	// 优先 zenity（GNOME）；仅当命令不存在（ENOENT）才回退 kdialog（KDE）
	try {
		const result = await runCommand(
			"zenity",
			["--file-selection", "--directory", `--title=${PROMPT}`],
			spawnFn,
			timeoutMs,
		);
		if (result.code === 0) {
			return requirePath(result.stdout);
		}
		if (result.code === 1) {
			return null;
		}
		throw new Error(failureMessage("zenity", result));
	} catch (err) {
		if (!(err instanceof CommandSpawnError) || err.code !== "ENOENT") {
			throw err;
		}
	}
	try {
		const result = await runCommand(
			"kdialog",
			["--getexistingdirectory"],
			spawnFn,
			timeoutMs,
		);
		if (result.code === 0) {
			return requirePath(result.stdout);
		}
		if (result.code === 1) {
			return null;
		}
		throw new Error(failureMessage("kdialog", result));
	} catch (err) {
		if (err instanceof CommandSpawnError && err.code === "ENOENT") {
			throw new PickerUnavailableError(
				"未找到可用的目录选择器（zenity/kdialog 均不可用）",
			);
		}
		throw err;
	}
}

export async function pickDirectory(
	opts: PickDirectoryOptions = {},
): Promise<string | null> {
	const platform = opts.platform ?? process.platform;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const spawnFn = opts.spawnFn ?? spawn;
	if (platform === "darwin") {
		return pickOnDarwin(spawnFn, timeoutMs);
	}
	if (platform === "win32") {
		return pickOnWindows(spawnFn, timeoutMs);
	}
	if (platform === "linux") {
		return pickOnLinux(spawnFn, timeoutMs);
	}
	throw new PickerUnavailableError(`当前平台不支持系统目录选择器: ${platform}`);
}
