import {
	mkdir,
	mkdtemp,
	readdir,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	openWorkspaceRegistry,
	WorkspaceError,
} from "../src/workspace/workspace.ts";

// 每个用例独立的 home（注册表）与 root（工作区目录），互不干扰
let home: string;
let root: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-workspace-home-"));
	root = await mkdtemp(join(tmpdir(), "hotpot-workspace-root-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
	await rm(root, { recursive: true, force: true });
});

// 断言 Promise 以指定错误码的 WorkspaceError 拒绝
async function expectCode(
	promise: Promise<unknown>,
	code: WorkspaceError["code"],
): Promise<WorkspaceError> {
	try {
		await promise;
	} catch (err) {
		expect(err).toBeInstanceOf(WorkspaceError);
		const error = err as WorkspaceError;
		expect(error.code).toBe(code);
		return error;
	}
	throw new Error(`expected WorkspaceError with code ${code}`);
}

async function makeDir(name: string): Promise<string> {
	const dir = join(root, name);
	await mkdir(dir, { recursive: true });
	return dir;
}

function openRegistry() {
	return openWorkspaceRegistry({ home });
}

describe("加载与持久化", () => {
	it("缺少存储文件时返回空注册表", async () => {
		const registry = await openRegistry();
		expect(registry.list()).toEqual([]);
	});

	it("存储 JSON 损坏时抛 invalid-storage", async () => {
		await writeFile(join(home, "workspaces.json"), "{not json");
		await expectCode(openRegistry(), "invalid-storage");
	});

	it("版本不是 1 时抛 invalid-storage", async () => {
		await writeFile(
			join(home, "workspaces.json"),
			JSON.stringify({ version: 2, workspaces: [] }),
		);
		await expectCode(openRegistry(), "invalid-storage");
	});

	it("记录缺字段时抛 invalid-storage", async () => {
		await writeFile(
			join(home, "workspaces.json"),
			JSON.stringify({ version: 1, workspaces: [{ id: "w1" }] }),
		);
		await expectCode(openRegistry(), "invalid-storage");
	});

	it("重复 id 的存储视为损坏", async () => {
		const record = {
			id: "dup",
			path: "/tmp/a",
			title: "a",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			sessionIds: [],
		};
		await writeFile(
			join(home, "workspaces.json"),
			JSON.stringify({ version: 1, workspaces: [record, record] }),
		);
		await expectCode(openRegistry(), "invalid-storage");
	});

	it("保存后重新打开得到同样的记录", async () => {
		const registry = await openRegistry();
		const alpha = await makeDir("alpha");
		const beta = await makeDir("beta");
		const createdAlpha = await registry.create(alpha);
		await registry.create(beta);
		await registry.rename(createdAlpha.workspace.id, "项目 A");
		await registry.attachSession(createdAlpha.workspace.id, "s1");

		const before = registry.list();
		const reopened = await openRegistry();
		expect(reopened.list()).toEqual(before);
	});

	it("正常保存后不残留 .tmp 文件", async () => {
		const registry = await openRegistry();
		await registry.create(await makeDir("alpha"));
		const files = await readdir(home);
		expect(files).toEqual(["workspaces.json"]);
	});
});

describe("create", () => {
	it("使用 canonical 路径、目录名作标题，并插到列表头部", async () => {
		const registry = await openRegistry();
		const alpha = await makeDir("alpha");
		const beta = await makeDir("beta");
		const first = await registry.create(alpha);
		const second = await registry.create(beta);

		expect(first.created).toBe(true);
		expect(first.workspace.path).toBe(await realpath(alpha));
		expect(first.workspace.title).toBe("alpha");
		expect(first.workspace.sessionIds).toEqual([]);
		expect(second.created).toBe(true);
		expect(registry.list().map((workspace) => workspace.id)).toEqual([
			second.workspace.id,
			first.workspace.id,
		]);
	});

	it("相对路径被拒绝", async () => {
		const registry = await openRegistry();
		await expectCode(registry.create("relative/dir"), "invalid-path");
	});

	it("不存在的路径被拒绝，错误信息包含该路径", async () => {
		const registry = await openRegistry();
		const missing = join(root, "missing");
		const error = await expectCode(registry.create(missing), "invalid-path");
		expect(error.message).toContain(missing);
	});

	it("文件（非目录）被拒绝", async () => {
		const registry = await openRegistry();
		const file = join(root, "file.txt");
		await writeFile(file, "x");
		await expectCode(registry.create(file), "invalid-path");
	});

	it("symlink 命中已有工作区时返回 created:false", async () => {
		const registry = await openRegistry();
		const target = await makeDir("alpha");
		const created = await registry.create(target);
		const link = join(root, "alpha-link");
		await symlink(target, link);

		const duplicate = await registry.create(link);
		expect(duplicate.created).toBe(false);
		expect(duplicate.workspace.id).toBe(created.workspace.id);
		expect(duplicate.workspace.path).toBe(await realpath(target));
		expect(registry.list()).toHaveLength(1);
	});
});

