# src/workspace/

持久化工作区注册表：记录用户添加过的目录、显示标题与会话归属。工作区是独立实体，不从会话的 cwd 派生；删除工作区只注销记录，目录与会话日志都保留。

## 数据模型

```ts
interface WorkspaceRecord {
	id: string;          // UUID
	path: string;        // canonical realpath，去重与归属判定都以它为准
	title: string;       // 默认取目录末段，可重命名
	createdAt: string;   // ISO 时间
	updatedAt: string;   // ISO 时间
	sessionIds: string[];// 会话展示顺序；一个会话最多属于一个工作区
}
```

数组顺序即侧栏展示顺序：新建的工作区插到头部（最近添加的在最前）。

## 存储

- 位置：`<home>/workspaces.json`，`home` 复用 `session/store.ts` 的 `resolveHome`（参数 > `HOTPOT_HOME` > `~/.hotpot`）。
- 结构：`{ "version": 1, "workspaces": WorkspaceRecord[] }`。
- 文件缺失视为空注册表；JSON 损坏、结构不合法、版本不是 1、id 重复都抛 `invalid-storage`，**不会静默清空用户数据**。
- 写盘原子：先写 `workspaces.json.tmp`，再 `rename` 覆盖目标文件。读者要么看到旧文件，要么看到新文件，不会读到半截 JSON。

## 方法

| 方法 | 行为 |
| --- | --- |
| `list()` | 返回记录的浅拷贝（含 `sessionIds` 副本），顺序稳定。 |
| `create(path)` | 校验绝对路径、存在且是目录，解析 `realpath`；同 canonical 路径已注册时返回 `{ workspace, created: false }`，否则新建记录插到数组头部。 |
| `rename(id, title)` | 标题 trim 后不能为空，不能与其它工作区重名；更新 `updatedAt`。 |
| `remove(id)` | 只删除注册记录，不动磁盘目录与日志；会话由调用侧 detach 或前端落入未分组。 |
| `reorder(ids)` | `ids` 必须是现有 id 的完整排列（长度相同、无重复、无未知 id）。 |
| `attachSession(workspaceId, sessionId)` | 先把会话从其它工作区移出，再追加到目标末尾；已在目标中则保持原位，且不刷新 `updatedAt`。 |
| `detachSession(sessionId)` | 从所有工作区移除；没有变化时不写盘。 |
| `findByPath(path)` | 同步解析 `realpath` 后匹配；路径不存在或不可访问返回 `null`，不抛错。 |
| `workspaceForSession(sessionId)` | 返回会话所属工作区，未归属返回 `null`。 |

## 路径校验

- `path.resolve` 会把相对路径补成绝对路径，因此绝对性按**原始输入**判断；相对路径直接 `invalid-path`。
- 随后 `realpath` + `stat().isDirectory()`，失败均报 `invalid-path`，错误信息包含用户传入的路径。
- 去重比较的是 canonical 路径：同一目录经 symlink 或不同写法传入，仍命中同一条记录。

## 错误码

| code | 场景 |
| --- | --- |
| `invalid-path` | 相对路径、不存在、不是目录、无法 stat |
| `invalid-title` | 标题 trim 后为空 |
| `name-conflict` | 标题与其它工作区重复 |
| `not-found` | 未知工作区 id |
| `invalid-order` | 不是现有 id 的完整排列 |
| `invalid-storage` | 存储文件不可读、JSON/结构损坏、版本不支持、id 重复 |

## 边界

- 注册表与磁盘会话不做强一致裁剪：未知或已删除的 sessionId 允许留在记录里，由客户端按实际会话过滤。
- 不持有会话日志或运行状态；本模块只负责注册表本身。
