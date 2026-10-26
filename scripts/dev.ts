// 用法：pnpm dev <pkg> [args...]
// 把包名映射到 packages/<pkg>/src/bin.ts 并用 tsx 直跑（开发模式，无需构建）。
// web 为复合入口：先构建 Web 产物，再启动 server，端口就绪后自动打开浏览器。
// 例：pnpm dev cli chat / pnpm dev web
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";

const [pkg, ...args] = process.argv.slice(2);

if (!pkg || !/^[a-z][a-z0-9-]*$/.test(pkg)) {
	console.error(
		"用法: pnpm dev <pkg> [args...]（pkg 为 packages/ 下的目录名，如 cli、web）",
	);
	process.exit(1);
}

const isWeb = pkg === "web";
const apiToken = isWeb
	? process.env.HOTPOT_API_TOKEN || randomBytes(32).toString("base64url")
	: undefined;
const entry = isWeb
	? "packages/server/src/bin.ts"
	: `packages/${pkg}/src/bin.ts`;
if (!existsSync(entry)) {
	console.error(`入口不存在: ${entry}（@hotpot/${pkg} 暂无可运行入口）`);
	process.exit(1);
}

function run(command: string, commandArgs: string[]): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(command, commandArgs, {
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		child.on("error", () => resolve(1));
		child.on("exit", (code) => resolve(code ?? 1));
	});
}

function openBrowser(url: string): void {
	const opener =
		process.platform === "darwin"
			? { command: "open", args: [url] }
			: process.platform === "win32"
				? { command: "cmd", args: ["/c", "start", "", url] }
				: { command: "xdg-open", args: [url] };
	const child = spawn(opener.command, opener.args, {
		stdio: "ignore",
		detached: true,
	});
	child.on("error", () => {
		console.log(`[web] 无法自动打开浏览器，请手动访问 ${url}`);
	});
	child.unref();
}

async function openWhenReady(
	url: string,
	hasExited: () => boolean,
): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (hasExited()) {
			return;
		}
		try {
			const response = await fetch(url, {
				signal: AbortSignal.timeout(1000),
			});
			if (response.status < 500) {
				console.log(`[web] 已启动: ${url}`);
				openBrowser(url);
				return;
			}
		} catch {
			// 服务尚未就绪，继续轮询
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	console.log(`[web] 等待服务就绪超时，请手动访问 ${url}`);
}

if (isWeb) {
	console.log("[web] 构建 Web 产物 ...");
	const code = await run("pnpm", ["--filter", "@hotpot/web", "build"]);
	if (code !== 0) {
		process.exit(code);
	}
}

// 经 pnpm scripts 运行时 node_modules/.bin 已在 PATH 中，可直接解析 tsx
const child = spawn("tsx", [entry, ...args], {
	stdio: "inherit",
	shell: process.platform === "win32",
	env: {
		...process.env,
		...(apiToken === undefined ? {} : { HOTPOT_API_TOKEN: apiToken }),
	},
});

if (isWeb && apiToken !== undefined) {
	const port = Number(process.env.HOTPOT_PORT ?? 4573);
	const token = encodeURIComponent(apiToken);
	void openWhenReady(
		`http://localhost:${port}?token=${token}`,
		() => child.exitCode !== null,
	);
}

child.on("exit", (code) => {
	process.exit(code ?? 1);
});
