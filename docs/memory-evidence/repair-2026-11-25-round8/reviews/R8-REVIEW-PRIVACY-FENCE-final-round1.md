# R8-REVIEW-PRIVACY-FENCE 独立只读审查报告

- **审查日期**：2026-11-25
- **仓库**：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi`
- **审查域**：`R8-REVIEW-PRIVACY-FENCE`
- **冻结清单**：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/docs/memory-evidence/repair-2026-11-25-round8/source-sha256.txt`
- **清单 SHA-256**：`c53408a911473a865e80ed5ab60786337b4d10d93f92d2ba9d7b6d6590a1b5a4`，核对一致；清单内 63 个文件全部匹配。
- **审查方式**：静态读取生产调用链及测试断言；未依赖 `R8-MAPPING.md` 或先前审查摘要。
- **写入约束**：未修改源码、测试、配置或证据；为避免测试产生临时文件、缓存或覆盖物，未运行测试。

## 一、结论

**CHANGES_REQUIRED**

**Blocking finding count: 5**

现有实现正确覆盖了多数旧行清理、启动续删、Audit 持久脱敏、主 opening 路径的 lease/epoch 隔离，以及 `.sparkii` 围栏。但以下五项仍违反本次审查的隐私保证：

1. ErrorStore 没有持久脱敏登记，未来写入及 restart 可重新落盘明文。
2. Logger 脱敏语料仅存于内存，restart 失效；append/rewrite 也没有顺序保证。
3. ChatSessionStore 只清理既有行，没有未来写入防护，且遗漏 `id` 列。
4. privacy journal 持久化失败时可能完全没有 read fence，也没有持久失败 marker。
5. `setChatTitle` 的直接 acquire 绕过 privacy teardown 的 stopping/epoch 围栏。

---

## 二、关键调用链证据

### 1. 启动恢复顺序基本正确

生产装配顺序见：

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/runtime.ts:201-228`

Logger、Audit、Gate、ErrorStore、ChatSessionStore 均先于 MemoryService 装配，因此启动续删可以调用这些 sink。

MemoryService 构造顺序见：

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/memory/service.ts:112-134`

实际顺序为：

1. `recoverTruthBatch(...)`
2. `assertTruthAvailable(dataDir)`
3. `loadPendingPrivacyJournals()`
4. `registerPendingPrivacySinks()`
5. 清理 Logger 中既有 memory prompt 日志
6. 构造 MemoryStore
7. 无 journal 损坏时 `resumePendingPrivacy()`

这一顺序满足“危险 memory root 先阻断、pending journal 先于可能 rebuild/index 的 MemoryStore 生效”。

MemoryStore 的读取围栏见：

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/memory/store.ts:356-370`

普通读取、search、list、reconcile、rebuild 都会经过 `assertAvailable()`；只有 `runPrivacyCleanup()` 内部可以临时绕过 pending privacy fence。

### 2. 单次隐私删除顺序基本正确

核心流程见：

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/memory/service.ts:882-948`

顺序为：

1. 拒绝损坏 journal。
2. preflight truth，发现目标 entries、全部 episode 旧行及项目工作区。
3. 失效 extraction generation。
4. 收集旧行、pendingOp、episode summary/topic 等语料。
5. 持久化 pending privacy journal。
6. 建立内存 read fence。
7. 清理 Gate、Audit、ErrorStore、Logger。
8. 清理 memory truth/index/episodes/extraction state。
9. 删除 Pi session file。
10. 调用 ChatSessionStore 隐私清理。
11. 全部成功后才清除 journal。

因此，在 journal 成功持久化后，sink 失败、会话行丢失、Pi 文件缺失、truth row 丢失等场景均能保持 fail closed，并支持 restart 后续删。

journal 的恢复、校验和清理分别见：

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/memory/service.ts:801-840`
- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/memory/service.ts:842-879`

### 3. settings-page teardown 主路径正确，但存在旁路

settings-page 确实传入 `{ mode: 'privacy' }`，IPC 入口为：

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/ipc.ts:714-720`

该入口先调用共享 `stopSessionRuntime(sessionId)`，成功后才执行 memory/chat 清理。

共享 teardown 见：

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/ipc.ts:2273-2323`

主路径覆盖：

- 递增 opening epoch；
- 设置 `stoppingSessions`；
- 取消 pending acquire；
- 结束 task；
- 停止 document parser；
- 持久化最新 Pi session file；
- 按 expected lease 解绑释放；
- 取消 extraction。

