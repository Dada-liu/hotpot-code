# hotpot-agent 项目改进报告

> 审查日期：2026-10-26
> 审查方式：静态代码审查 + 项目现有质量门禁
> 范围：`ai`、`core`、`orchestrator`、`server`、`web`、`telemetry`、`benchmarks`，以及测试、构建发布和文档。
> 注意：“已确认问题”表示代码路径及其机制可以从当前实现直接确认，不等于已经完成真实网络、浏览器或对抗性复现；“待验证风险”单独列出，避免把推测写成事实。

## 1. 摘要

项目已经具备清晰的分层架构、可追溯的 JSONL 会话日志、较完整的工具异常防御和广泛的单元/集成测试。当前最应优先处理的不是新增功能，而是两个安全默认值：

1. 开发服务器没有显式绑定回环地址，API 没有认证，设置接口还会返回 apiKey 原文。
2. 不可信仓库的项目级配置可以把权限直接提升为 `full`，绕过危险操作审批。

其后应依次收紧工具权限边界、修复会话恢复与并发一致性、补齐上下文/成本及网络故障控制，最后完善 CI 和文档门禁。

### 优先级定义

- **P0**：可能直接暴露凭证、扩大工具执行权限或造成高影响安全后果，应立即处理。
- **P1**：影响数据安全、会话正确性、可用性或成本，应进入近期修复。
- **P2**：重要的可靠性、工程效率和可维护性完善。

## 2. 当前验证结果

| 命令 | 结果 |
|---|---|
| `pnpm check` | 通过；Biome 检查 259 个文件，无需修复 |
| `pnpm typecheck` | 通过；所有 workspace 包完成 TypeScript 检查 |
| `pnpm test` | 结果不稳定：首次及独立复核均为 72 个文件、674 个测试通过；后续两次全量复跑分别出现 5 个和 1 个超时失败 |
| `pnpm build` | 通过；Web Vite 构建及发布包 tsup 构建成功 |

测试补充记录：一次与其他质量命令并行复跑时，5 个测试超时且 1 个 worker 启动超时；随后单独全量复跑时，`packages/server/test/api.test.ts` 的“工作区 CRUD”在 20 秒后超时，其余 673 个测试通过。该用例紧接着单独运行时通过（1 个通过、25 个跳过）。因此不能把当前测试套件表述为稳定全绿；构建和静态检查通过，也不能覆盖下文的安全、并发、浏览器端及测试稳定性盲区。

## 3. 已确认问题与改进建议

### P0-1：开发服务可能对外暴露，且管理 API 无认证

- **证据**：`packages/server/src/serve.ts:25-43` 将可选的 `hostname` 原样传给 Hono；`packages/server/src/bin.ts:5-8` 未指定监听地址，却打印 `localhost`。`packages/server/src/settings-store.ts:43-53` 返回完整模型设置，其中包含 apiKey；`packages/server/src/app.ts:153-163` 挂载会话和设置等 API，未见认证、Host 或 Origin 校验。
- **影响**：Node 在未指定 hostname 时可监听未指定地址。同一网络的访问者可能读取会话与模型凭证、发送消息驱动工具执行、修改设置或删除会话。发布入口允许 `--host 0.0.0.0` 时也有同类风险。
- **【建议】**：`startServer` 默认显式绑定 `127.0.0.1`；非回环监听必须显式启用并配置认证。为本地 API 增加随机启动令牌和 Host/Origin 校验；apiKey 改为只写或掩码返回，并准确打印实际监听地址。
- **验证**：增加默认监听地址、非回环无认证拒绝、跨源请求拒绝及设置响应不泄露 apiKey 的集成测试。

### P0-2：项目级配置可以直接提升为 `full` 权限

- **证据**：`packages/core/src/config/config.ts:118-128` 的项目配置白名单包含 `permission.mode`；`packages/core/src/config/config.ts:234-243` 让项目配置覆盖用户配置；`packages/orchestrator/src/runtime/runtime.ts:88-93` 中 `full` 对应全部自动放行。
- **影响**：用户打开恶意仓库后，仓库内的 `.hotpot/settings.json` 可把 `readonly` 或 `workspace` 提升为 `full`，使危险 bash、覆盖写等操作不再询问。这绕过了用户对项目级配置的安全预期。
- **【建议】**：从项目级白名单移除 `permission.mode`，或只允许项目配置降低权限、禁止提升权限。`full` 仅接受用户级配置或当次明确用户操作，并同步更新配置说明。
- **验证**：增加“项目 full 不得覆盖用户 workspace/readonly”的回归测试，以及允许显式降级的测试（若保留降级能力）。

