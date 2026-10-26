import { afterEach, describe, expect, it, vi } from "vitest";
import {
	authenticatedFetch,
	initializeAuth,
	withApiToken,
} from "../src/auth.ts";

function stubBrowser(href: string) {
	const values = new Map<string, string>();
	const replacements: string[] = [];
	vi.stubGlobal("window", {
		location: { href, origin: new URL(href).origin },
		sessionStorage: {
			getItem(key: string) {
				return values.get(key) ?? null;
			},
			setItem(key: string, value: string) {
				values.set(key, value);
			},
		},
		history: {
			state: null,
			replaceState(_state: unknown, _unused: string, url: string) {
				replacements.push(url);
			},
		},
	});
	return { values, replacements };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Web API 认证", () => {
	it("启动时保存 URL token、清理地址栏，并为 fetch 合并 Bearer 头", async () => {
		const browser = stubBrowser(
			"http://127.0.0.1:4573/?foo=bar&token=token%20%2F%2B#main",
		);
		const requests: RequestInit[] = [];
		vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
			if (init !== undefined) requests.push(init);
			return Promise.resolve(new Response("ok"));
		});

		initializeAuth();
		expect(browser.values.get("hotpot.apiToken")).toBe("token /+");
		expect(browser.replacements).toEqual(["/?foo=bar#main"]);
		await authenticatedFetch("/api/sessions", {
			headers: { "content-type": "application/json" },
		});
		const headers = new Headers(requests[0]?.headers);
		expect(headers.get("authorization")).toBe("Bearer token /+");
		expect(headers.get("content-type")).toBe("application/json");
	});

	it("无 URL token 的刷新沿用会话存储，SSE URL 正确编码 token", () => {
		const browser = stubBrowser("http://127.0.0.1:4573/");
		browser.values.set("hotpot.apiToken", "saved /+");
		initializeAuth();
		expect(browser.replacements).toEqual([]);
		expect(withApiToken("/api/sessions/s1/events")).toBe(
			"http://127.0.0.1:4573/api/sessions/s1/events?access_token=saved+%2F%2B",
		);
	});

	it("没有 token 时不改变请求 URL", () => {
		stubBrowser("http://127.0.0.1:4573/");
		expect(withApiToken("/api/sessions")).toBe("/api/sessions");
	});
});
