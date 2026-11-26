# R8-REVIEW-TRUTH-RECOVERY 独立只读架构复审报告

- 审查日期：2026-11-26
- 仓库：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi`
- 审查对象：当前工作树，不以旧 `source-sha256.txt` 作为当前源码哈希凭据。
- 审查方式：完整静态读取生产调用链和回归断言；仅运行不写仓库证据的 focused Vitest。除本报告外未写入或修改任何文件。

## 结论

CHANGES_REQUIRED

Blocking finding count: 2

上轮三项重点（auto session 恢复授权、`projects.json` 链接/硬链接/重解析围栏、privacy pending 目录围栏）对**预先存在的静态替换**已经关闭；但“每次 truth/privacy I/O 边界都重新探测当前属性”尚未完整实现，且相应回归没有走生产边界，因此本域不能放行。

## B1：关键 truth I/O 边界缺少新鲜 reparse 属性探测，B3 回归只直接调用 helper

### 证据

- `apps/desktop/electron/main/memory/truth-batch.ts:405-420`：`flushPathInspection()` 后先读取 target 比较内容，再对 target 执行 `copyFileSync()` 备份；这两次原始 I/O 前没有重新探测 target 的当前属性。
- `apps/desktop/electron/main/memory/truth-batch.ts:76-81`、`:441-450`：写入后的 `markRegularFileVerified()` 只检查 `lstat` 的 symlink/directory/nlink，不检查 `FILE_ATTRIBUTE_REPARSE_POINT`。
- `apps/desktop/electron/main/memory/truth-batch.ts:217-222`：恢复前虽有 per-file `flushPathInspection()`，但 `copyFileSync(backup, target)` 仍是路径 I/O；target 在探测后被替换时，写入可能跟随新链接。此为残余 Windows TOCTOU，不是本报告宣称已解决的事项。
- `apps/desktop/electron/main/memory/store.ts:563-583`：`allScopeFiles()` 对文件集合做一次批量属性探测，随后以 `readVerifiedScopeSnapshot(ref, true)` 跳过分文件探测。
- `apps/desktop/electron/main/memory/store.ts:502-515`：索引事务提交前的 `assertSnapshotCurrent()` 重新读取 truth，但没有调用 `assertTruthPathSafe()`。
- `apps/desktop/electron/main/memory/store.ts:941-948`：`viewOf()` 对 `row.file_ref` 直接 `readFileSync()`，没有属性探测或普通文件身份检查；`toView()` 会把解析出的 entry 内容返回给调用方。
- `apps/desktop/electron/main/memory/store.ts:1281`、`:1353`：`markSourcesDeleted()` 和 `deleteMemoryEntriesBySession()` 在 `allScopeFiles()` 后再次原始读取，二次读取前没有新鲜属性围栏。
- `apps/desktop/test/memory-truth-batch.test.ts:659-665`：所谓 B3 回归只是对 `assertTruthPathSafe` 连续注入两组属性数组，直接调用 helper 两次；没有经过 `commitTruthBatch`、`restore`、`allScopeFiles`、`reconcile`、`rebuild`、`viewOf` 或删除链。
- `apps/desktop/test/memory-r8-regression.test.ts:181-205`：registry 回归确实走 production list/search/rebuild，但攻击在调用前已放置；non-symlink reparse 由 mock probe 返回 16，并未验证“探测后转换”的生产边界。

### 触发与影响

需要本地攻击者能在最后一次属性探测与原始 I/O 之间替换目标，或把普通文件/目录原地改为非 symlink reparse point。此时：

- 外部 truth 字节可能进入 backup、解析结果、索引快照或 `viewOf()` 返回值。
- 若恢复目标在探测后被换成链接，`copyFileSync()` 可能向外部目标写入。
- 写入后仅 `lstat` 的验证无法发现非 symlink reparse 属性，提交可能继续。

本 finding 不是把通用 Windows TOCTOU 夸大为“可彻底消除”；恰恰相反，代码在多个明确 I/O 边界连要求的新鲜探测都没有执行。即使补上探测，路径检查与使用之间的残余 TOCTOU 仍必须继续披露。

### 最小修复与验收

1. 将 truth 原始读取、备份复制、恢复复制和写入后的验证收敛到同一组 fenced I/O helper；每个实际 I/O 边界前重新探测，读取/写入后再探测并核对身份。
2. 批量探测不能替代 per-file 探测；移除 `allScopeFiles()` 到 `readVerifiedScopeSnapshot(..., true)` 的跳过。
3. `assertSnapshotCurrent()`、`viewOf()`、二次删除读取和 `markRegularFileVerified()` 必须使用新鲜属性围栏。
4. 对可写的破坏性路径优先采用 no-follow 文件句柄并核对句柄身份；仅增加一次 `lstat`/属性探测不能声称消除 TOCTOU。
5. 增加生产边界回归：在第一次 probe 返回安全后，令后续 probe 返回 16，再分别调用 commit/restore/reconcile/rebuild/viewOf/delete，断言外部字节不变、外部内容不进入索引或返回值，并 fail closed。

## B2：privacy journal 清零写入跳过前置属性围栏，事后探测不能阻止外部文件被清零

### 证据

- `apps/desktop/electron/main/memory/service.ts:1073-1077`：`clearPendingPrivacy()` 先取得带围栏的 identity，然后把该 identity 作为 `verifiedIdentity` 传给 `removeZeroedPrivacyFile()`。
- `apps/desktop/electron/main/memory/service.ts:907-917`：helper 使用传入 identity，只做一次 `lstat` 身份比较，随后直接 `writeFileSync(file, Buffer.alloc(length))`；第一次 `assertPrivacyPathSafe(file)` 位于清零写入**之后**。
- `apps/desktop/electron/main/memory/service.ts:922`、`:927`：清零后的身份检查使用 `pathAlreadyFenced=true`，以及再次属性探测，均发生在破坏性写入之后。
- `apps/desktop/test/memory-r8-regression.test.ts:446-459`：身份变化回归在 cleanup 前改写 journal，能证明身份比较有效，但没有覆盖“身份比较后、清零写入前”替换目标。
- `apps/desktop/test/memory-r8-regression.test.ts:546-568`：privacy reparse 回归覆盖启动时 directory/temp 读取，不覆盖 journal 清零写入边界，且 reparse 属性是 mock 的。

### 触发与影响

攻击者在 `lstat` 身份检查通过后、`writeFileSync` 执行前，把 journal 路径替换为指向外部文件的 symlink、硬链接或 reparse point。`writeFileSync` 会按新目标截断并清零；事后属性探测只能发现异常并建立 privacy write-block，不能撤销外部文件损坏。

这同样不是声称所有 Windows TOCTOU 已解决；具体缺陷是 destructive write 前没有执行要求的新鲜属性围栏，且当前实现明确依赖调用方先前 identity 来跳过该围栏。

### 最小修复与验收

1. 禁止把先前 identity 作为 destructive helper 跳过前置围栏的理由；清零写入前必须重新探测目录和文件属性。
2. 更可靠的做法是以 no-follow 方式打开 journal，核对打开句柄与预期 identity 后通过该句柄清零，再按同一句柄回读；仅路径探测仍留有 TOCTOU。
3. 增加“identity/lstat 后、write 前替换为外部链接目标”的故障注入，断言外部字节完全不变、journal 明文清零且失败时保持 write-block。

## 已确认关闭或符合要求

### 1. auto session 发现不授权 journal 恢复

- 生产注入在 `apps/desktop/electron/main/runtime.ts:225-228`：恢复只接收 `workspaceKind === 'user'` 的 session workspace；`workspacePathsOf` 仍包含 auto session，但不作为恢复授权。
- `apps/desktop/electron/main/memory/service.ts:123-125` 只把 `projectWorkspacePathsOf` 注入 `recoverTruthBatch()`。
- `apps/desktop/electron/main/memory/truth-batch.ts:124-143` 的授权只来自显式 `projectFiles` 或 registry；journal 自声明字段不参与授权。
- `apps/desktop/test/memory-truth-batch.test.ts:609-639` 断言 auto-list-only workspace 的 victim 字节不变且后续 search 被阻断。
- 限制：`memory-round7-regression.test.ts` 的 A1/A2 没有注入生产 `projectWorkspacePathsOf`，因此不是 runtime 过滤链的端到端回归；生产过滤目前由静态调用链确认。

### 2. `projects.json` 预先存在的 symlink/硬链接/非 symlink reparse 替换 fail closed

- `apps/desktop/electron/main/memory/settings.ts:150-155` 在 registry 读取前调用 `assertTruthPathSafe()`；`:157-161` 只宽容 parse 错误，安全错误继续抛出。
- `apps/desktop/electron/main/memory/truth-batch.ts:107-116` 的 registry 读取同样先 fence。
- `apps/desktop/test/memory-r8-regression.test.ts:181-205` 对三种 replacement × list/search/rebuild 共 9 个生产调用断言抛错、外部 registry/truth 字节不变、外部文本不进入 SQLite。
- 限制：symlink/hardlink 是真实文件系统替换；non-symlink reparse 是 mock 属性，未证明真实 reparse point 行为。B1 的探测后竞争窗口仍存在。

### 3. privacy pending 目录预先存在的链接/重解析替换 fail closed

- `apps/desktop/electron/main/memory/service.ts:979-1000` 在 `readdirSync()` 前依次执行 `lstat`、属性围栏、第二次 `lstat`，并比较 dev/ino 与 directory/symlink 状态。
- `apps/desktop/test/memory-r8-regression.test.ts:417-444` 覆盖 dangling directory/file link；`:546-568` 用 mock 属性覆盖 directory/file 非 symlink reparse，并断言保留 temp、建立 write-block。
- 限制：reparse 用例是直接调用 `loadPendingPrivacyJournals()` 并替换 fence 方法，不是真实 reparse point，也不是完整 constructor 集成；B2 的清零写入前窗口仍存在。

### 4. journal/backup/write-block 与恢复顺序

- `truth-batch.ts:416-420` 使用 `copyFileSync` 保存原始字节 backup。
- `truth-batch.ts:217-223` 未提交恢复按 journal 逆序执行，符合 registry-first 写入的依赖关系。
- `truth-batch.ts:266-280` 清理先删 journal，再删 backups；journal 删除失败时不会继续删 backups。
- `truth-batch.ts:351-354` committed journal 不回滚；`:355-376` missing backup 逆序 best-effort 后 quarantine 并 write-block；`:282-304` 不可恢复时保留/隔离证据并建立持久及内存阻断。
- `truth-batch.ts:234-264` write-block 持久化失败仍保留内存阻断；损坏 marker 也 fail closed。

### 5. identity preflight、原始快照与索引提交

- `store.ts:474-500` 单次读取生成 text/hash/entries/identity。
- `store.ts:704-773` rebuild/replaceScopeIndex 在事务内重新读取并比较 identity/hash；变化抛 `TruthSnapshotChangedError`，保留旧索引。
- `store.ts:823-874` reconcile 使用同一 snapshot 决定 hash/count 并替换索引。
- 限制：B1 指出提交前二次读取缺少属性重探；快照一致性不等于路径属性安全。

### 6. 原生 helper 缺失/失败 fail closed

- `truth-path.ts:23-41`：helper 不存在直接抛错；`execFileSync` 超时、非零退出、输出数量或值非法均抛错。
- `SandboxProbe.cpp:83-90`：批量逐路径调用 `GetFileAttributesW`；任一失败返回 60，不输出“安全”假结果。
- `truth-path.ts:44-70`：逐段 `lstat` 拒绝 symlink/硬链接，并对已存在路径批量探测 reparse 属性。
- `store.ts:288-344`：SQLite 主库及 `-wal/-shm/-journal` 在打开前、打开后、schema 后、损坏隔离前和 fallback 前均有围栏；安全错误不进入 corrupt fallback。

### 7. privacy 恢复启动顺序

- `service.ts:119-131` 在 truth availability 判定前加载 privacy write-block/pending journal 并注册 sink 围栏；truth blocked 时仍尝试独立 Pi/chat carrier 清理。
- 不安全 memory root 仍在 `service.ts:119` 直接拒绝；本报告不宣称该场景可继续清理外部 carrier。

## 回归实跑

命令：

```text
pnpm exec vitest run apps/desktop/test/memory-truth-batch.test.ts apps/desktop/test/memory-r8-regression.test.ts apps/desktop/test/memory-round7-regression.test.ts --reporter=dot
```

结果：3 个文件通过，111/111 测试通过。绿灯仅证明当前断言通过，不证明 B1/B2 缺失的生产边界被覆盖。

## 当前源码 SHA-256

以下为本次复审实际读取的当前工作树哈希：

```text
05aeb14e57914eca20cc7c73138ac0d81be0fc4218c0ab26ae918321073a7431  apps/desktop/electron/main/memory/truth-batch.ts
80530565565dea6beaf3c8352f62c3f21ad34165e8dd1f5ce6ef22990430ebcd  apps/desktop/electron/main/memory/truth-path.ts
6f26ba0e287ebcbc994bc88a5940ffd758ae447604958d3a1508688a6934cf7f  apps/desktop/electron/main/memory/settings.ts
52a3be017b093d6f9b2fe5a40fb739d4279d69dde7640add8a5e82bd6b47d58d  apps/desktop/electron/main/memory/store.ts
e8555de18d82e8ce47f6f739729aaeefee38b4c2400c109b01e293ecb7ebbec9  apps/desktop/electron/main/memory/service.ts
a1ea5b4e31e6a8527dcabc3f239f6fa81c1294eb57b86b7d39af1588a897f242  apps/desktop/electron/main/runtime.ts
ca34daefcbf7bebd2332bd6387bbbdc1b723cb99385907fe799cf5fbe7ba4cdf  apps/desktop/native/windows-sandbox/SandboxProbe.cpp
7f488c389154d7bd820a9fc162eec3cb116a579a7da7926e32a4cbb9cd4d1639  apps/desktop/test/memory-truth-batch.test.ts
4f75d185254b60569357e7a170fc72e2e97d8fe9849a684889c7e9e7cdb46264  apps/desktop/test/memory-r8-regression.test.ts
72c6d89349c8d01b5d99bdbb8b271d0d72359e8848f8d13bab0416c5df412479  apps/desktop/test/memory-round7-regression.test.ts
```

现有 `docs/memory-evidence/repair-2026-11-25-round8/source-sha256.txt` 与当前工作树不一致，且未列出新增的 `truth-path.ts` 与 `SandboxProbe.cpp`；因此本报告不把该旧清单当作当前冻结证明。该证据清单问题本身不计入架构 blocking finding，但后续固化证据前应重新生成并核对。

## 验证范围与未验证限制

- 已完整静态读取 `truth-batch.ts`、`truth-path.ts`、`settings.ts` registry 路径、`store.ts` 的 allScope/reconcile/list/search/rebuild/markSourcesDeleted/preflight/delete/trustedProjectFiles、`service.ts` 构造恢复与 privacy 恢复调用、`SandboxProbe.cpp` 的 `reparse-attributes` 及调用，并核对相关 runtime 注入和回归断言。
- 未实机执行杀进程、断电、磁盘满、文件删除失败或 Windows 链接竞争攻击；未创建真实非 symlink reparse point。相关 reparse 回归使用 mock 属性，必须按此限制解读。
- Windows TOCTOU 未解决；symlink 创建可能 EPERM；`.sparkii` 外递归硬链接别名未覆盖；无跨进程 dataDir 锁；`atomicWrite()` 无断电 fsync/目录 fsync 保证。本报告没有把这些限制宣称为已解决。
- 111 个 focused 测试通过不等于 B1/B2 的生产边界已被覆盖；两项修复后必须重跑相同测试并新增能够在旧实现上变红的边界回归。
