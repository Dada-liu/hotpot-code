# changelog/

重大功能与架构变更记录。每个重大变更在这里新建一个文件：讲清动机、改了什么、影响面、怎么验证的，供日后追溯与新人（新 agent）快速建立全貌。

## 什么时候写

- 写入条件：**重大功能或架构变更**——新增/删除用户可见能力、agent 行为路由变化、目录或依赖结构移动、跨包重构。日常 bugfix、小特性、纯测试调整不用写。
- 写入时机：随重大变更 PR 写好；尚未合入的条目标记“进行中”，合入 `main` 后更新状态并补齐提交信息。
- 一个变更一个文件；一个 PR/批次里包含多个独立变更时拆开写。

## 文件命名

`YYYY-MM-DD-<slug>.md`：已合入记录的日期取合入日，进行中记录取创建日并在合入后核对；slug 用英文短横线小写（与 `docs/superpowers/specs/` 的命名习惯一致）。同日多个变更加序号后缀。

## 模板

```markdown
# <变更标题>

- 日期：YYYY-MM-DD
- 状态：已合入 main（<commit>）| 进行中 | 已回退

## 背景与动机
<为什么改：当时的痛点、触发场景、量化证据>

## 变更内容
<改了什么：核心机制、关键文件、行为前后对比>

## 影响面
<哪些包/目录/文档/外部流程受影响；兼容性注意>

## 验证
<测试、benchmark 对比、实测数据>

## 相关链接
<提交区间、设计/计划文档、跑批报告>
```

## 现有记录

| 文件 | 变更 |
|------|------|
| [2026-10-21-first-turn-routing-no-delegate.md](./2026-10-21-first-turn-routing-no-delegate.md) | 删除 delegate 工具，首轮流提示词路由（trivial 直答 / complex 首轮出计划） |
| [2026-10-22-benchmarks-move-to-root.md](./2026-10-22-benchmarks-move-to-root.md) | benchmarks 从 packages/ 移至根级目录，与 packages/ 并列 |
| [2026-10-23-agent-end-and-task-list.md](./2026-10-23-agent-end-and-task-list.md) | agent_end 驱动 agent 卡片状态，新增任务清单与详情弹窗 |
| [2026-10-23-permissions-queue-and-composer.md](./2026-10-23-permissions-queue-and-composer.md) | 权限三档、排队优先、附件与 @ 文件提及 |
| [2026-10-24-workspaces.md](./2026-10-24-workspaces.md) | 持久化工作区、会话归属、侧栏分组与原生目录选择器 |
| [2026-10-25-draft-sessions.md](./2026-10-25-draft-sessions.md) | 草稿会话、权限预选与发送前附件上传 |
| [2026-10-26-local-api-auth-and-project-permissions.md](./2026-10-26-local-api-auth-and-project-permissions.md) | 本地 API 认证、apiKey 掩码与禁止项目权限覆盖（进行中） |
| [2026-10-26-permission-ask-on-dangerous-2.md](./2026-10-26-permission-ask-on-dangerous-2.md) | 权限档位 workspace 改名为 ask-on-dangerous（进行中） |
