CHANGES_REQUIRED
Blocking finding count: 2
域 ID：R8-REVIEW-PRIVACY-FENCE

**阻断 1：不安全 truth 根目录仍可启动并写围栏外。**
`memory/service.ts:117-132` 将 `recoverTruthBatch()` 的不安全根警告仅放入 `recoveryWarnings`，随后无条件创建 `MemoryStore`；`truth-batch.ts:371-376` 该分支既不设置 `blockedDataDirs`，也不写 marker。`store.ts:229-239` 会继续建目录、打开数据库，`assertAvailable()`（356-365）因此放行。复现：把 `<data>/.sparkii/memory` 换成指向围栏外目录的 junction，再构造 `MemoryService`，可在外部目录生成 `memory.db` 并读取/写入，而非 fail-closed。现有 `memory-truth-batch.test.ts:205-221` 只验证恢复函数，未覆盖服务启动。

**阻断 2：正在打开的同 ID 运行时可绕过 teardown。**
`ipc.ts:2249-2283` 在 `getBinding()` 为空时只取消 transient waiter，不取消 `sessionOpenPromises` 或 pool acquisition，随即返回 true；`ipc.ts:713-718` 继续删除记忆。复现：让 `ensureOpenSessionOwned()` 在 `listPiSessions()`／`pool.acquire()`（1022-1035）等待期间尚未绑定，此时执行隐私删除；删除完成后 acquisition 仍可绑定并启动同 ID 会话。测试 `ipc.test.ts:4847-4948` 仅覆盖已有 binding 的 await 竞态，未覆盖无 binding 的打开中竞态。

**已验证范围：** 独立阅读 journal 加载/注册/恢复、truth 批量恢复与 write-block、全局四类清理、Chat 持久清理、runtime teardown 及测试。证据记载两轮 445 passed／1 skipped（`after/full-suite-round2.txt:233-234`）；本次只读，未运行测试。

**未验证限制：** Windows TOCTOU、symlink EPERM、`.sparkii` 外递归硬链接别名、FakeHandle 不代表真实子进程；均未假装修复。