### P1-1：`readonly` 审批未覆盖 MCP 等派生工具

- **证据**：`packages/orchestrator/src/registries/registries.ts:38-62` 明确让 feature 派生工具裸注册；`packages/orchestrator/src/registries/registries.ts:146-162` 只对 bash/read/write/edit 应用权限装饰器。`packages/core/src/config/config.ts:93-96` 却声明 readonly 下其余 worker 工具逐个审批。
- **影响**：只读模式下，模型仍可能无审批调用具有远端写入、删除或执行能力的 MCP 工具。现有 `packages/orchestrator/test/registries.test.ts:455-467` 还将“外工具不装饰”固定为预期。
- **【建议】**：为工具增加明确的只读/副作用能力元数据，而不是仅按工具来源决定安全策略；readonly 至少审批所有未知副作用工具和 MCP 工具，并调整旧测试预期。
- **验证**：用只读、写入、删除三类 MCP 假工具验证自动放行、审批和拒绝路径。

### P1-2：`workspace` 不是完整文件边界，危险命令审批覆盖有限

- **证据**：`packages/core/src/tools/write.ts:25-42` 和 `packages/core/src/tools/edit.ts:40-73` 通过 `resolve(ctx.cwd, args.path)` 接受绝对路径及 `../`，没有 realpath 包含检查；`packages/core/src/tools/bash.ts:18-30,52-70` 仅对有限正则匹配的危险命令询问。
- **影响**：默认“工作区修改”模式下可修改工作区外文件；`git clean -fdx`、`find ... -delete` 等破坏性行为不一定命中审批规则。正则名单不能被当作完整沙箱。
- **【建议】**：文件工具增加 symlink-aware 的工作区包含检查，越界写必须审批；明确 workspace 不是 bash 沙箱，高风险场景默认审批 bash 或引入真正沙箱，正则只作为补充。UI 与 README 应准确描述保证范围。
- **验证**：覆盖绝对路径、`../`、符号链接逃逸、工作区内合法写入及多种危险命令变体。

### P1-3：遥测默认开启并使用明文 HTTP，安装告知不足

- **证据**：`packages/telemetry/src/defaults.ts:1-7` 配置了默认 HTTP 地址；`packages/telemetry/src/client.ts:58-83` 默认 `enabled ?? true`，token 也可经同一连接发送。根 `README.md:104-127` 的安装配置流程没有显著说明默认开启、采集字段和关闭方式。
- **影响**：网络路径上的观察者可能读取或篡改遥测；带 token 时还会暴露 token。持久 installId 使所谓“匿名”事件仍可被关联，用户难以作出知情选择。
- **【建议】**：默认端点改为 HTTPS，禁止 token 经 HTTP 发送；优先改成显式 opt-in，至少在安装文档显著列出采集字段、默认地址以及 `enabled:false` 和空环境变量两种关闭方式。
- **验证**：测试默认启用策略、HTTP+token 拒绝、关闭后零请求及文档所述关闭方式。

### P1-4：磁盘会话并发 attach 缺少单飞保护

- **证据**：`packages/server/src/app.ts:166-173` 和 `packages/server/src/session-manager.ts:1181-1201` 在 managed 未命中时独立执行完整 `attachById`，只在末尾写入 `managed`；`packages/web/src/App.tsx:161-189` 选中会话时会并行发起 prompts、permission、inbox 和 SSE 请求。
- **影响**：同一磁盘会话可能重复创建 tailer、runtime 和 MCP 连接，重复触发 session_start/遥测；后完成者覆盖先完成者，可能导致状态不可见及资源泄漏。
- **【建议】**：按 session id 缓存 in-flight attach Promise，让所有调用共享同一装配结果；失败时清除缓存并关闭已经创建的资源。
- **验证**：模拟四个并发请求，断言只装配一次；另测装配失败后的清理与重试。

### P1-5：重连与首次订阅不能完整重建会话事实