expected-lease 释放见：

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/ipc.ts:1368-1376`

正常 `ensureOpenSession` 在 acquire 前后检查 stopping/epoch：

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/ipc.ts:994-1060`

但 `setChatTitle` 没有复用这套 guard，详见阻塞项 B5。

### 4. `.sparkii` 与危险 memory root

共享树围栏见：

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/security/workspace-tree-fence.ts:45`

其拒绝平台保留路径、symlink/junction/reparse point，并采用 child-before-parent 收集，不跟随链接。

主要递归操作入口均先经过该围栏：

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/security/workspace-executor.ts:129-220`
- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/security/workspace-executor.ts:297-357`
- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/security/workspace-executor.ts:400-446`
- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/security/workspace-file-service.ts:143-186`
- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/security/workspace-file-service.ts:273-299`

未发现围栏失败后回退到未检查递归删除/移动的路径。

truth batch 恢复及危险 root 检查见：

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/memory/truth-batch.ts:371-444`

结合 MemoryService 的构造顺序，危险 memory root 在外部 privacy sink cleanup 前即被阻断。

---

## 三、阻塞发现

### B1 — ErrorStore 未来写入与 restart 可重新引入明文

**严重度：High / Blocking**

**证据**

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/error-store.ts:48-54`
- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/error-store.ts:76-104`

`redactTexts()` 只更新当前 `error_events` 行，不保存任何 redaction registry。`append()` 直接插入 renderer 提供的 `id/message/source`，不应用已删除语料。

该接口在生产 IPC 中可达：

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/ipc.ts:3081`

**可触发场景**

1. 某次隐私删除成功，旧 error 行及原始 DB/WAL 字节已清理，journal 被删除。
2. 随后 `sparkii:appendError` 再次提交包含同一已删除秘密的 `message` 或 `source`。
3. 明文重新写入 `errors.db`；restart 后同样没有登记可加载，export/list 也会暴露该值。

**最小修复要求**

- 为 ErrorStore 增加持久、非明文的 redaction pattern 登记，可复用 AuditStore 的 SHA-256 + length 方案。
- `redactTexts()` 必须在同一事务中先登记 pattern，再清理旧行。
- `append()` 应用 pattern；读取/导出路径也应防御性应用。
- 覆盖 `id/message/source` 全部自由文本列。
- 增加 future append、reopen，以及 DB/WAL/shm/journal 原始字节回归。

### B2 — Logger 脱敏仅限当前实例，且 append/rewrite 未串行化

**严重度：High / Blocking**

