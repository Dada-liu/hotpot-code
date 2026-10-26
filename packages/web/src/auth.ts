const API_TOKEN_STORAGE_KEY = "hotpot.apiToken";

function apiToken(): string | null {
	return window.sessionStorage.getItem(API_TOKEN_STORAGE_KEY);
}

// 启动令牌只经首次 URL 引导；随后从地址栏移除，刷新时由会话存储恢复
export function initializeAuth(): void {
	const url = new URL(window.location.href);
	const token = url.searchParams.get("token");
	if (token === null) return;
	if (token !== "") {
		window.sessionStorage.setItem(API_TOKEN_STORAGE_KEY, token);
	}
	url.searchParams.delete("token");
	window.history.replaceState(
		window.history.state,
		"",
		`${url.pathname}${url.search}${url.hash}`,
	);
}

export function authenticatedFetch(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const token = apiToken();
	if (token === null) return fetch(input, init);
	const headers = new Headers(init?.headers);
	headers.set("Authorization", `Bearer ${token}`);
	return fetch(input, { ...init, headers });
}

export function withApiToken(path: string): string {
	const token = apiToken();
	if (token === null) return path;
	const url = new URL(path, window.location.origin);
	url.searchParams.set("access_token", token);
	return url.toString();
}
