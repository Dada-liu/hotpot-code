# 草稿会话与发送前附件上传

- 日期：2026-10-25
- 状态：已合入 main（`9a8fb9f`、`be0a861`）

## 背景与动机

新建会话采用首条消息延迟持久化后，草稿阶段还没有 session id，权限选择和附件上传不能依赖已有会话。输入控件若在草稿阶段禁用，会让用户无法完成发送前准备。

## 变更内容

- 创建会话 API 接受 `permissionMode` 和可空 `workspaceId`；显式 `null` 跳过 cwd 自动归属，字符串值归属指定工作区。
- 新增无会话 `POST /api/uploads`，附件写入 drafts 上传目录，首条消息再引用其绝对路径。
- Web 同时最多保留一个临时草稿，支持未分组或工作区内新建、权限预选和附件上传；首条消息创建真实会话后清除草稿。

## 影响面

涉及 `server` 创建会话与上传路由、`web` 草稿状态和输入框。草稿本身不写入会话列表或 JSONL，只有首条消息触发持久化。

## 验证

- `server/test/api.test.ts` 覆盖创建参数、显式不分组和无会话上传。
- Web 现有交互实现见 `packages/web/src/App.tsx`、`components/SessionList.tsx` 与 `components/ChatView.tsx`。

## 相关链接

- 提交：`9a8fb9f`（服务端）、`be0a861`（Web）。
- 当前约定：[packages/web/AGENTS.md](../../packages/web/AGENTS.md) 的 Draft sessions 条目。
