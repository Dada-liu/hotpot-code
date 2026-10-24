// 依赖白名单不允许引入 @types/node，在此做最小 ambient 声明；运行时由 Node 提供真身。
// 注意：本包经 workspace 源码直引 @hotpot/core，tsc 会把 core 的源码拉进同一编译，
// 因此本文件必须是 packages/core/src/node-builtins.d.ts 的超集，再加上 telemetry 自身用到的 API。

interface HotpotFileHandle {
	write(data: string): Promise<unknown>;
	sync(): Promise<void>;
	close(): Promise<void>;
}

// readdir withFileTypes 形态的目录项：core skills.ts 递归扫描用它区分文件/目录
interface HotpotDirent {
	name: string;
	isDirectory(): boolean;
	isFile(): boolean;
}

// 子进程 stdout/stderr 的可读流（只用到 data 事件；chunk 运行时是 Buffer，结构上有 toString）
interface HotpotChildStream {
	on(event: "data", listener: (chunk: { toString(): string }) => void): void;
	removeAllListeners(): void;
	destroy(): void;
}

declare module "node:fs/promises" {
	export function open(path: string, flags: "a"): Promise<HotpotFileHandle>;
	export function mkdir(
		path: string,
		options?: { recursive?: boolean },
	): Promise<string | undefined>;
	export function readFile(path: string, encoding: "utf8"): Promise<string>;
	export function writeFile(path: string, data: string): Promise<void>;
	export function readdir(path: string): Promise<string[]>;
	export function readdir(
		path: string,
		options: { withFileTypes: true },
	): Promise<HotpotDirent[]>;
	export function appendFile(path: string, data: string): Promise<void>;
	export function mkdtemp(prefix: string): Promise<string>;
	export function rm(
		path: string,
		options?: { recursive?: boolean; force?: boolean },
	): Promise<void>;
	// 工作区注册表（core）编译进本包：realpath/stat 校验目录，rename 原子替换存储
	export function stat(
		path: string,
	): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
	export function realpath(path: string): Promise<string>;
	export function rename(oldPath: string, newPath: string): Promise<void>;
}

declare module "node:fs" {
	export function existsSync(path: string): boolean;
	export function readFileSync(path: string, encoding: "utf8"): string;
	// 工作区 findByPath 是同步方法
	export function realpathSync(path: string): string;
	export function writeFileSync(
		path: string,
		data: string,
		encoding?: "utf8",
	): void;
	export function mkdirSync(
		path: string,
		options?: { recursive?: boolean },
	): string | undefined;
	export function chmodSync(path: string, mode: number): void;
}

declare module "node:child_process" {
	export interface HotpotChildProcess {
		pid?: number;
		stdin: {
			write(data: string): unknown;
			end(): void;
			on(event: "error", listener: (err: Error) => void): void;
		} | null;
		stdout: HotpotChildStream | null;
		stderr: HotpotChildStream | null;
		kill(signal?: string): boolean;
		unref(): void;
		on(event: "error", listener: (err: Error) => void): void;
		on(
			event: "exit",
			listener: (code: number | null, signal: string | null) => void,
		): void;
		// close 在进程退出且 stdio 流全部关闭后触发，用它结算可避免丢失末尾输出
		on(
			event: "close",
			listener: (code: number | null, signal: string | null) => void,
		): void;
	}
	export function spawn(
		command: string,
		args: string[],
		options?: {
			cwd?: string;
			env?: Record<string, string | undefined>;
			detached?: boolean;
			stdio?: ("ignore" | "pipe" | "inherit")[];
		},
	): HotpotChildProcess;
}

declare module "node:os" {
	export function homedir(): string;
	export function tmpdir(): string;
}

declare module "node:path" {
	export function basename(path: string, suffix?: string): string;
	export function join(...parts: string[]): string;
	export function resolve(...parts: string[]): string;
	export function dirname(path: string): string;
	export function isAbsolute(path: string): boolean;
}

declare module "node:crypto" {
	export function randomUUID(): string;
}

declare const process: {
	env: Record<string, string | undefined>;
	platform: string;
	version: string;
	cwd(): string;
	kill(pid: number, signal?: string): boolean;
};
