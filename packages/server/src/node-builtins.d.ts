// 依赖白名单不允许引入 @types/node，在此做最小 ambient 声明；运行时由 Node 提供真身。
// 本包经 workspace 源码直引 @hotpot/core，tsc 会把 core 的源码拉进同一编译，
// 因此本文件必须是 packages/core/src/node-builtins.d.ts 的超集，再加上 server 自身用到的 API。

interface HotpotFileHandle {
	read(
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: number,
	): Promise<{
		bytesRead: number;
	}>;
	stat(): Promise<{ size: number }>;
	write(data: string): Promise<unknown>;
	sync(): Promise<unknown>;
	close(): Promise<void>;
}

// 子进程 stdout/stderr 的可读流（core 用到；chunk 运行时是 Buffer，结构上有 toString）
interface HotpotChildStream {
	on(event: "data", listener: (chunk: { toString(): string }) => void): void;
	removeAllListeners(): void;
	destroy(): void;
}

// fs.watch 返回的句柄：只用到关闭与错误事件
interface HotpotFsWatcher {
	close(): void;
	on(event: "error", listener: (err: Error) => void): void;
}

// readdir withFileTypes 形态的目录项：core skills.ts 递归扫描用它区分文件/目录
interface HotpotDirent {
	name: string;
	isDirectory(): boolean;
	isFile(): boolean;
}

declare module "node:fs/promises" {
	export function open(
		path: string,
		flags: "r" | "a",
	): Promise<HotpotFileHandle>;
	export function mkdir(
		path: string,
		options?: { recursive?: boolean },
	): Promise<string | undefined>;
	// 无编码重载：静态托管按字节读二进制资产（png/webp 等）
	export function readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
	export function readFile(path: string, encoding: "utf8"): Promise<string>;
	export function writeFile(path: string, data: string): Promise<void>;
	// 二参字节重载：静态托管测试写假 PNG 夹具
	export function writeFile(path: string, data: Uint8Array): Promise<void>;
	// 三参重载：会话管理器测试按 utf8 显式写夹具文件（与 core 的两参声明合并为重载）
	export function writeFile(
		path: string,
		data: string,
		encoding: string,
	): Promise<void>;
	// 上传落盘用独占旗标（wx）：counter 递增保证唯一，写时再防覆盖兜底
	export function writeFile(
		path: string,
		data: string,
		options: { encoding?: string; flag?: string },
	): Promise<void>;
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
	// 会话创建 cwd 校验（须为已存在目录）
	export function stat(
		path: string,
	): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
	// 工作区浏览 realpath 解析（逃逸校验用）
	export function realpath(path: string): Promise<string>;
	// 工作区注册表（core）原子写盘
	export function rename(oldPath: string, newPath: string): Promise<void>;
}

declare module "node:fs" {
	export function existsSync(path: string): boolean;
	export function statSync(path: string): {
		isDirectory(): boolean;
		isFile(): boolean;
	};
	export function readFileSync(path: string, encoding: "utf8"): string;
	// 工作区 findByPath 是同步方法
	export function realpathSync(path: string): string;
	// 遥测包（install-id）经 workspace 源码直引，这里补上它用到的同步写 API
	export function writeFileSync(
		path: string,
		data: string,
		encoding?: "utf8",
	): void;
	export function mkdirSync(
		path: string,
		options?: { recursive?: boolean },
	): string | undefined;
	export function watch(
		path: string,
		listener: (event: string, filename: string | null) => void,
	): HotpotFsWatcher;
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
	export function extname(path: string): string;
	export function isAbsolute(path: string): boolean;
	export const sep: string;
}

declare module "node:url" {
	export function fileURLToPath(url: string | URL): string;
}

declare module "node:crypto" {
	export function randomUUID(): string;
}

// ---- node:http 家族：@hono/node-server 的类型面 + serve 返回句柄的关断/寻址 ----

interface HotpotAddressInfo {
	address: string;
	family: string;
	port: number;
}

declare module "node:net" {
	export interface AddressInfo extends HotpotAddressInfo {}
}

declare module "node:stream" {
	export interface Duplex {
		on(event: string, listener: (...args: unknown[]) => void): Duplex;
		destroy(error?: Error): void;
	}
}

interface HotpotHttpServer {
	listen(
		port: number,
		hostname?: string,
		listeningListener?: () => void,
	): HotpotHttpServer;
	close(callback?: (err?: Error) => void): void;
	closeAllConnections(): void;
	address(): HotpotAddressInfo | string | null;
	on(event: string, listener: (...args: unknown[]) => void): HotpotHttpServer;
}

declare module "node:http" {
	export interface IncomingMessage {
		method?: string;
		url?: string;
		headers: Record<string, string | string[] | undefined>;
	}
	export interface ServerResponse {
		writeHead(status: number, headers?: Record<string, string>): ServerResponse;
		end(chunk?: string | Uint8Array): void;
		on(event: string, listener: (...args: unknown[]) => void): ServerResponse;
	}
	export interface ServerOptions {}
	export interface Server extends HotpotHttpServer {}
	export function createServer(
		options: ServerOptions,
		listener?: (req: IncomingMessage, res: ServerResponse) => void,
	): Server;
}

declare module "node:https" {
	export interface ServerOptions {}
	export interface Server extends HotpotHttpServer {}
	export function createServer(
		options: ServerOptions,
		listener?: (req: unknown, res: unknown) => void,
	): Server;
}

declare module "node:http2" {
	export interface Http2ServerRequest {}
	export interface Http2ServerResponse {}
	export interface ServerOptions {}
	export interface SecureServerOptions {}
	export interface Http2Server extends HotpotHttpServer {}
	export interface Http2SecureServer extends HotpotHttpServer {}
	export function createServer(
		options: ServerOptions,
		listener?: (req: Http2ServerRequest, res: Http2ServerResponse) => void,
	): Http2Server;
	export function createSecureServer(
		options: SecureServerOptions,
		listener?: (req: Http2ServerRequest, res: Http2ServerResponse) => void,
	): Http2SecureServer;
}

declare const process: {
	env: Record<string, string | undefined>;
	platform: string;
	version: string;
	cwd(): string;
	kill(pid: number, signal?: string): boolean;
};