describe("rename", () => {
	it("trim 后保存标题", async () => {
		const registry = await openRegistry();
		const created = await registry.create(await makeDir("alpha"));
		const renamed = await registry.rename(created.workspace.id, "  项目 A  ");
		expect(renamed.title).toBe("项目 A");

		const reopened = await openRegistry();
		expect(reopened.list()[0]?.title).toBe("项目 A");
	});

	it("空白标题被拒绝", async () => {
		const registry = await openRegistry();
		const created = await registry.create(await makeDir("alpha"));
		await expectCode(
			registry.rename(created.workspace.id, "   "),
			"invalid-title",
		);
	});

	it("重名被拒绝", async () => {
		const registry = await openRegistry();
		const alpha = await registry.create(await makeDir("alpha"));
		const beta = await registry.create(await makeDir("beta"));
		await registry.rename(beta.workspace.id, "共同标题");
		await expectCode(
			registry.rename(alpha.workspace.id, "共同标题"),
			"name-conflict",
		);
	});

	it("未知 id 报 not-found", async () => {
		const registry = await openRegistry();
		await expectCode(registry.rename("nope", "标题"), "not-found");
	});
});

describe("remove / reorder", () => {
	it("删除后剩余工作区保持原顺序", async () => {
		const registry = await openRegistry();
		const alpha = await registry.create(await makeDir("alpha"));
		const beta = await registry.create(await makeDir("beta"));
		const gamma = await registry.create(await makeDir("gamma"));

		await registry.remove(beta.workspace.id);
		expect(registry.list().map((workspace) => workspace.id)).toEqual([
			gamma.workspace.id,
			alpha.workspace.id,
		]);
	});

	it("删除未知工作区报 not-found", async () => {
		const registry = await openRegistry();
		await expectCode(registry.remove("nope"), "not-found");
	});

	it("合法排列会重排并持久化", async () => {
		const registry = await openRegistry();
		const alpha = await registry.create(await makeDir("alpha"));
		const beta = await registry.create(await makeDir("beta"));
		const gamma = await registry.create(await makeDir("gamma"));

		const ids = [alpha.workspace.id, gamma.workspace.id, beta.workspace.id];
		const reordered = await registry.reorder(ids);
		expect(reordered.map((workspace) => workspace.id)).toEqual(ids);

		const reopened = await openRegistry();
		expect(reopened.list().map((workspace) => workspace.id)).toEqual(ids);
	});

	it("重复 id 的排列被拒绝", async () => {
		const registry = await openRegistry();
		const alpha = await registry.create(await makeDir("alpha"));
		const beta = await registry.create(await makeDir("beta"));
		await expectCode(
			registry.reorder([
				alpha.workspace.id,
				alpha.workspace.id,
				beta.workspace.id,
			]),
			"invalid-order",
		);
	});

	it("缺项（长度不符）的排列被拒绝", async () => {
		const registry = await openRegistry();
		const alpha = await registry.create(await makeDir("alpha"));
		await registry.create(await makeDir("beta"));
		await expectCode(registry.reorder([alpha.workspace.id]), "invalid-order");
	});

	it("未知 id（长度相同）的排列被拒绝", async () => {
		const registry = await openRegistry();
		const alpha = await registry.create(await makeDir("alpha"));
		const beta = await registry.create(await makeDir("beta"));
		await expectCode(
			registry.reorder([alpha.workspace.id, beta.workspace.id, "nope"]),
			"invalid-order",
		);
	});
});

describe("会话归属", () => {
	it("attach 会把会话从其它工作区移出（单归属）", async () => {
		const registry = await openRegistry();
		const alpha = await registry.create(await makeDir("alpha"));
		const beta = await registry.create(await makeDir("beta"));

		await registry.attachSession(alpha.workspace.id, "s1");
		const moved = await registry.attachSession(beta.workspace.id, "s1");

		expect(moved.sessionIds).toEqual(["s1"]);
		const alphaRecord = registry
			.list()
			.find((workspace) => workspace.id === alpha.workspace.id);
		expect(alphaRecord?.sessionIds).toEqual([]);
		expect(registry.workspaceForSession("s1")?.id).toBe(beta.workspace.id);
	});

	it("attach 追加在末尾；重复 attach 保持位置且不刷新 updatedAt", async () => {
		const registry = await openRegistry();
		const alpha = await registry.create(await makeDir("alpha"));
		await registry.attachSession(alpha.workspace.id, "s1");
		const withSecond = await registry.attachSession(alpha.workspace.id, "s2");
		expect(withSecond.sessionIds).toEqual(["s1", "s2"]);

		const again = await registry.attachSession(alpha.workspace.id, "s1");
		expect(again.sessionIds).toEqual(["s1", "s2"]);
		expect(again.updatedAt).toBe(withSecond.updatedAt);
	});

	it("attach 到未知工作区报 not-found", async () => {
		const registry = await openRegistry();
		await expectCode(registry.attachSession("nope", "s1"), "not-found");
	});

	it("detach 从所有工作区移除，未知会话不报错", async () => {
		const registry = await openRegistry();
		const alpha = await registry.create(await makeDir("alpha"));
		const beta = await registry.create(await makeDir("beta"));
		await registry.attachSession(alpha.workspace.id, "s1");
		await registry.attachSession(beta.workspace.id, "s2");

		await registry.detachSession("s1");
		expect(registry.workspaceForSession("s1")).toBeNull();
		expect(registry.workspaceForSession("s2")?.id).toBe(beta.workspace.id);

		await registry.detachSession("not-attached");
		const reopened = await openRegistry();
		expect(reopened.workspaceForSession("s2")?.id).toBe(beta.workspace.id);
	});

	it("findByPath 用 canonical 路径匹配，不存在的路径返回 null", async () => {
		const registry = await openRegistry();
		const alpha = await makeDir("alpha");
		const created = await registry.create(alpha);
		const link = join(root, "alpha-link");
		await symlink(alpha, link);

		expect(registry.findByPath(link)?.id).toBe(created.workspace.id);
		expect(registry.findByPath(join(root, "missing"))).toBeNull();
	});
});
