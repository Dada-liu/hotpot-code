// 工作区分组：按注册表顺序切组，组内会话按 sessionIds 顺序排列；
// 未归属任何工作区的会话（含注册表里的悬空 id）进「未分组」并按创建时间降序。
// 纯函数，node 下可单测。

import type { SessionSummary, WorkspaceWire } from "../api.ts";

export interface WorkspaceGroup {
	workspace: WorkspaceWire;
	sessions: SessionSummary[];
}

export interface GroupedSessions {
	groups: WorkspaceGroup[];
	ungrouped: SessionSummary[];
}

function createdTime(iso: string): number {
	const t = Date.parse(iso);
	return Number.isNaN(t) ? 0 : t;
}

// 防御性去重：服务端保证一个会话只属一个工作区，但客户端仍以首次出现为准，
// 避免注册表脏数据让同一会话在侧栏出现两次
export function groupSessionsByWorkspace(
	workspaces: WorkspaceWire[],
	sessions: SessionSummary[],
): GroupedSessions {
	const byId = new Map(sessions.map((s) => [s.id, s]));
	const claimed = new Set<string>();
	const groups = workspaces.map((workspace) => {
		const members: SessionSummary[] = [];
		for (const id of workspace.sessionIds) {
			if (claimed.has(id)) {
				continue;
			}
			const session = byId.get(id);
			if (session === undefined) {
				// 注册表保留未知 id（磁盘会话可能已删除）：客户端按实际会话过滤
				continue;
			}
			claimed.add(id);
			members.push(session);
		}
		return { workspace, sessions: members };
	});
	const ungrouped = sessions
		.filter((s) => !claimed.has(s.id))
		.sort((a, b) => createdTime(b.createdAt) - createdTime(a.createdAt));
	return { groups, ungrouped };
}

export function workspaceForSession(
	workspaces: WorkspaceWire[],
	sessionId: string,
): WorkspaceWire | null {
	return workspaces.find((w) => w.sessionIds.includes(sessionId)) ?? null;
}
