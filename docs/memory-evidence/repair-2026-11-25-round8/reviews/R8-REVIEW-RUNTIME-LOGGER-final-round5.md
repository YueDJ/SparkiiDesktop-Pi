# R8-REVIEW-RUNTIME-LOGGER 独立只读架构复审报告（final-round5）

- 审查日期：2026-11-26
- 仓库：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi`
- 当前分支/提交：`main` / `101487d3f612764766cc024d4b28dbf846a926cf`
- 审查方式：独立读取当前工作树的生产调用链、依赖实现和回归断言；未依赖交付方摘要作为成立证据。
- 写入约束：未修改源码、测试、配置或旧证据；本次仅写入本报告。未运行 Vitest、类型检查、构建、Electron 或真实 Pi 子进程。

## 结论

**CHANGES_REQUIRED**

**Blocking finding count: 1**

上轮五项生命周期修复主体已经落地，但 prompt 成功投递后的异常清理仍可在没有旧 turn 终止事件时提前释放串行屏障，使替代 prompt B arm；随后 A 的迟到 `agent_settled` 会被当前 B 的 armed turn 消费并结束 B。该路径不在 round5 新增回归覆盖范围内。

## B1：prompt 投递后的错误处理提前释放 turn 屏障，迟到 settled 可结束 B

### 位置

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/ipc.ts:2144-2162`
- 串行屏障实现：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/ipc.ts:969-993`
- settled 归属与结束：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/ipc.ts:1254-1291`
- arm 与所有权设置：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/ipc.ts:2070-2087,2091-2121`

### 触发条件与顺序

1. A 的 `prompt` 命令已成功返回，A 的 turn 已设置 `taskId`、`admission` 和 `readyForSettled=true`。
2. 投递后的 `get_state` await 失败，或者在 await 期间 A 的 admission 被其他 Task/stop/workspace/permission-mode 操作替换或失效，于是 `assertPromptOwnership()` 抛错。
3. `catch` 无条件执行 `completePromptTurn(resolvedSessionId, turn)`。此时没有观察到 A 的 `agent_settled`，也没有确认旧 turn 已终止，但队列尾已经释放，A 的 armed turn 也已删除。
4. 排队的 B 因此通过 `previousQueued`，建立并 arm 自己的 turn。`TaskLifecycle.start()` 提交 B 时撤销 A，A 原来的 admission 失效并不能阻止后续事件被归给 B。
5. A 随后发出 `agent_settled`。Pi 的该事件没有 turn id；handler 从 `promptTurnsBySession` 读到的是 B，对 B 执行 `assertOwner(sessionId, { taskId: B.taskId, admission: B.admission })` 并成功，最终调用 `lifecycle.end(sessionId, 'session-ended', B.admission)`。

### 影响

- 直接违反“replacement 等待旧 turn 结束才 arm”。
- A 的终止事件可提前结束 B 的 TaskGrant；B 可能仍在执行，但后续 action 因无 owner 被拒绝，前端也会收到 B 的终止事件。
- 同一事件还会继续执行 `persistHitTurn`、`noteSettled` 和 idle release 调度，因此影响不限于 Grant 撤销。
- 原有 binding lease/sessionGeneration 守卫不能解决此问题：A、B 可以共用同一 client、同一 session ID 和同一 lease，缺口来自 Task turn 归属，而非 transport generation。

### 最小修复要求

区分“prompt 尚未成功投递”与“prompt 已成功投递”：

- 发送前失败且确认未投递时，可以释放队列。
- 成功投递后，不得仅因 post-send `get_state` 失败或 admission 变化而释放屏障；应等待能证明旧 turn 终止的 owned/cancelled terminal event。
- 如果 transport 故障导致 terminal event 永远不来，必须先中止并确认旧 runtime turn 终止，或退休/重建该 slot 后，才能释放队列；不能把“命令响应失败”直接等同于“agent turn 已结束”。
- 增加回归：A 的 `prompt` 成功、post-send `get_state` 被挂起后 reject；启动 B 并断言在 A terminal 前没有发送 B 的 `prompt`；随后投递 A 的 settled，再验证 B arm 且不会被下一次迟到事件结束。

### 范围限制

本 finding 针对 `sparkii:promptSession` 中 `behavior === 'prompt'` 且 prompt 已成功投递后的异常路径。它不是对 prompt 发送前失败的指控，也不声称所有正常成功路径都有问题。结论来自明确的 await/catch 顺序和现有事件归属逻辑；本次未在真实 Pi 子进程中动态复现。

## 上轮五项重点复核

| 重点 | 结论 | 证据与边界 |
|---|---|---|
| admission-bound proposal 不被通用 handler 覆盖或重绑 B | 通过 | `workflow.ts:609-636` 安装闭包原 `workflowTaskId/workflowAdmission` 的 dispatcher；`ipc.ts:3493-3517` 的 `onReady` 只调用 `bindRuntimeActions`，并明确不替换 proposal dispatcher。`ipc.test.ts:6216-6301` 使用生产 `registerIpc` 和真实 `TaskLifecycle`，断言旧 proposal 不产生第二次 Gate submit、不重绑 replacement。 |
| 原 admission 失效/onReady 无 admission 不清理 replacement | 通过 | `workflow.ts:566-577,640-648` 区分原 admission 与当前 admission；`ipc.ts:3520-3540` 在无原 admission 但存在 replacement 时返回 false。`workflow-broker.test.ts:201-279` 覆盖 beforeRelease await 中替换、onReady 已产生 grant 后抛错、无 admission 且无 replacement 时清理自身 binding。 |
| pending replacement 原子 owner；旧 action/steer/followUp 不可执行 | 通过 | `task-lifecycle.ts:126-148` 对非 committed admission 返回无 owner；`ipc.ts:574-633` 在 action 入口捕获 owner 并在 route 前后复核；`ipc.ts:2123-2136` 对 steer/followUp 使用原 admission/owner。`ipc.test.ts:6491-6538` 断言 pending 时无 `steer`/`follow_up` 命令、action 为 `TASK_REVOKED`、workspace executor 未调用。 |
| 重复 taskId 被拒绝且旧 cancellation 不串扰 | 通过 | `task-grant-registry.ts:40-49` 在撤销旧 session grant 之前检查进程级永久 `usedTaskIds`；`task-lifecycle.ts:76-107,245-260` 失败时只恢复仍有效的 previous，否则保留 cancelled barrier。task-lifecycle 与 `ipc.test.ts:6540-6616` 覆盖重复 ID、旧 cancellation 和 late send completion。 |
| replacement 等旧 turn 结束才 arm；迟到 settled 不结束 B | **不通过** | 正常 terminal-event 路径由 `ipc.ts:2070-2087` 串行化，`ipc.test.ts:6449-6489` 覆盖 A/B/C  successive settled；但 B1 的 post-send catch 绕过该屏障。`ipc.test.ts:6540-6616` 先发 A settled 再启动 B，验证的是迟到 send completion，不是“A 无 terminal 却释放屏障后，迟到 A settled 结束 B”。 |

## 关键 await 边界复核

- **model / thinking / key / complete**：`workflow.ts:236-291` 与 `ipc.ts:2269-2357` 在 settings/key await、实际 `set_api_key`/`set_model`/`set_thinking_level`/`complete` 命令及持久化前后复核原 binding。stale same-client replacement 回归见 `ipc.test.ts:5808-5873`。
- **prompt**：投递前 staging/image/get_state/queue await 有 binding guard；成功投递后的 ownership guard 存在，但 catch 的屏障释放见 B1。
- **tool**：side-effect tool 将原 `{taskId, admission}` 传给 broker，并在 approval/执行路径复核；read 类 tool 在 await 后复核 binding，loop 在下一步前复核 admission。已经发出的读取不会被伪称可撤回；read 路径本身不享有 side-effect action 的 TaskGrant 执行保证。
- **approval**：`workflow.ts:33-192` 的 resolver 保存原 Task/binding；Gate submit/decide 返回 canonical map 对象；`ipc.ts:3055-3219` 在 export path、capability lease、audit、connector 执行和最终 settlement 前复核 canonical proposal 与 owner。
- **journal**：`workflow.ts:684-772` 对 `append_workflow_entry` 做 binding/admission 前后检查并检查 `success`；`ipc.ts:2505-2537` 的 export journal 失败向上传播，只撤销原 grant。`ipc.test.ts:6670-6768` 覆盖 reject、`success:false`、stale failure 和 await 中 rebind。
- **event**：binding/generation 过滤与 owner/admission 检查存在；无 turn id 的事件在 B1 所述重叠窗口仍会误归给 B。
- **同 ID release/reacquire 与 teardown**：pool 每次 bind 都递增 lease；stale expected lease release 被忽略；release 先摘 alias/session id 再 reset。`ipc.ts:2701-2758,2854-2888` 的 stop/release 捕获原 binding/admission，在 cancellation、parse-session、get_state 后复检，再释放原 lease。`pi-runtime-pool.test.ts:282-350,761-777` 覆盖 stale release、同 client/同 ID lease 轮换和 pre-reset event 过滤。
- **permission mode**：`ipc.ts:3017-3054` 先持久化 mode、撤销原 shell grant，再以捕获 admission 结束 Task；`TaskLifecycle.end()` 在首个 await 前已删除 admission 并撤销 registry grant，因此 cancellation await 期间旧权限不会继续存活。`ipc.test.ts:5393-5427` 验证替代 Task 不被旧模式切换撤销。

## Logger 复核

- `logger.ts:14-15` 按 `CRLF | CR | LF` 拆物理行；`logger.ts:137-143` 对非空 rewrite 输出补一个 LF；合法 JSON 逐行解析，损坏行走 JSON string token 清理或安全 placeholder。
- `logger.ts:31-38,116-135` 共享 key-aware 检测：非 schema 动态键命中登记秘密时拒绝输出；append、rewrite、export 都经过同一验证逻辑。
- `logger.ts:183-199` 在 append 前没有 await，`mkdirSync`/`appendFileSync` 与同步 rewrite 处于同一 JS 临界区，之前的未 await append 竞态已消除。
- `logger.ts:201-206` 的 export 异步读取后会重新脱敏并验证；journal/日志写盘失败不会被误报为业务成功。
- `logger.test.ts:264-358,397-498` 覆盖动态键、未来 append、重启、schema 保留、全部 JSON escape、malformed history，以及三种换行秘密与三种记录分隔符的九种组合。

**保留的 Logger 边界**：`SCHEMA_KEYS` 是名称白名单，而非“仅根对象可信 schema”的位置判断；若登记秘密本身恰为 `sessionId`、`msg`、`ctx` 等白名单名称，该名称作为键出现时会按 schema 保留。现有测试明确要求嵌套 `msg/level/ctx` 键保持不变，因此这是当前 schema-preservation 契约的边界，不能在报告中声称“任何登记字符串的所有字节形态都绝不出现”。非白名单动态键的秘密检测和值脱敏不因此失效。

## Round5 回归有效性

- 新增回归确实检查了生产 `TaskLifecycle`、生产 `registerIpc`、实际 `prompt`/`steer`/`follow_up`/`append_workflow_entry` 命令、Gate submit 次数、Task ID/admission、binding lease 与 release 调用，而非只断言 Promise reject。
- workflow 测试使用生产 `runWorkflow`/`createBroker` 和真实 registry/lifecycle，覆盖原 admission 绑定及 replacement cleanup。
- pool/supervisor 测试检查真实 pool 状态机、lease/generation、命令 envelope、退出等待和强制 kill；Logger 测试检查原始 JSONL 和 export 的逐行 schema/记录数/秘密。
- **覆盖缺口**：没有“prompt 已成功发送、post-send get_state reject、B 在旧 turn 无 terminal 时尝试 arm”的回归；现有 B7 先消费 A terminal，绕过了 B1。

## 已知限制与未验证事项

- **FakeHandle/ManualHandle 不证明真实子进程行为**。IPC FakeHandle、pool FakeHandle、supervisor ManualHandle、deferred client 和 mocked pool 只能证明主进程状态机与命令编排；不能证明真实 Pi 子进程的 prompt/steer/follow_up 并发顺序、provider 中断、JSONL flush、进程退出或 Windows 句柄行为。
- 未运行真实 Electron、真实 provider、真实 Pi 子进程或压力测试；本报告不把静态证据表述为运行时通过。
- `pi-runtime-pool.ts` 在 configure/switch await 后仍依赖 `ownsBinding`，未显式复检 `control.cancelled`；当前未发现绕过外层 binding 的执行路径，保留为非阻塞建议。
- `pi-runtime-supervisor.ts:149-225` 的异步 proposal/action/connector handler 在 await 后未复核 source-handle 同一性；当前池不进行同 supervisor 的 start→stop→start，且 Main owner/binding guard 提供主要隔离，保留为已知 API 边界。
- Windows 文件系统 TOCTOU、symlink EPERM fail-closed、真实文件系统崩溃与外部 provider 的终止语义未在本次复审中验证，也未声称已修复。
