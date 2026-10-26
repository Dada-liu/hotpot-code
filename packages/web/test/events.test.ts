import { afterEach, describe, expect, it, vi } from "vitest";
import { connect } from "../src/events.ts";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("SSE 认证", () => {
	it("EventSource 使用带 access_token 的会话事件 URL", () => {
		const urls: string[] = [];
		class FakeEventSource {
			onopen: (() => void) | null = null;
			onmessage: ((msg: MessageEvent<string>) => void) | null = null;
			onerror: (() => void) | null = null;
			constructor(url: string) {
				urls.push(url);
			}
			close(): void {}
		}
		vi.stubGlobal("EventSource", FakeEventSource);
		vi.stubGlobal("window", {
			location: { origin: "http://127.0.0.1:4573" },
			sessionStorage: { getItem: () => "token /+" },
		});

		const connection = connect("session id", () => {});
		expect(urls).toEqual([
			"http://127.0.0.1:4573/api/sessions/session%20id/events?access_token=token+%2F%2B",
		]);
		connection.close();
	});
});
