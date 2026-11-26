# R8-REVIEW-RUNTIME-LOGGER 独立只读终审报告（round6-final）

- 审查日期：2026-11-26
- 仓库：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi`
- 基线 HEAD：`101487d3f612764766cc024d4b28dbf846a926cf`
- 审查对象：当前工作树中的 R6/R7/R8 未提交修复。
- 审查方式：完整阅读指定生产文件、测试、旧复审与修复报告、round6 after 证据，并追踪 Pi SDK、runtime transport、pool、IPC、workflow、TaskLifecycle、Logger 之间的新旁路。
- 写入约束：未修改生产代码、测试、配置或旧证据；仅写入本报告。未执行 Git 写操作，未重复运行主线程正在执行的全套测试、类型检查或构建。

## 结论

CHANGES_REQUIRED

Blocking finding count: 2

Round5 B1 的直接 post-send catch 旁路已经修复，但终审发现两个独立的阻断问题：

1. **HIGH**：opening 的 `switch_session` 尚未结束时，privacy stop/release 可以并发发送并先完成 `new_session`；迟到的 switch 随后把已删除会话恢复进可复用 child，破坏“先停 runtime，再破坏性清理”的边界。
2. **MEDIUM**：Pi prompt 在真正进入 run 之前失败时只发 `runtime_error(command=prompt)`，不发 `agent_settled`；主进程不消费该终态，导致 prompt 队列和 TaskGrant 持续占用，后续正常 prompt 无限等待。

## B1：release 可被尚未完成的 opening switch 反超，隐私删除后会话可能恢复

### 严重度

HIGH（阻断；隐私删除完整性与跨会话隔离）

### 位置

- 主要位置：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/packages/agent-host/src/pi-runtime-pool.ts:506-535`
- opening bind：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/packages/agent-host/src/pi-runtime-pool.ts:371-423`
- child 命令并发入口：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/packages/agent-host/src/pi-runtime.ts:93-115`
- privacy stop 调用 release 的位置：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/ipc.ts:2756-2813`
- opening 获取与取消：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/ipc.ts:1216-1265`

### 触发路径

1. 打开一个需要 `resumeSessionFile` 的会话。`PiRuntimePool.bind()` 在首个 await 前已经写入 `slot.sessionId`、`slot.lease` 和 `bySession`，随后发送 `configure_session`/`switch_session`，因此外部能看到一个“已绑定但 opening 未完成”的会话。
2. 此时触发 privacy deletion。`stopSessionRuntimeOwned()` 能捕获该 binding，结束 Task、停止 document parser，并继续调用 `unbindAndRelease()`。`cancelAcquire()` 只设置 `control.cancelled`，不会等待正在执行的 bind，也不会阻止已经开始的 switch。
3. `PiRuntimePool.release()` 不检查 `slot.resetting`，也不等待 opening bind；它立即删除 alias、把 `slot.sessionId` 设为 `null`，然后并发发送 `new_session`。
4. `createPiRuntime()` 的每个 IPC message 都直接启动一个独立 async handler，没有 per-child lifecycle command 队列。`switch_session` 与 `new_session` 因此可以重叠，且 SDK 的 `AgentSessionRuntime.switchSession()/newSession()` 内部也没有使二者互斥的锁。
5. 若 `new_session` 先完成，release 会把 `resetting=false` 并允许该 slot 被后续 acquire 复用；随后迟到的 `switch_session` 才完成，child 的最终会话重新指向待删除文件。switch 的递增 generation 并不构成保护，它只证明“最后一次 session-changing 命令完成”，不证明“最后一次完成的是 new_session”。
6. 原 bind 恢复后虽然会因 `ownsBinding()` 失败而 reject，但 catch 在 alias 已丢失时直接抛错，不退休该 slot。privacy stop 看到 binding 已消失即返回，随后删除 memory/session 记录与 Pi JSONL；child 却可能仍持有该会话，下一次无 resume 的 acquire 会复用它，造成已删除内容继续显示、被追加或泄露到后续会话。

### 影响