**证据**

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/logger.ts:13-16`
- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/logger.ts:152-188`
- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/logger.ts:198-222`

`redactions` 是实例内存数组。`redactSession()` 只向当前实例登记，restart 后不会恢复。

`log()` 在 `await mkdir()` 后生成行并异步 `appendFile()`；`redactSession()` 则同步读取、写临时文件并 rename。两者没有共享队列、drain 或落盘前复核机制。

**可触发场景**

- **Restart**：隐私删除完成后重启，新 Logger 的 `redactions` 为空。之后若旧秘密再次进入日志上下文，会明文落盘，`export()` 也无法识别。
- **并发**：旧 append 已用旧 pattern 生成行但尚未完成写入时，privacy rewrite 可先 rename。代码没有保证迟到 append 在 rewrite 前完成，也没有保证其落盘前重新应用当前 registry。实际结果依赖 Node/文件系统时序，但现有实现不能证明并发安全。

**最小修复要求**

- 使用持久、非明文的 hash/length redaction registry，并在 Logger 构造时加载。
- 将 append、rewrite、export 纳入同一串行化机制；privacy rewrite 前 drain 旧 append，或 append 落盘前重新验证当前 registry。
- 增加 restart future-write 和受控 append/rewrite 交错的原始 JSONL 回归。

### B3 — ChatSessionStore 没有未来写入/restart 防护，且遗漏 `id` 列

**严重度：High / Blocking**

**证据**

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/chat-session-store.ts:111-154`
- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/chat-session-store.ts:190-220`

`create()`、`update()` 均直接写入，不应用隐私语料。`privacyDelete()` 只处理既有行，且列清单不包含 `id`。

**可触发场景**

1. privacy teardown 后，迟到的会话更新再次写入包含旧秘密的 `workspacePath`、`piSessionFile`、`inputs` 等字段。
2. 同 ID 或新会话随后重新创建并携带同一 carrier。
3. restart 后写入同样不受限制。
4. 如果已删除文本存在于其他会话的 `id` 中，该列不会被清理。

**最小修复要求**

- 为 ChatSessionStore 增加持久脱敏登记，并在 `create/update/updateWorkspacePathInTransaction` 及读取/导出路径应用。
- 将 `id` 纳入风险决策：若其不是严格生成且可能承载用户内容，必须清理/脱敏；若保证不可承载秘密，则记录并测试该约束。
- 增加删除后 update/create、restart，以及原始 DB/WAL/shm/journal 字节回归。

### B4 — privacy journal 持久化失败时可能 fail open

**严重度：High / Blocking**

**证据**

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/memory/service.ts:882-948`
- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/memory/service.ts:842-863`

当前顺序中：

- `deletedSessions.add(sessionId)` 在 journal 持久化之前；
- `pendingPrivacyTexts.set(...)` 在 journal 持久化成功之后。

`persistPendingPrivacy()` 的 `mkdir`、临时文件写入或 rename 失败时，会清理临时文件并抛错，但不会建立内存 read fence，也没有持久失败 marker。

**可触发场景**

磁盘满、`privacy-pending` 权限异常、rename 被安全软件或文件系统拒绝：

1. truth 尚未删除；
2. journal 未成功生成；
3. `pendingPrivacyTexts` 尚未设置；
4. `privacyUnavailableWarnings()` 仍可返回空；
5. 同进程 search/list/rebuild 继续读取明文；
6. 若没有留下可检测 marker，restart 也不会 fail closed。

**最小修复要求**

- 在任何持久化尝试之前建立内存 read fence。
- 持久化失败时留下可识别的持久 fail-closed marker，或拒绝后续 memory 读取/rebuild，直至完整性可证明。
- 增加 journal 写/rename 失败后，同进程及 restart 均不能 search/list/rebuild 明文的回归。

### B5 — `setChatTitle` 直接 acquire 绕过 privacy opening fence

**严重度：High / Blocking**

**证据**

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/ipc.ts:1931-1959`
- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/ipc.ts:994-1060`
- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/ipc.ts:2273-2323`

`setChatTitle` 在没有 open binding 时直接调用 `rt.pool.acquire()`，不检查 `stoppingSessions` 或 `sessionOpenEpoch`。其 `.then()` 直接读取当前 binding lease、写回 `openSessions` 并发送 `set_session_name`。

**可触发场景**

1. 会话当前没有 Pi binding。
2. privacy teardown 已设置 stopping、递增 epoch，并完成一次 `cancelAcquire`，正在 await parser/task teardown。
3. `setChatTitle` 此时发起新的 acquire，不在此前 cancellation 的覆盖范围内。
4. 若 acquire 在 teardown 最终检查之后完成，privacy deletion 可继续，但迟到 binding 仍然存在；随后 `.then()` 重新写回 `openSessions`。
5. 若 acquire 较早完成，teardown 会返回 false 并阻止删除，形成可用性竞争。

**最小修复要求**

- 让 `setChatTitle` 复用 `ensureOpenSession`，或抽取同一 opening acquisition guard。
- acquire 前检查 stopping/epoch，acquire 后复核。
- stale acquisition 只释放自己捕获的 expected lease，不得释放同 ID replacement。
- 增加“teardown 已 cancelAcquire 后，setChatTitle 新 acquire 不得在删除后残留 binding”的回归。

---

## 四、非阻塞问题与稳健性缺口

### N1 — Gate invalidation listener 失败后难以重试

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/packages/approval/src/gate.ts:148-205`

proposal 已脱敏并替换后，才调用 invalidation listener。若 listener 抛错，journal 重试时 proposal 已不再变化，可能不会再次触发通知。

生产 listener 当前只执行正常路径不抛错的 `settle()`：

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/workflow.ts:46-50`

因此目前不列为确定生产阻塞；但应保证 listener 成功前状态可重试，或持久记录待通知 invalidation，并补充 listener 抛错回归。

