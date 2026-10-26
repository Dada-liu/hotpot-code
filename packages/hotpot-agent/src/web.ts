// hotpot web：启动本地 server（REST + SSE + 静态 Web）并在就绪后打开浏览器。
// 静态目录优先使用打包后的 dist/web；源码态回退到仓库的 packages/web/dist 与 public/。
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "@hotpot/server";
import { openBrowser } from "./open-browser.ts";

export interface WebCliArgs {
	port?: number;
	hostname: string;
	open: boolean;
}

const USAGE = "用法: hotpot web [--port <n>] [--host <addr>] [--no-open]";

export function parseWebArgs(argv: string[]): WebCliArgs {
	const args: WebCliArgs = { hostname: "127.0.0.1", open: true };
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		if (flag === "--port" || flag === "-p") {
			const value = argv[i + 1];
			if (value === undefined) {
				throw new Error(`--port 缺少端口参数\n${USAGE}`);
			}
			const port = Number(value);
			if (!Number.isInteger(port) || port < 0 || port > 65535) {
				throw new Error(`--port 只接受 0-65535 的整数\n${USAGE}`);
			}
			args.port = port;
			i += 1;
		} else if (flag === "--host") {
			const value = argv[i + 1];
			if (value === undefined || value === "") {
				throw new Error(`--host 缺少地址参数\n${USAGE}`);
			}
			args.hostname = value;
			i += 1;
		} else if (flag === "--no-open") {
			args.open = false;
		} else {
			throw new Error(`未知参数: ${flag}\n${USAGE}`);
		}
	}
	return args;
}

// 打包布局：<包根>/dist/bin.js + <包根>/dist/web
// 源码布局：packages/hotpot-agent/src/web.ts → 仓库根/packages/web/dist 与 仓库根/public
function defaultDirs(): { webDist: string; publicDir: string } {
	const here = dirname(fileURLToPath(import.meta.url));
	const packaged = join(here, "web");
	if (existsSync(packaged)) {
		return { webDist: packaged, publicDir: packaged };
	}
	return {
		webDist: resolve(here, "../../..", "packages", "web", "dist"),
		publicDir: resolve(here, "../../..", "public"),
	};
}

export function formatWebUrl(
	hostname: string,
	port: number,
	apiToken: string,
): string {
	const connectable =
		hostname === "0.0.0.0" || hostname === "::" ? "localhost" : hostname;
	const host = connectable.includes(":") ? `[${connectable}]` : connectable;
	return `http://${host}:${port}?token=${encodeURIComponent(apiToken)}`;
}

export async function runWebCli(argv: string[]): Promise<number> {
	let args: WebCliArgs;
	try {
		args = parseWebArgs(argv);
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 1;
	}

	const defaults = defaultDirs();
	const webDist = process.env.HOTPOT_WEB_DIST ?? defaults.webDist;
	const publicDir = process.env.HOTPOT_PUBLIC_DIR ?? defaults.publicDir;
	if (!existsSync(webDist)) {
		process.stderr.write(`[web] 未找到 Web 产物: ${webDist}\n`);
	}

	const server = startServer({
		port: args.port,
		hostname: args.hostname,
		webDist,
		publicDir,
		onListening: (info) => {
			const url = formatWebUrl(info.hostname, info.port, info.apiToken);
			process.stdout.write(`hotpot web listening on ${url}\n`);
			if (args.open) {
				openBrowser(url);
			}
		},
	});
	server.on("error", (error) => {
		process.stderr.write(
			`hotpot web 启动失败: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	});
	return 0;
}