- **证据**：`packages/server/src/session-manager.ts:1428-1494` 的恢复主要重放 durable 日志，turn、plan、approval 等瞬态状态缺少权威快照；`packages/server/src/wire.ts:75-105` 的首次订阅只读 ring buffer，容量为 2000 条，未在该分支回退完整日志。根 `README.md:155-157` 已记录部分恢复问题。
- **影响**：掉窗重连后 composer 可能错误显示 idle/running，计划或审批入口无法恢复；长会话首次打开还可能静默缺少较早消息。服务端与 Web 会对同一会话形成不同投影。
- **【建议】**：首次订阅从磁盘重建完整投影；订阅对账时返回权威运行态、待审批和计划快照。瞬态交互状态应有可恢复的数据源，而不是只存在于 ring buffer。
- **验证**：覆盖超过 2000 事件的首次加载、运行中刷新、错过 turn(end)、待审批重连和计划待审重连。

### P1-6：前端旧异步响应可能覆盖新会话状态

- **证据**：`packages/web/src/App.tsx:134-141,161-189` 的 prompts、permission 和 inbox 请求没有核对响应返回时的 currentId，也没有取消旧请求；同项目 `packages/web/src/components/ChatView.tsx:280-301` 已有请求序号保护，可作为对照。
- **影响**：快速切换会话或慢网络下，旧会话的权限、队列和命令列表可能覆盖新会话，造成误显示和误操作。
- **【建议】**：请求携带会话 epoch/id，返回时核对；切换时通过 AbortController 取消旧请求。inbox action 也应带目标会话，由 reducer 拒绝过期快照。
- **验证**：用可控延迟 Promise 模拟 A→B 切换后 A 最后返回，断言 B 的权限、队列和模板不被覆盖。

### P1-7：缺少上下文长度管理和 step/成本上限

- **证据**：`packages/core/src/agent/loop.ts:211-241` 每个 step 都从日志 derive 全量历史；`packages/core/src/agent/loop.ts:398-403` 工具结束后进入无 step 上限的下一轮。`packages/ai/src/types.ts:65-72` 的 contextWindow 只是模型元数据。`docs/PRD.md:35-40` 已将上下文管理列为 P0 基础能力。
- **影响**：长会话最终可能触发上游上下文错误；长工具输出和重复调用会持续放大 token 成本，模型陷入循环时只能依赖用户手动中止。
- **【建议】**：增加 token 预算、压缩/摘要策略及最大 step/回合预算；耗尽时落明确错误并保留可恢复状态。新增开销应以 benchmark 的成功率和成本数据验证，符合项目核心原则。
- **验证**：覆盖超窗、连续 max_tokens、长工具输出、反复工具调用和预算耗尽后的恢复。

### P1-8：LLM 请求无超时和实际重试，`retryAfter` 未被消费

- **证据**：`packages/ai/src/api/openai-completions.ts:147-185` 与 `packages/ai/src/api/anthropic-messages.ts:137-175` 只传递用户 AbortSignal，并解析 `retry-after`；`packages/core/src/agent/loop.ts:249-325` 对错误直接结束回合，没有连接/流空闲超时或退避重试。`docs/PRD.md:39` 明确要求指数退避重试。
- **影响**：临时 429/5xx 会直接失败；连接或 SSE 停滞可能无限挂起，内联 worker 还会阻塞 main 回合。
- **【建议】**：在 core 或独立策略包装层实现有界连接/空闲超时和有限指数退避，尊重 `retryAfter`；重试只包围模型请求，避免重复执行工具，并始终响应用户取消。
- **验证**：覆盖挂起连接、停滞 SSE、429、5xx、重试后成功、达到上限及重试期间取消。

### P2-1：`finish=error` 在 Web 上可能呈现为普通回答

- **证据**：`packages/core/src/agent/loop.ts:340-356,376-388` 对无工具和有工具的 `finish=error` 都只产出 done，没有独立 error 事件；`packages/server/src/session-manager.ts:920-924,960-963` 只从 error 事件提取回合错误；`packages/web/src/state/reducer.ts:275-295` 未保存 stopReason/error。
- **影响**：Anthropic refusal、OpenAI content_filter 等被归一为 error 时，Web 可能只显示普通助手文本，没有失败提示。
- **【建议】**：统一把 finish=error 转为明确 error 事件和日志；Web 保存并展示回合级 stopReason/error。
- **验证**：分别覆盖无工具及有工具的 finish=error，从 core 到 server wire 再到 reducer 验证错误可见。