- 违反 privacy deletion 必须在停任务、extraction、document parser 和 Pi runtime 停止/清理完成后才执行破坏性删除的硬要求。
- 已删除的 Pi 会话可能重新进入可复用进程，形成隐私数据恢复、后续 prompt 写入已删除文件及跨会话泄露路径。
- 同 ID lease、opening epoch 与 event generation 不能关闭此缺口：问题发生在 child 生命周期命令的完成顺序，而不是主进程 alias 或事件归属。

### 建议

- 对同一 child 的 `configure_session`、`switch_session`、`new_session` 建立明确的生命周期命令串行化（pool 操作队列或 runtime transport 队列），确保 release 的 reset 不可能被更早发出的 switch 反超。
- cancellation 或 ownership 丢失后的 bind 应按状态不确定处理并退休 child，不能把“alias 已消失”当作可安全复用。
- privacy stop 必须等待 cancelled acquisition/bind 结束，并确认 reset 或 child exit 后才能进入破坏性 commit。
- 增加延迟 `switch_session`、反向完成 `new_session` 的回归：断言 privacy commit 不提前发生、child 不被复用、最终会话不是被删除文件。现有 fixture child 可用于验证协议编排，但不能替代真实 Pi 集成验证。

## B2：prompt 的确定性失败只发 runtime_error，队列与 TaskGrant 可能永久占用

### 严重度

MEDIUM（阻断；会话级可用性及旧 Task 所有权残留）

### 位置

