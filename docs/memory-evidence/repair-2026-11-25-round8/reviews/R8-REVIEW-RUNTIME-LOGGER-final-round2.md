# R8-REVIEW-RUNTIME-LOGGER 独立只读审查报告

- 审查日期：2026-11-25
- 仓库：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi`
- 冻结清单：`docs/memory-evidence/repair-2026-11-25-round8/source-sha256.txt`
- 清单 SHA-256：`4f95259778b780c3893d50a1efc54105f04879b1da3b0802afcae1014f6d9ddc`
- 清单核对：66/66 文件 `OK`
- 审查方式：独立静态读取生产调用链和回归断言；未依赖 `R8-MAPPING.md` 或先前摘要；未修改文件，未运行测试、类型检查或构建。

## 结论

CHANGES_REQUIRED

Blocking finding count: 2

## B1：多个 IPC 控制路径没有贯穿原始 binding lease

位置：`apps/desktop/electron/main/ipc.ts:2935-2961`、`:1972-1983`；同类缺口见 `:1919-1927`、`:1956-1966`；已有守卫见 `workflow.ts:197-239`。

`sparkii:prompt` 获取原始 `{client, lease}` 后调用 `selectModel(rt, 'chat', sessionId)`，但没有传 `assertBinding`。`loadSettings()` 或 `rt.keyFor()` 期间同 ID release/reacquire，即使复用同一 client，旧流程恢复后仍会发送 `set_api_key`、`set_model`；最后 assert 只能阻止后续 prompt。`setChatModel` 在 `loadSettings()` 前捕获 open，恢复后既不复核 lease，也未向 selectModel 传守卫，可修改替代 binding 模型并覆盖 `appliedModelBySession`。`completeText`、`queueMutate` 也有 await 后继续向捕获 client 发命令的窗口。

最小修复：handler 入口捕获 `{client, lease}` 和 assertBinding；传给 selectModel，并在每次 await 后、发送命令或修改 binding 状态前复核；completeText、queueMutate 在 settings/queue await 后复核原 lease；考虑将 runtime-bound helper 的 binding 守卫改为必填。现有 promptSession/workflow 回归未覆盖 sparkii:prompt、setChatModel、completeText、queueMutate 的 deferred-await 后同 ID、同 client 重绑定。

## B2：`requestExportReport` 的 task admission、approval 和 journal 均未绑定原 lease

位置：`apps/desktop/electron/main/ipc.ts:2110-2123`；admission 包装见 `:581-660`；提交点见 `apps/desktop/electron/main/security/task-lifecycle.ts:29-38`。

`requestExportReport` 获取 open 后调用 `await startSessionTask(sessionId, open.profileId, true)`，随后 `await broker.route(...)`，获批后向 `open.slot.client` append workflow entry；两处都未传 assertBinding。若 createTaskGrant 的路径检查被挂起，旧 binding 释放后替代 prompt 提交新 Task，旧 factory 恢复后无 beforeCommit 守卫，会撤销并替换替代 Task。若 approval 等待期间重绑定，旧提案获批后仍可向复用 client 的替代 binding 追加 workflow_state。

最小修复：从 open 捕获 lease 和 assertBinding，传给 startSessionTask 和 broker.route；admission 返回后、approval 写操作前再次复核；失败清理只撤销本次 grant.taskId，不得按 session ID 结束可能属于替代流程的 Task。补充旧 export admission 挂起→替代 Task 提交→旧 admission 恢复，以及 approval 等待期间重绑定→不得 append 的回归。

## 已核对通过

- 清单 SHA-256 与给定值一致，66/66 文件 OK。
- workflow 主链原始 lease 覆盖 new_session、get_state、model/key、thinking、prompt、event、tool、approval、journal 和 finally release；journal append 前后均检查 binding。
- TaskLifecycle.start() 顺序为 factory → beforeCommit → registry.start → onStarted，提交前检查和 cancellation hook 注册顺序正确；问题在 B2 调用方未使用。
- pool 每次绑定递增 lease；stale release 不清理替代 alias；reset 失败退休 slot；事件同时校验 client、lease、generation、resetting。supervisor 旧 handle exit 有身份 guard，stop 等待真实 exit，超时强杀仍未退出会拒绝。
- setChatTitle 复用 ensureOpenSessionOwned()，listing/acquire 后复核 stopping/epoch，失败只释放自身 lease；发送 set_session_name 前再检查。`ipc.test.ts:5075-5117` 断言隐私删除后只释放 lease 1 且不发送命令。
- Logger.log() 内部无 await，appendFileSync 在返回 Promise 前完成；rewrite 同步写临时文件后 rename，同进程不存在未 await append 被后续 rewrite 覆盖的窗口。
- 有效 JSON 只脱敏字符串值，对象键保留；`\n`、`\r\n`、`\r` 九组合检查实际 JSONL 记录数和第二条记录；跨记录匹配要求同时含换行和非换行字符。
- 登记文件只保存哈希、长度和字符哈希；marker 避让已登记字符；回归覆盖重启继续脱敏、登记文件无明文和 marker boundary 重建秘密。

## 非阻塞建议

1. `pi-runtime-pool.ts:369-405` 的 bind() 在 configure/switch await 后未显式检查 control.cancelled；当前 ownsBinding 能拦截，建议补检查和测试。
2. `pi-runtime-supervisor.ts:126-170` handler await 后未复核 source-handle 身份；当前不做同 supervisor start→stop→start，若保留公开重启能力应阻止旧请求向新 handle 回包。
3. `logger.ts:92-96` 畸形行 schema key 白名单只有 msg/level/ctx；秘密恰为 ts 时可能整体替换畸形 canonical 行，fail-closed 但丢记录。
4. `logger.ts:38-40,113` 在任一物理换行秘密登记后把所有非 `{` 开头畸形行变 placeholder，可能过度清理无关历史；不泄露秘密。
5. setChatTitle 的 same-client replacement 直接回归可补充；当前通过共享 acquisition 路径间接覆盖。

## 验证范围与限制

本次只读静态审查，仅执行清单和 SHA-256 校验；未运行测试或构建。检查了实际命令类型和 set_api_key/set_model/set_thinking_level/prompt/append_workflow_entry/JSONL/binding lease 断言；通过指静态核对成立，不代表本次执行通过。FakeHandle、ManualHandle、deferred client 不代表真实 Pi 子进程；真实进程退出、命令并发顺序、文件系统和完整应用生命周期未做运行时验证。