### P2-2：发送与回合运行标记之间存在 API 竞态

- **证据**：`packages/server/src/session-manager.ts:856-861,1243-1271,1390-1393` 显示 send 只把 run 挂到 Promise 链，holder.running 和 currentAbort 到实际执行时才设置；`packages/server/src/app.ts:366-375` 暴露取消入口。
- **影响**：在微任务窗口内取消没有 controller 可中止，DELETE 也可能把会话视为 idle，造成取消无效或删除与后续 append 竞争。
- **【建议】**：接受消息时同步登记 queued/running 状态和 AbortController；删除/归档同时检查 turnTail 是否已有待执行任务，而不仅看 holder.running。
- **验证**：在 send 后立即 cancel/delete 的受控竞态测试中，断言不会开始已取消回合，也不会在删除后继续写日志。

### P2-3：取消后仍会继续 spawn 后续 worker/task 批次

- **证据**：`packages/orchestrator/src/tools/spawn-workers.ts:69-99` 和 `packages/orchestrator/src/tools/spawn-tasks.ts:109-126` 的调度循环没有在下一 worker/下一批 task 前检查 signal。
- **影响**：当前批取消完成后，后续任务仍会 spawn、写 user_msg，再以 aborted 收尾，产生无意义 agent、失败卡片和日志。
- **【建议】**：每轮调度前检查 `ctx.signal.aborted`，未开始的任务不再 spawn，同时保持已有 tool_result 的完整性。
- **验证**：跨多个 worker 和多个 task 批次取消，断言后续批次没有启动及新增日志。

### P2-4：常规 CI 与发布一致性门禁不足

- **证据**：`.github/workflows/publish.yml:3-6,34-68` 只在 `v*` tag 执行完整检查；`.github/workflows/website.yml` 只处理 website。发布流程校验 tag 与 package version，但不校验 `packages/telemetry/src/defaults.ts:6-7` 的 APP_VERSION，packed 冒烟也只验证 version/help。
- **影响**：回归可能到发版时才暴露；版本常量可能静默漂移，Web 静态资源或 REST/SSE 的打包问题无法被当前冒烟发现。
- **【建议】**：增加 PR/main CI，执行 check/typecheck/test/build 和 pack 冒烟；发布时断言两个版本一致，并增加安装后 `hotpot web --no-open`、静态页和基础 API 冒烟。
- **验证**：故意制造版本不一致和 Web 产物缺失，确认 CI 能在发布前失败。

### P2-5：文档维护已出现具体漂移

- **证据**：`docs/PRD.md:27` 写 tsdown，实际 `packages/hotpot-agent/tsup.config.ts:1-16` 使用 tsup；`docs/PRD.md:35-40` 把上下文管理和重试列为 P0，但未标明仍未完成；`packages/server/README.md:3,11-13` 仍按 offset 和六类 wire 事件描述，当前实现已按 seq 且包含 permission；`docs/changelog/README.md:39-44` 之后的重大能力缺少持续记录。
- **影响**：需求、架构和操作说明不再能可靠反映实现，增加维护和排障成本，也会掩盖未完成的安全与可靠性能力。
- **【建议】**：修正上述条目，将文档与 changelog 更新纳入重大 PR checklist；保留根 README 对已知重连问题的准确记录，并关联修复计划。
- **验证**：审查文档中的命令、协议字段、工具名称和版本声明，与代码及当前质量门禁逐项对照。

### P2-6：全量测试存在已观察到的间歇性超时

- **证据**：`pnpm test` 首次及独立复核均为 674/674 通过，但后续一次并行质量门禁复跑出现 5 个测试超时和 1 个 worker 启动超时；下一次单独全量复跑又在 `packages/server/test/api.test.ts:1520` 的“工作区 CRUD”超时，其余 673 个通过。该用例随后单独运行通过。
- **影响**：测试结果不能稳定作为合并和发布门禁；超时也可能掩盖真实并发缺陷。当前证据只能确认测试运行不稳定，尚不能断定是产品逻辑、测试隔离还是机器资源竞争。
- **【建议】**：保留失败日志并在固定资源条件下重复复现，记录 worker 数、耗时和临时目录清理；先定位共享状态、异步等待和资源压力，再决定修复产品、隔离测试或调整并发，不要直接增大超时掩盖问题。
- **验证**：在相同 Node/pnpm 版本和相同 worker 数下连续运行全量套件，确认失败可稳定复现或已消除，并针对根因增加回归测试。