- 主进程事件处理：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/ipc.ts:1272-1324`
- prompt barrier/catch：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/ipc.ts:2113-2214`
- SDK runtime 的非阻塞 prompt 适配：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/packages/agent-host/src/pi-sdk-runtime.ts:140-154`
- 已安装 Pi SDK 证据：`node_modules/.pnpm/@earendil-works+pi-coding-agent@1.5.0_@aws-sdk+credential-provider-node@3.972.84_@smithy+sign_nqz6y242fd6t6ckmkqqcf454oa/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1441-1454,1649-1711`

### 触发路径

1. `startPromptWithoutBlocking()` 调用 `session.prompt()` 后不等待其最终结果，立即返回成功，因此 IPC 的 `promptMayBeRunning` 会保持为 `true`。
2. 真实 Pi SDK 在进入 `_startRun()` 的 try/finally 之前可能拒绝 prompt，例如 compaction 正在进行、input handler 失败、没有 model/API key；进入 `_startRun()` 后，`_prepareRun()` 的 catch 也直接抛错而不发 settled。
3. SDK runtime 的 catch 只通过 `onRuntimeError` 发出 `{ type: 'runtime_error', command: 'prompt' }`。这条路径没有 `agent_start`，也没有 `agent_settled`。
4. 主进程只在 owned/cancelled `agent_settled`、abort 确认 idle 或 binding retired 时完成 `PromptTurn`；`runtime_error` 不完成 barrier，也不会结束 TaskGrant。
5. 后续 `behavior === 'prompt'` 请求一直等待 `previousQueued`，旧 admission/grant 也继续保留，直到用户显式 abort、stop 或 release。单纯重试无法恢复。

### 影响

- 单个可恢复的 prompt 错误可能永久阻塞该会话后续所有正常 prompt，并保留旧 Task 权限/所有权。
- 这是 round6 修复后暴露的终态覆盖缺口，不是重新指控已解决的 post-send `get_state` 路径：post-send 错误仍必须保持 barrier，不能放宽该安全保证。

### 建议

- 为 prompt 命令引入 request/turn correlation，并把该 prompt promise 的确定性拒绝转换为与当前 turn 对应的 terminal 事件；主进程只完成匹配的原 client/lease/admission/turn，不能凭 session id 结束 replacement。
- 如果无法立即增加 correlation，至少必须覆盖“尚未开始且能证明属于当前 prompt”的失败，并为 started 后失败提供明确终态；generic 或无法归属的 `runtime_error` 不得释放 barrier。
- 增加无 model/auth、input/prepare 失败及 abort 后迟到 error 的回归，验证旧 grant 被正确结束、B 可继续，同时 generic error 不误结束 B。

## 指定重点复核结果

| 重点 | 结论 | 证据与边界 |
|---|---|---|
| privacy delete 的先停后删 | **不通过** | task/extraction/parser 的常规顺序已实现，但 B1 的 opening switch 与 release 并发可绕过实际 runtime 清理。 |
| opening epoch / stopping set / cancelAcquire | 部分通过 | epoch 在 listing/acququisition 后复检；stopping tombstone 阻止新 opening；queued/cold acquisition 可取消。正在执行的 bind 不等待取消，见 B1。 |
| 不可变 lease / 同 ID replacement | 通过 | 每次 bind 递增 lease；stale release 被 expected lease 拒绝；event 同时检查 client、lease、resetting 与 sessionGeneration。 |
| post-send `get_state` 失败或 ownership 变化不提前释放 barrier | 通过 | `promptMayBeRunning` 在 send 尝试后保持不确定态；catch 不再仅因 post-send 错误释放。Round5 B1 直接旁路已关闭。 |
| `agent_start` / settled 归属 | 通过，保留协议限制 | `readyForSettled`、`started`、client/lease/admission helper 已落地。真实 SDK 同步发事件，child IPC 按通道保序；同一 run 的 start 在 settled 前，B 在 A settled 后才发送。任意重复/乱序 terminal 不是当前协议保证，见“限制”。 |
| stop/release transport 失败 | 常规路径通过 | `get_state` 失败被容忍后继续 unbind；session-changing send 失败退休 slot；stopAll 等待确认 exit，失败拒绝。进行中 bind 的并发缺口见 B1。 |
| workflow 所有 await 边界保留原 guard | 通过 | model/key/thinking、prompt、tool、approval、journal、loop、onReady、beforeRelease 均捕获并复核原 binding/admission；same-client/same-ID 换 lease 也有回归。 |
| stale approval 结果 | 通过 | canonical proposal、payload hash、TaskGrant、capability lease、privacy 状态与 owner 在 connector 执行前复核；dialog/audit/gateway/caller-mode await 回归覆盖 stale 结果。 |
| Logger 物理行与逐行脱敏 | 通过 | `physicalLines()` 覆盖 LF、CRLF、CR；合法 JSON 与 malformed line 分别处理；append 前无 await，rewrite 同步原子替换。 |
| export / rewrite 与 append 同规则 | 通过 | 共享 `redactLine()`/`containsRegisteredValue()`/`outputPreservesSecret()`；export 重新拆分、脱敏并验证完整输出。 |
| FakeHandle 与真实 child fixture 边界 | 表述正确 | IPC/pool/supervisor 的内存 handle 只证明主进程状态机；两个 pool fixture 文件启动 fork 的 `.mjs` child，但不是真实 Pi SDK child。 |

## Round5 B1 与 start/settled 复核

- `ipc.ts:2188-2214` 的 `promptMayBeRunning` 修复了 post-send `get_state` reject/ownership 变化时错误释放队列的直接路径。
- `ipc.ts:969-1016` 将 client/lease 固化到 `PromptTurn`，completion helper 不会清除同 ID replacement。
- `ipc.ts:1278-1322` 仅在 armed turn 上记录 start，owned settled 还必须 started；cancelled/aborted terminal 仍可释放。
- `ipc.test.ts:6496-6561` 覆盖 A 已投递、post-send reject、B 等待、A terminal 后 B arm，以及 B arm 前旧 start 不污染 B。
- 对“B arm 后、B 自己 start 前收到 A 旧 start”的额外静态追踪没有发现真实协议旁路：已安装 Pi SDK 的 `_emit()` 同步通知 listener，`createPiRuntime()` 同步 `postMessage`，Node child IPC 保持单通道消息顺序；SDK 在 `_startRun()` 的 finally 发 settled，主进程处理 A settled 后才放行 B prompt。现有测试没有直接注入“B arm 后旧 start”，因此不把该未测序列表述为动态验证通过。
- 同理，`ev.aborted === true` 可释放未 started turn 是对重复/乱序 aborted terminal 的防御边界；当前协议一次 run 一个 terminal 且保序时未发现可利用路径。若未来 SDK 重复发 terminal，必须增加 turn id，不能靠 session id 归属。

## Logger 复核

- `logger.ts:14-15` 使用 `split(/\r\n|\r|\n/)`，不会把 CR-only 历史记录拼接成一行。
- `logger.ts:31-38,116-135` 对值递归检测登记秘密，对非 schema 动态键也检测秘密；schema 键按现有契约保留。
- `logger.ts:137-143` 在写临时文件前验证完整输出，再同步 rename；`log()` 在首个 await 前完成同步 append，旧未 await append/rewrite 竞态已消除。
- `logger.ts:145-172,201-206` 的 memory-prompt 删除、session 删除与 export 都按物理行处理并重新脱敏、验证；跨记录 multiline secret 由 `containsAcrossRecords()` 兜底。
- `logger.test.ts` 覆盖三种秘密换行形态与三种记录分隔符组合、record count、JSON escape、动态键、restart、未来 append 和 export 一致性。

**保留的 Logger 契约限制**：`SCHEMA_KEYS` 是名称白名单而非仅根对象的位置白名单；登记秘密恰好等于 `sessionId`、`msg`、`ctx` 等名称时，该名称作为键会保留。现有测试明确要求嵌套 schema 键不变，因此不能声称所有登记字符串的所有字节形态都绝不出现。此限制不是本轮新增阻断。

## 验证证据

本次仅阅读主线程/交付方已有证据，未重复执行：

- `docs/memory-evidence/repair-2026-11-25-round8/after/round6-prompt-turn.txt`：1 passed，165 skipped；聚焦 round6 回归通过。
- `docs/memory-evidence/repair-2026-11-25-round8/after/round6-runtime-suite.txt`：7 files passed，291 passed / 0 failed / 0 skipped。
- `docs/memory-evidence/repair-2026-11-25-round8/after/round6-pool-fixtures.txt`：2 files passed，3 passed / 0 failed / 0 skipped。
- `docs/memory-evidence/repair-2026-11-25-round8/after/round6-typecheck.txt`：9/10 workspace scope，`packages/ui` 与 desktop renderer/Electron typecheck 完成。
- 指定生产文件与测试均已完整阅读；另外读取 `pi-runtime.ts`、`pi-runtime-transport.ts`、`pi-sdk-runtime.ts`、`privacy-redactions.ts`、相关 runtime 测试及已安装 Pi SDK 的 `agent-session.js` / `agent-session-runtime.js`，用于确认事件与生命周期命令的真实调用顺序。

## 范围与限制

- 这是静态独立架构复审；未启动 Electron、真实 provider、真实 Pi child 或压力测试，未动态复现 B1/B2。
- IPC `FakeHandle`、pool `FakeHandle`、supervisor `ManualHandle` 不证明真实子进程时序、JSONL flush、Windows 句柄或 provider 中断行为。
- `pi-runtime-pool-saddle.test.ts` 与 `pi-runtime-pool-skill-isolation.test.ts` 使用 fork 的 fixture child，只证明 pool 与 fixture 协议；不能称为真实 Pi 子进程证据。
- B1/B2 的 SDK 依据来自当前已安装依赖源码与生产 adapter 的明确 await/catch 顺序；仍需添加确定性回归并在真实 Pi 集成中验证修复。
- `pi-runtime-pool.ts` 在 configure/switch await 后未显式复检 `control.cancelled` 的 API 边界已包含在 B1 的取消/退休建议中，不另算重复 finding。
- `pi-runtime-supervisor.ts` 异步 proposal/action/connector handler 在 await 后未复核 source-handle 同一性；当前 pool 不对同一 supervisor 做 start→stop→start，Main owner/binding guard 提供主要隔离，保留为非阻断 API 边界。
- Windows 文件系统 TOCTOU、symlink/崩溃一致性、真实 provider 的终止语义未在本次验证，也不声称已修复。

## 最终判断

Round5 B1 已关闭，Logger 与 workflow/approval 主体修复成立；但 B1 的 privacy opening/release 竞态和 B2 的 prompt error 终态缺口仍可破坏安全删除边界或永久占用会话。因此当前不能 APPROVE。