### N2 — journal 临时文件与清理失败边界

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/memory/service.ts:801-879`

loader 只扫描 `.json`，不扫描 `.tmp`；文件名 digest 也未与内容 sessionId 互相校验。此外，清零成功但 `rmSync` 失败时，restart 会把零长度 journal 视为损坏并永久 fail closed。后者主要是可用性/恢复语义问题，不是明文泄漏。

### N3 — 无 binding 分支没有调用 `taskLifecycle.end()`

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/electron/main/ipc.ts:2317-2322`

异常退出时可能赶上 binding 已卸下、task cancellation 尚未结束的窗口。当前 grant 已同步 revoke，未证明其能造成明文写入；建议明确该不变量并补真实时序测试。

### N4 — Audit“并发”测试没有制造异步交错

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/test/memory-r8-regression.test.ts:196-210`

`AuditStore.append()` 的 async 函数体没有 `await`，SQLite 插入同步完成。该测试能验证 future append/reopen，但不能证明真实并发交错。当前同步 SQLite 设计本身降低了该风险。

---

## 五、回归覆盖评估

| 保证 | 当前覆盖 | 评价 |
|---|---|---|
| pending journal 启动续删 | 四个 sink 各自失败后 restart；truth backup/journal 场景 | 覆盖较好 |
| chat row/Pi 文件已消失 | journal context 续删 | 已覆盖 |
| 持续 cleanup 失败时 fail closed | search 被阻断 | 已覆盖 |
| journal 持久化失败 | 无 | **缺失，对应 B4** |
| Audit 旧行、future、restart、原始字节 | 有 | 覆盖较好 |
| ErrorStore future/restart | 无 | **缺失，对应 B1** |
| Logger 同实例 future write | 有 | 仅部分覆盖 |
| Logger restart/append-rewrite 并发 | 无 | **缺失，对应 B2** |
| ChatSessionStore future/restart | 无 | **缺失，对应 B3** |
| Gate privacy-redacted 后禁止执行 | 有 | 覆盖较好 |
| Gate listener 抛错重试 | 无 | 非阻塞缺口 |
| teardown 主顺序与 lease 隔离 | 有 | IPC mock 层级覆盖较好 |
| `setChatTitle` acquire race | 无 | **缺失，对应 B5** |
| `.sparkii` junction/canonical/嵌套父目录 | 有 | 覆盖较好 |
| 危险 memory root 先于 sink cleanup | 有 | 覆盖较好 |

相关测试：

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/test/memory-r8-regression.test.ts`
- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/test/memory-round7-regression.test.ts`
- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/test/logger.test.ts`
- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/test/ipc.test.ts:4852-5119`
- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/packages/approval/test/audit.test.ts`
- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/packages/approval/test/gate.test.ts`

### FakeHandle / mock 限制

IPC 测试使用简化 FakeRuntime：

- `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/apps/desktop/test/ipc.test.ts:197-260`

其中 `cancelAcquire()` 只是 mock，不实现真实 pending/cold acquisition cancellation；document-parse-supervisor 被整体 mock；extraction cancel 只验证调用顺序。

因此这些测试能够证明主进程编排顺序和 mock lease 隔离，但不能证明：

- 真实 Pi 子进程在 configure/switch_session await 中途取消；
- 真实 parser 子进程销毁时序；
- 真实 in-flight model completion 与 privacy invalidation 的交错；
- `setChatTitle` 直接 acquire 与 teardown 的真实竞态。

---

## 六、未验证限制

1. 未运行 Vitest 或任何可能写文件的命令，因此不声称测试实际通过。
2. 未在真实 Windows 文件系统、杀毒软件或磁盘满条件下复现 journal/rename/WAL 失败。
3. 未启动真实 Pi 子进程验证 configure/switch_session 中途 cancellation。
4. Logger append/rewrite 的实际交错结果依赖 Node 文件打开与写入时序；静态代码只能证明缺少顺序保证，不能断言每次都会泄漏。
5. 原始字节测试使用 UTF-8 文本检索，适合当前 ASCII marker 样本，但不是任意二进制/Unicode 的通用取证方法。
6. 未验证真实多进程同时写同一 SQLite/JSONL 的行为；本次审查主要针对单 Electron 主进程模型。

## 七、最终判定

**CHANGES_REQUIRED**

**Blocking finding count: 5**

批准前至少应关闭 B1–B5，并增加对应的 future-write、restart、持久化失败和直接 acquire 竞态回归。`.sparkii` 围栏、危险 memory root 前置阻断、Audit 持久脱敏，以及主 teardown 路径的 lease/epoch 隔离无需因本次审查返工。
