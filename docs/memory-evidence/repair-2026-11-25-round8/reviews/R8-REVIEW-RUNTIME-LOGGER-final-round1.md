# R8-REVIEW-RUNTIME-LOGGER 独立架构审查报告

## 审查范围

审查根目录：`C:\Users\YDJ\Desktop\SparkiiDesktop-Pi`

- 运行时与 IPC：
  - `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\ipc.ts`
  - `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\workflow.ts`
  - `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\security\task-lifecycle.ts`
  - `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\packages\agent-host\src\pi-runtime-pool.ts`
- Logger：
  - `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\logger.ts`
- 相关回归：
  - `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\test\ipc.test.ts`
  - `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\test\workflow-broker.test.ts`
  - `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\test\task-lifecycle.test.ts`
  - `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\test\logger.test.ts`
  - `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\packages\agent-host\test\pi-runtime-pool.test.ts`
- 必要时追踪了 runtime transport、supervisor、approval gate、task-grant registry、runtime action router 与 memory service。

冻结清单 `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\docs\memory-evidence\repair-2026-11-25-round8\source-sha256.txt` 自身 SHA-256 与指定值一致；全部 63 项均已通过 `sha256sum -c`。未修改仓库文件，未运行测试或其他写文件命令。

## 关键调用链证据（文件:行号）

### 1. Workflow admission 与 binding guard

- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\ipc.ts:3033-3054`
  - `onReady` 校验 pool client、pool lease、原 `openSessions` entry/lease、`inFlightWorkflowRuns` lease。
  - 完整 guard 传入 `startSessionTask`。
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\ipc.ts:602-624`
  - grant factory 内再次执行 guard。
  - guard 同时作为 `TaskLifecycle.start` 的 `beforeCommit`，覆盖异步 factory 完成后的提交点。
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\workflow.ts:488-536`
  - 捕获原 binding lease；`new_session`、`get_state`、rename、proposal 注册、`onReady` 前后均校验。
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\workflow.ts:185-239`
  - model/thinking 的 settings/key await 与命令发送前后均有 guard。
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\workflow.ts:257-332`
  - prompt 固定原 client/lease；事件消费、prompt 发送、完成与最终返回均校验。
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\workflow.ts:335-419`
  - tool 的异步读取、搜索、配置与审批返回路径均重新校验。
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\workflow.ts:572-658`
  - journal 写入前后校验 ownership；失败日志只记录 output 字节数。
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\workflow.ts:660-728`
  - runner 每个事件、prompt/tool/approval 与最终 release 都使用捕获的 lease。

需要精确区分：`onReady` 的完整 guard 没有原样传入 `runWorkflowLoop`；后者在 `workflow.ts:672-693` 使用 pool client/lease guard。当前生产路径中这仍是有效等价保护，因为每次 bind 都产生新 lease，且 `openSessions`/`inFlightWorkflowRuns` 的 workflow 生命周期变更与 pool binding 同步。未来若允许两张 Map 脱离 pool lease 独立变化，下游不会发现。

### 2. 旧 workflow 与替代 binding 隔离

- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\packages\agent-host\src\pi-runtime-pool.ts:369-421`
  - 每次 bind 均递增 lease，包括同 client、同 session ID 复用。
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\packages\agent-host\src\pi-runtime-pool.ts:226-232`
  - 事件必须同时匹配当前 binding lease 与 session generation。
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\packages\agent-host\src\pi-runtime-pool.ts:504-534`
  - stale expected lease 的 release 直接返回；有效 release 先摘除 binding，再重置进程。
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\ipc.ts:3057-3071`
  - `beforeRelease` 先检查原 pool/open entry，再结束 task、删除原 workflow lease。
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\workflow.ts:725-727`
  - 最终 release 始终携带原 `bindingLease`。

因此未发现旧 workflow 向替代 binding 发送命令，或旧 release/unbind 清除替代 binding 的路径。

### 3. TaskLifecycle 撤销竞态

- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\security\task-lifecycle.ts:29-38`
  - `beforeCommit → registry.start → onStarted` 之间没有 await。
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\ipc.ts:624-653`
  - 五组 cancellation hooks 在 `onStarted` 内同步注册。
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\security\task-lifecycle.ts:89-107`
  - 撤销时先取出并删除 hooks，再执行并等待全部取消操作。

在现有 IPC 调用链中，revocation 不能 overtake 新 grant 的 hook 注册。

### 4. Logger 物理行、脱敏与删除

- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\logger.ts:9-11`
  - 先按 `\r\n|\r|\n` 拆分物理行。
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\logger.ts:83-140`
  - 合法 JSON 走结构化脱敏；损坏行解码完整 JSON string token，无法可靠处理时降级为安全占位记录。
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\logger.ts:152-159`
  - rewrite 统一为 LF，并对非空输出保留恰好一个终止 LF。
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\logger.ts:160-188`
  - memory prompt 与目标 session 删除都只删除可成功解析且字段精确匹配的记录；损坏行保留并脱敏。
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\logger.ts:216-222`
  - export 同样先拆物理行，再逐行脱敏并统一 join 为 LF。

## 发现（按严重度）

### 阻塞 / High：Logger 异步 append 可重新插入已删除记录

**文件：**

- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\logger.ts:198-215`
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\logger.ts:160-188`
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\memory\service.ts:920-924`

**可触发场景：**

1. 调用 `logger.log({ ctx: { sessionId: 'removed' } })`，但不等待其 Promise。
2. `log()` 在 `logger.ts:209` 等待异步 `mkdir()`。
3. 此间执行隐私清理 `redactSession('removed', texts)`；同步 rewrite 删除目标记录并返回成功。
4. 原 `log()` 恢复，在 `logger.ts:211` 把目标 session 记录 append 到 rewrite 后的文件。

该交错无需特殊 mock 即可稳定构造。类似交错也存在于 `redactMemoryPromptLogs()`。若 redaction 发生在 line 已计算、`appendFile()` 尚未完成之间，甚至可能重新写入尚未应用新 redaction 列表的内容。

**影响：**

- 违反目标 session 日志删除语义。
- 隐私清理可能已经向调用方报告成功，但随后删除的记录重新出现。
- rewrite 时的 secret verification 不能覆盖之后发生的 append。

**最小修复要求：**

将 append 与 rewrite 放入同一写序列，并保证 redaction 完成前不会恢复旧 append；例如把 redaction API 改为异步并 await 共享写队列，或在最后一次 redaction 检查后使用无 await 的同步 append 临界区。同时增加如下回归：发起但不等待 `log()`，立即调用 `redactSession`/`redactMemoryPromptLogs`，等待 log 完成后读取原始文件，断言目标记录和秘密均不存在。

### 非阻塞观察：完整 workflow guard 未逐层传递

`ipc.ts:3041-3047` 的完整 guard 只用于 admission；`workflow.ts:672-693` 下游使用较窄的 pool guard。当前依赖单调 lease 不变量仍安全，不构成已确认阻塞。但若验收要求“三个状态源在每次 await 后都直接校验”，应让 `onReady` 返回 guard，并贯穿 loop、journal 与 broker，而不是依赖间接不变量。

## 回归覆盖评估

- **Workflow：较强。**
  - `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\test\workflow-broker.test.ts:669-824` 断言真实命令数组、prompt 数量、journal 内容、release lease 与替代 binding lease。
  - 同文件 `:876-924` 覆盖同 client/同 ID 的 lease 轮换，断言旧输出不写 journal、`beforeRelease` 不执行、旧 release 不改变新 binding。
  - 缺口：没有在 pool lease 不变时单独替换 `openSessions`/`inFlightWorkflowRuns` 的集成回归。
- **TaskLifecycle：较强。**
  - `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\test\task-lifecycle.test.ts:78-115` 覆盖 commit 前 ownership 与同一同步 turn 注册 hooks。
- **Runtime pool：较强。**
  - `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\packages\agent-host\test\pi-runtime-pool.test.ts:282-350` 使用真实 pool 和 fake transport，断言 stale release、lease 轮换、generation 过滤与 binding 状态。
  - 同文件 `:744-809` 覆盖 detach-before-reset、同 client 复用和 rename。
- **Logger：格式与脱敏覆盖强，并发覆盖缺失。**
  - `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\test\logger.test.ts:265-328` 覆盖全部 JSON escape、schema、损坏行降级与记录数量。
  - 同文件 `:331-366` 覆盖秘密换行形式与 `\n`/`\r\n`/`\r` 分隔符的九种组合。
  - 同文件 `:141-157` 只验证“先 rewrite、后 await append”，没有验证“append 未完成时并发 rewrite”。

## 未验证限制

- 遵守只读约束，未执行测试、类型检查或 Electron 实机运行。
- Logger 竞态由明确 async/sync 调用顺序静态确认，但未通过动态压力测试复现。
- 未穷举真实 provider、子进程崩溃与所有 Electron IPC 调度时序。
- 未使用 R8-MAPPING 或先前审查结论作为证据。

## 结论

**CHANGES_REQUIRED**

**Blocking finding count: 1**

阻塞项是 Logger append/rewrite 竞态，它可以使已成功执行的隐私日志删除重新失效。Workflow lease 隔离、TaskLifecycle 同 turn 注册、Logger 物理行与 JSON escape 处理主体实现正确，但上述隐私删除竞态必须修复后再批准。
