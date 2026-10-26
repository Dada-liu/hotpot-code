// SSE 封装：EventSource 断线自动重连，且重连请求自动携带 Last-Event-ID
// （server 的 resolveAfterSeq 优先读 query ?after=，其次 Last-Event-ID），
// 因此客户端不需要自己拼 ?after=。连接状态经 onState 回调透出，
// 用于顶栏「连接断开，重连中…」横幅。

import { withApiToken } from "./auth.ts";
import type { WireEvent } from "./protocol.ts";

export type ConnectionState = "open" | "reconnecting";

export interface EventConnection {
	close(): void;
}

export function connect(
	sessionId: string,
	onEvent: (event: WireEvent) => void,
	onState?: (state: ConnectionState) => void,
): EventConnection {
	const source = new EventSource(
		withApiToken(`/api/sessions/${encodeURIComponent(sessionId)}/events`),
	);
	source.onopen = () => {
		onState?.("open");
	};
	source.onmessage = (msg: MessageEvent<string>) => {
		// 帧格式 data: JSON.stringify(WireEvent)；解析失败（异常帧）直接丢弃
		let event: WireEvent;
		try {
			event = JSON.parse(msg.data) as WireEvent;
		} catch {
			return;
		}
		onEvent(event);
	};
	source.onerror = () => {
		// EventSource 内部会自动按指数退避重连，这里只透传状态
		onState?.("reconnecting");
	};
	return {
		close: () => {
			source.close();
		},
	};
}
