import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HotpotServer, startServer } from "../src/serve.ts";

interface ListeningInfo {
	port: number;
	hostname: string;
	apiToken: string;
}

let home: string;
let webDist: string;
let publicDir: string;
let oldApiToken: string | undefined;
const servers: HotpotServer[] = [];

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-serve-home-"));
	webDist = await mkdtemp(join(tmpdir(), "hotpot-serve-web-"));
	publicDir = await mkdtemp(join(tmpdir(), "hotpot-serve-public-"));
	oldApiToken = process.env.HOTPOT_API_TOKEN;
	delete process.env.HOTPOT_API_TOKEN;
	await writeFile(join(webDist, "index.html"), "<h1>hotpot</h1>", "utf8");
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			models: {
				high: { provider: "p", model: "h", apiKey: "hk" },
				medium: { provider: "p", model: "m", apiKey: "mk" },
				low: { provider: "p", model: "l", apiKey: "lk" },
			},
		}),
		"utf8",
	);
});

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}
	if (oldApiToken === undefined) {
		delete process.env.HOTPOT_API_TOKEN;
	} else {
		process.env.HOTPOT_API_TOKEN = oldApiToken;
	}
	await Promise.all([
		rm(home, { recursive: true, force: true }),
		rm(webDist, { recursive: true, force: true }),
		rm(publicDir, { recursive: true, force: true }),
	]);
});

async function start(apiToken?: string): Promise<ListeningInfo> {
	let resolveListening: (info: ListeningInfo) => void;
	const listening = new Promise<ListeningInfo>((resolve) => {
		resolveListening = resolve;
	});
	const server = startServer({
		port: 0,
		home,
		webDist,
		publicDir,
		...(apiToken === undefined ? {} : { apiToken }),
		onListening: (info) => resolveListening(info),
	});
	servers.push(server);
	return listening;
}

function authorized(url: string, token: string): Promise<Response> {
	return fetch(url, { headers: { authorization: `Bearer ${token}` } });
}

describe("startServer 安全默认值", () => {
	it("默认只监听回环地址，REST 必须认证而静态资源无需认证", async () => {
		const info = await start("test-token");
		const base = `http://127.0.0.1:${info.port}`;
		expect(info.hostname).toBe("127.0.0.1");

		for (const authorization of [undefined, "Bearer wrong", "Bearer "]) {
			const response = await fetch(`${base}/api/sessions`, {
				headers: authorization === undefined ? {} : { authorization },
			});
			expect(response.status).toBe(401);
		}
		const queryOnly = await fetch(
			`${base}/api/sessions?access_token=test-token`,
		);
		expect(queryOnly.status).toBe(401);
		const authenticated = await authorized(
			`${base}/api/sessions`,
			info.apiToken,
		);
		expect(authenticated.status).toBe(200);

		const page = await fetch(base);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("hotpot");
	});

	it("SSE 仅允许 events 路由通过 access_token 认证", async () => {
		const info = await start("test-token");
		const base = `http://127.0.0.1:${info.port}`;
		const created = await authorized(`${base}/api/sessions`, info.apiToken);
		expect(created.status).toBe(200);
		const response = await fetch(`${base}/api/sessions`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${info.apiToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ cwd: home, workspaceId: null }),
		});
		expect(response.status).toBe(201);
		const { id } = (await response.json()) as { id: string };

		const denied = await fetch(`${base}/api/sessions/${id}/events`);
		expect(denied.status).toBe(401);
		const events = await fetch(
			`${base}/api/sessions/${id}/events?access_token=${info.apiToken}`,
		);
		expect(events.status).toBe(200);
		expect(events.headers.get("content-type")).toContain("text/event-stream");
		await events.body?.cancel();
	});

	it("非空环境变量固定 token，空环境变量不能关闭认证", async () => {
		process.env.HOTPOT_API_TOKEN = "env-token";
		const fixed = await start();
		expect(fixed.apiToken).toBe("env-token");
		expect(
			(
				await authorized(
					`http://127.0.0.1:${fixed.port}/api/sessions`,
					"env-token",
				)
			).status,
		).toBe(200);

		process.env.HOTPOT_API_TOKEN = "";
		const random = await start();
		expect(random.apiToken.length).toBeGreaterThanOrEqual(32);
		expect(random.apiToken).not.toBe("env-token");
		expect(
			(await fetch(`http://127.0.0.1:${random.port}/api/sessions`)).status,
		).toBe(401);
	});
});