## 4. 待验证风险

以下项目有明确代码路径，但本次没有通过受控动态实验确认实际触发频率，不能与上一节混为已复现缺陷。

### R-1：并发 append 可能反转 inbox 的持久化快照

- **证据**：`packages/core/src/session/store.ts:48-56,68-72` 每次独立 open/write/fsync，没有会话级写序列；`packages/orchestrator/src/inbox/inbox.ts:73-93` 的并发变更可能复制不同快照后逆序完成。
- **风险**：较早快照若最后落盘，重启 foldInbox 可能复活已移除消息或丢失新消息。
- **【建议】**：先做可控延迟 append 的逆序测试；若确认，按会话串行化 append。

### R-2：工作区注册表并发写共用同一临时文件

- **证据**：`packages/core/src/workspace/workspace.ts:371-377` 所有 persist 都写 `workspaces.json.tmp` 后 rename，没有互斥。
- **风险**：并发 REST 操作可能相互截断临时文件、rename 失败或造成内存与磁盘不一致。
- **【建议】**：先复现并发写，再考虑进程内单写队列、唯一临时文件名及跨进程并发策略。

### R-3：并行 task 的写冲突主要依赖提示词约束

- **证据**：`packages/orchestrator/src/tools/spawn-tasks.ts:117-123` 用 Promise.all 执行任务；`packages/core/src/agent/loop.ts:391-397` 为任务提供相同 cwd；现有并行测试主要覆盖只读任务。
- **风险**：多个写任务可能相互覆盖同一文件。
- **【建议】**：用同文件写任务复现后，再评估文件所有权声明、冲突检测、worktree 或串行策略，避免未经验证就增加编排开销。

### R-4：内网读取与 DNS rebinding 需要威胁模型验证

- **证据**：`packages/core/src/tools/web-fetch.ts:65-103` 允许任意 HTTP(S)，未过滤 loopback、私网、link-local，也未在重定向后重新校验；结合管理 API 无认证，风险面扩大。
- **风险**：恶意网页提示词可能诱导 agent 读取本地或内网服务再外发；浏览器 DNS rebinding 的实际可达性取决于浏览器和 PNA 行为。
- **【建议】**：用真实浏览器和受控内网服务验证，随后限制内网地址及重定向，并隔离本地管理 API。

## 5. 主要测试盲区

1. **并发与竞态**：并发 attach、send/cancel/delete、并发 append、workspace 并发写。
2. **权限与安全**：项目配置提权、MCP 副作用、越界写、符号链接、危险命令变体、Host/Origin、SSRF。
3. **浏览器行为**：当前 Web 测试以纯 reducer 和工具函数为主，缺少 React 组件及真实浏览器 E2E；应覆盖慢响应、快速切换、首屏长历史、刷新和断线重连。
4. **模型故障**：停滞连接、真实 429/5xx 重试、上下文耗尽、无限 step 和反复工具调用。
5. **并行编排**：同文件写冲突和跨批次取消。
6. **发布产物**：packed 冒烟未验证安装后的 Web 静态资源、REST/SSE 和真实启动。

## 6. 推荐实施顺序

1. **第一阶段：默认安全**：绑定回环地址、本地 API 认证与凭证掩码、禁止项目配置提权、遥测 HTTPS 与告知。
2. **第二阶段：工具边界**：统一工具副作用元数据，收紧 readonly/workspace，补充安全回归测试。
3. **第三阶段：会话正确性**：完整恢复投影、attach 单飞、前端过期响应防护、send/cancel/delete 与持久化并发控制。
4. **第四阶段：可靠性与成本**：上下文预算、step 上限、模型请求超时与重试、取消调度修复；用 benchmark 衡量收益和新增 token 开销。
5. **第五阶段：工程门禁**：PR/main CI、版本一致性、packed Web 冒烟、文档与 changelog 同步。

每个阶段都应独立交付并配套回归测试，不建议把上述问题合并成一次大范围重构。
