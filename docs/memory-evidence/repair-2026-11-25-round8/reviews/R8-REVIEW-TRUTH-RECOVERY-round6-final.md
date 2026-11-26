# R8-REVIEW-TRUTH-RECOVERY Round6 终审报告

- 审查日期：2026-11-26
- 仓库：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi`
- 基线 HEAD：`101487d3f612764766cc024d4b28dbf846a926cf`
- 审查对象：当前未提交工作树；R6/R7/R8 改动未整体归为本轮新增
- 审查方式：完整静态阅读指定生产实现、回归断言和旧证据；对疑点运行仅使用系统临时目录的聚焦复现。除本报告外未写入或修改仓库文件，未执行 Git 写操作，未触碰真实用户目录或数据库

## 结论

CHANGES_REQUIRED

Blocking finding count: 5

Round6 已关闭 final-round5 的大部分新鲜探测和 privacy journal 清零前围栏问题，但仍有 1 个确定性提交状态缺陷和 4 个具体文件边界缺口。现有 127/127 回归通过不能覆盖这些路径，因此不能 APPROVE。

## 阻塞发现

### B1 — committed journal 已重命名后，写后验证异常仍会触发回滚并删除已提交证据

**严重度：High / Blocking**

**位置**

- `apps/desktop/electron/main/memory/settings.ts:54-70`：`renameSync(temp, path)` 后执行身份、内容和临时文件消失验证；任一步失败都会抛出。
- `apps/desktop/electron/main/memory/truth-batch.ts:427-439`：`committed = true` 只在 `atomicWrite()` 正常返回后设置。若 committed journal 已重命名但写后验证抛错，`committed` 仍为 `false`，catch 会执行 `restore(journal)` 和 `cleanup()`。
- `apps/desktop/test/memory-truth-batch.test.ts:116-128`：现有回归通过 `onCommittedJournalWritten` 在 `atomicWrite()` 返回后注入异常，未覆盖 `atomicWrite()` 内部重命名后验证失败的窗口。

**可复现触发路径**

1. 对原 truth 提交新内容，所有目标写入成功。
2. `atomicWrite()` 将 `{ version: 1, files: [], committed: true }` 重命名到 journal。
3. 重命名后的 fresh probe、身份/内容验证或临时文件消失检查抛错。
4. `commitTruthBatch()` 仍走未提交分支，把目标恢复为旧内容，并尝试删除 committed journal/backup。

本次用当前 TS 经内存 bundle、注入“journal 已含 committed 后 probe 抛错”的聚焦复现得到：调用抛错，目标值为 `ORIGINAL`，journal 仍存在且内容已 committed；错误为“提交失败且回滚失败”。这证明回滚发生在 durable commit marker 之后，而不是仅存在于理论分析。

**影响**

已提交的新 truth 可被旧备份覆盖，造成确定性数据丢失。若回滚后的清理成功，committed marker 和唯一原始备份都会被删除；若清理失败，重启恢复会将该 journal 视为已提交并直接清理 backup，也不会撤销已经发生的错误回滚。该问题不依赖 Windows TOCTOU。

**建议**

- 将提交点定义为 committed journal 的 rename 成功，而不是 `atomicWrite()` 全部验证返回。可由原子写 helper 在 rename 成功后、验证前通知提交阶段，或使用专门的 commit-marker 写入路径。
- catch 中若无法确定 commit 状态，必须保留 journal/backup 并 write-block，不得回滚；若重新安全读取确认 committed，则只做 committed cleanup，绝不 restore。
- 增加“rename 后、atomicWrite 返回前”验证失败回归，覆盖一次性及持续性 probe 失败，并断言目标保持新值、backup 不被错误回滚消费、重启后仍保持新值。

### B2 — verified copy 的 source 最后探测后还执行 destination 探测，旧 source 身份被用于实际复制

**严重度：High / Blocking**

**位置**

- `apps/desktop/electron/main/memory/truth-path.ts:231-244`：先检查 `sourceBefore`，再执行 `destinationImmediatelyBefore` 的 fresh probe + 双 lstat，随后直接 `copyFileSync(source, destination)`。实际 copy 边界前没有再次验证 source。
- `apps/desktop/electron/main/memory/truth-batch.ts:209-212`：rollback/recovery 使用该 helper 将 backup 复制到 truth target。
- `apps/desktop/electron/main/memory/truth-batch.ts:394-398`：pre-backup 也使用同一 helper。

**可复现触发路径**

1. backup/source 已通过 verified read，目标 destination 已通过前置检查。
2. 在 `destinationImmediatelyBefore` 的探测窗口内，把 source 替换为外部文件的硬链接。
3. `copyFileSync` 将外部字节写入 destination；事后内容比较和 source 身份检查才失败。

聚焦复现结果：destination 从 `PARTIAL_TRUTH` 变为 `EXTERNAL_SECRET`，外部文件本身字节不变，helper 最后抛“复制内容不一致”。在 recovery 路径中，destination 就是待恢复的 truth 文件，因此原 truth 已被外部内容覆盖后才进入 write-block。

**影响**

外部文件内容可进入恢复目标或 backup，原 truth 完整性在失败关闭前已被破坏；本地可读 dataDir 的攻击者可取得被复制的外部字节。此处不是宣称消除 check-use 之间的最后微窗口，而是 source 在额外 destination 探测期间明确变成陈旧能力，且 copy 后才发现。

**建议**

- 先完成 destination 的双重检查，再在 `copyFileSync` 前立即执行 source 的新鲜双 lstat/属性探测并比较预期身份；copy 后继续验证 source 与 destination。
- 可行时使用 no-follow 句柄或平台能力更强的复制原语，避免路径解析替换。
- 增加“destination 最后一次探测期间替换 source”的生产恢复回归，断言 destination 原字节不变、外部内容不进入 truth/backup、失败时保留证据。

### B3 — `MemoryStore.compact()` 对损坏 DB/journal 使用陈旧 lstat 后直接清零并删除，可清零外部硬链接

**严重度：High / Blocking**

**位置**

- `apps/desktop/electron/main/memory/store.ts:1244-1252`：`memory.db.corrupt-*` 先 `lstat`，再 fresh probe，随后 `writeFileSync(file, Buffer.alloc(info.size))` 和 `rmSync()`；没有 probe 后的第二次身份比较、句柄 `fstat`、写后验证或 verified remove。
- `apps/desktop/electron/main/memory/store.ts:1254-1260`：`memory.db-journal` 使用相同模式。
- `apps/desktop/electron/main/memory/store.ts:1389-1399`：生产隐私删除在 truth commit 后调用 `compact()`，因此这不是不可达的纯 helper。

**可复现触发路径**

1. 准备一个普通单链接的 `memory.db.corrupt-*` 或 `memory.db-journal`。
2. 在 `lstat` 与 probe 之间保持旧身份，在 probe 返回安全属性后把路径替换为外部文件硬链接。
3. 代码使用旧 `info.size` 对新路径执行截断写零，再删除该目录项。

本次使用真实 `MemoryStore` 和 better-sqlite3 的聚焦复现得到：外部 20 字节文件变为 20 个 NUL，corrupt 路径消失，外部原链接仍存在。journal 分支具有同样代码结构。

**影响**

隐私删除或普通 compact 可破坏 dataDir 外的文件内容。事后没有任何验证能撤销清零。该缺口与已修复的 privacy journal 清零 helper 不同：这里仍依赖 probe 前的 `lstat`，且破坏性 path write 前没有二次身份确认。

**建议**

- 将 DB/journal 清零收敛到与 `removeZeroedPrivacyFile()` 同级的句柄 helper：fresh probe + 双 lstat、no-follow open、`fstat` 身份比较、原长度 `ftruncate`、写零/fsync、同句柄回读、关闭后路径身份复核、verified remove。
- 增加 corrupt backup 与 `-journal` 两类回归，在 probe 后替换为外部硬链接，断言外部字节不变且清理失败关闭。
- 在 compact 入口保留 truth write-block 检查，避免未来新增调用方绕过可用性围栏。

### B4 — privacy pending journal 的 temp rename 跳过 rename 后 fresh probe，可接受不安全 journal 后继续清理

**严重度：High / Blocking**

**位置**

- `apps/desktop/electron/main/memory/service.ts:1123-1131`：temp 写入后只做路径 fence，没有保存 temp 身份；rename 后调用 `privacyJournalIdentity(file, undefined, true)`，`pathAlreadyFenced=true` 明确跳过 fresh reparse probe。
- `apps/desktop/electron/main/memory/service.ts:897-909`：该 identity helper 在跳过 probe 时只检查 `lstat` 的普通文件、symlink 和 `nlink`，不能识别非 symlink reparse point。
- `apps/desktop/electron/main/memory/service.ts:1191-1243`：journal 持久化后继续执行 sink、truth、Pi/chat 清理，最后才再次围栏并清除 journal。

**可复现触发路径**

1. temp 已写入含秘密的 pending journal，pre-rename fence 返回安全。
2. 在 temp fence 与 rename 之间将 temp 换成非 symlink reparse point，或使 rename 后的目标获得 reparse 属性。
3. rename 后的 `pathAlreadyFenced=true` 不执行属性 probe，`lstat` 仍可能显示普通单链接文件，方法因此返回成功。
4. 隐私清理继续；只有最终 `clearPendingPrivacy()` 的新鲜围栏才发现问题。若进程在最终清理前崩溃，重启加载器会拒绝该 journal，可能无法恢复注册秘密语料。

聚焦 helper 复现中，注入使 rename 后 journal 被 mock 为 reparse：`persistPendingPrivacy()` 仍成功，期间对 journal 的 fresh probe 次数为 0；随后 `clearPendingPrivacy()` 才抛“包含重解析点”。这直接证明 post-rename 属性验证被跳过，而不是残余微窗口。

**影响**

隐私删除可能在没有可恢复 journal 的情况下继续修改 sink/truth。崩溃后即使加载器 fail closed，未提前登记的秘密仍可能留在 Logger/Audit/Error/Chat 等载体。硬链接和 symlink 多数会被 `lstat` 拦住，但非 symlink reparse 正好被跳过的属性探测遗漏。

**建议**

- temp 写后保存双 lstat 身份；rename 前立即重新围栏并比较 source/destination 预期身份；rename 后必须 fresh probe + lstat，比较 rename 前后 dev/ino/mode/nlink/size，并验证 journal 内容/digest。
- 禁止把 rename 前的 destination fence 作为 rename 后 `pathAlreadyFenced=true` 的依据。
- 增加“temp fence 后、rename 前/后引入 reparse 或身份替换”回归，断言持久化阶段即失败，任何 sink/truth 清理尚未开始，pending/read fence 保留。

### B5 — agents/proposals 目录在 fresh fence 前枚举，可泄露外部文件名并触发重建

**严重度：Medium / Blocking**

**位置**

- `apps/desktop/electron/main/memory/store.ts:423-428`：`hasTruthFiles()` 对 agents/proposals 直接 `existsSync` + `readdirSync`。
- `apps/desktop/electron/main/memory/store.ts:522-527`、`:556-561`：`allScopeFiles()` 在目录 fresh fence 前枚举 `.json` 文件名；逐文件 probe 发生在 `:563-566`，已经太晚。
- `apps/desktop/electron/main/memory/store.ts:252-256`：构造器只围栏 memory root，随后直接 `mkdirSync` agents/proposals，未拒绝预先存在的 junction/reparse 目录。

**可复现触发路径**

1. 启动前把 `memory/agents` 或 `memory/episode-proposals` 换为指向外部目录的 junction。
2. `hasTruthFiles()`/`allScopeFiles()` 先枚举外部目录中的 `.json` 名称。
3. 逐文件读取随后因目录链接失败，但 scope ID、label 和 repair warning 已包含外部文件名。

真实 Windows junction 聚焦复现得到 `allScopeFiles()` 返回 `agent:EXTERNAL_SECRET_AGENT`，并带目录链接错误。`MemoryService.list()` 会将该 scope 名称放入 `label`/warning，因此外部文件名可进入 UI/API。本次未证明外部文件正文被读取。

**影响**

外部目录文件名元数据泄露，外部目录还可决定是否触发 index rebuild 和产生修复提示。这是预先存在的静态替换即可触发的读取边界缺口，不是 TOCTOU 限制。

**建议**

- 在 `existsSync/readdirSync` 前使用目录专用 verified helper：双 lstat、fresh reparse probe、要求目录且非 symlink，并在枚举后复核身份。
- 构造器在 mkdir 后、`hasTruthFiles()` 前围栏 agents/proposals；不要在已经枚举之后才依赖逐文件 probe。
- 增加预先存在的 agents/proposals junction 与 mock reparse 回归，断言 list/rebuild 在枚举前失败，外部文件名不进入 scope、label、warning 或索引。

## 已核对主张与证据

### 1. journal/backup 状态机与授权

- `parseJournal()` 拒绝空未提交 journal、重复 target/backup、committed 且保留文件项等结构（`truth-batch.ts:173-206`）。
- 目标白名单仅覆盖 user/registry/episodes/extraction-state、agents/proposals 直接子 JSON 和授权的 `.sparkii/memory.json`（`:145-170`）。
- 项目授权只来自显式 `projectFiles`、当前 registry 或 staged registry；journal 自声明路径不参与授权（`:107-143`）。
- 生产 runtime 仅把 `workspaceKind === 'user'` session 注入恢复授权；auto session 不因 discovery 获得恢复写权限。indexed/unregistered project 在 commit/privacy delete 中通过 registry、privacy_recovery、memories.workspace_path、scope_files 的既有索引链获得授权；auto-list-only 项目仍不可写。
- registry-first 排序、逆序 rollback、先删 journal 后删 backup、missing backup 的 best-effort restore/quarantine/write-block 均保留（`:209-260`、`:334-360`、`:381-399`）。
- B1 是上述状态机在 `atomicWrite()` 提交点上的新缺陷；其余 journal 结构和授权检查未发现回归。

### 2. fresh probe、双 lstat 与 copy/rename/remove/read 后验证

- `inspectTruthFile()` 每次先执行 fresh native probe，再 `lstat` 并检查普通文件/目录和 `nlink === 1n`（`truth-path.ts:153-160`）。
- `inspectTruthFileTwice()` 的一次 native probe + 两次 lstat 是已披露的性能折中；它比较完整身份并支持 expected identity（`:163-180`）。
- verified read 在读取前双 lstat、读取后 fresh probe + 身份验证（`:202-210`）。
- `atomicWrite()` 校验 parent/target/temp，rename 后比较 dev/ino/mode/nlink/size，再 verified read 比较内容并确认 temp 消失（`settings.ts:28-74`）。
- verified rename 比较 source 前后身份及 destination dev/ino/mode/nlink/size；verified remove 在删除前双重检查并确认删除后不存在（`truth-path.ts:252-299`）。
- 旧 final-round5 B1 中的 reconcile/rebuild 陈旧批量探测、第二份 scope read 未重探、`viewOf` 直接读 row 路径，已在当前实现关闭：逐文件 `readScopeSnapshot()` 重新探测，索引事务提交前 `assertSnapshotCurrent()` 再次 verified read，`viewOf()` 也走 snapshot。
- B2/B4/B5 是当前仍存在的新边界，不能用上述 helper 的一般正确性概括为已关闭。

### 3. write-block 与读取侧阻断

- 持久 marker 损坏、非法或不可读均 fail closed；进程内 `blockedDataDirs` 优先（`truth-batch.ts:236-251`）。
- `MemoryStore.assertAvailable()` 同时检查 truth write-block 和 privacy pending（`store.ts:406-421`）。
- `allScopeFiles()`、`readVerifiedScopeSnapshot()`、`rebuild()`、`reconcileAll()`、`rowFor()`、`rowsBySession()`、`search()`、`viewOf()` 均直接或经 reconcile 经过该围栏（`store.ts:474`、`:518`、`:688`、`:807`、`:891-897`、`:924-945`）。
- `memory-r8-regression.test.ts:682-694` 保留同进程 list/search/row/rebuild 阻断；registry symlink/hardlink/mock reparse × list/search/rebuild 回归也保留。

### 4. privacy deletion 与 truth recovery 交互

- 启动顺序为 root fence → privacy write-block → pending journal → sink 登记 → truth recovery → truth availability → MemoryStore/index → privacy resume（`service.ts:121-149`）。
- truth blocked 时仍尝试独立 Pi/chat carrier 清理；carrier 删除前要求绝对路径、fresh fence、双完整身份，删除后确认不存在（`:177-220`）。
- `removeZeroedPrivacyFile()` 已实现清零前双 fresh fence、open 后 `fstat`、原长度清零/fsync、同句柄回读、关闭后身份验证和 verified remove（`:949-1013`），旧 final-round5 B2 已关闭。
- privacy delete 在 preflight 后、任何 sink/truth 变更前持久化 journal；各 sink 独立 try/catch，pending maps 只在 journal 清零删除成功后移除（`:1161-1245`）。
- B3 位于 privacy delete 调用的 compact；B4 位于同一删除链的 journal 持久化，因此 privacy 主流程尚不能放行。

### 5. R7 回归保留情况

- `memory-round7-regression.test.ts` 当前 889 行、28 项，仍覆盖全 carrier 隐私清理、indexed/unregistered project、auto-list-only 不写、冲突驱逐、Gate listener 重试、动态 pending-op 键收集/递归脱敏/碰撞 fail closed。
- 未删除或弱化 R7 断言；本轮未修改任何测试。

## 测试与静态审查范围

### 静态阅读

完整阅读：

- `apps/desktop/electron/main/memory/truth-path.ts`
- `apps/desktop/electron/main/memory/settings.ts`
- `apps/desktop/electron/main/memory/truth-batch.ts`
- `apps/desktop/electron/main/memory/store.ts`
- `apps/desktop/electron/main/memory/service.ts`
- `apps/desktop/test/memory-truth-batch.test.ts`
- `apps/desktop/test/memory-r8-regression.test.ts`
- `apps/desktop/test/memory-round7-regression.test.ts`

并阅读旧 truth review、final-round5 review、`R8-FIX-round6-truth-privacy.md`、`after/round6-truth-privacy.txt`、`after/round6-privacy-fences-focused.txt`，复核 `privacy-redactions.ts`、`SandboxProbe.cpp`、runtime 注入和相关 consolidation/extraction 调用点。

### 本次聚焦复现

未重复启动全套。使用当前 TS 的内存 bundle 和系统临时目录完成 5 个聚焦复现，结束后均删除临时目录：

1. committed journal rename 后验证失败：确认错误回滚已提交 truth。
2. copy destination 探测期间替换 source：确认外部字节先写入 destination，事后才失败。
3. 真实 `MemoryStore.compact()` + better-sqlite3：确认外部硬链接被清零。
4. privacy temp rename 后 mock reparse：确认持久化成功且 rename 后未执行 fresh probe。
5. 真实 agents junction：确认外部文件名在目录围栏前进入 scope。

这些复现用于证明具体代码路径，不替代完整 Vitest、真实 Electron/Pi 或实机 reparse 验证。

### 已有测试证据

已阅读主线程既有证据：三文件完整串行 3 files passed、127 passed；聚焦 16 passed、111 skipped。本次未重新运行该全套，也不把既有绿灯视为覆盖 B1-B5。

## 未计为 blocking 的边界与建议

- `settings.ts` 的 settings/registry 单文件写入仍走 `atomicWrite()`，但不进入 truth batch，也不读取 truth write-block。这是旧 review 已披露的单文件幂等写例外；未发现它改写 journal 授权 truth 集合的新旁路。
- privacy temp 启动提升使用原始 rename，缺少 source 立即身份比较；其 rename 后调用默认 fresh probe，最终清零也重新围栏，本次未证明可绕过硬链接/reparse 检查改写外部字节。仍建议改用带 expected identity 的 verified rename。
- `PrivacyRedactions` 的持久指纹文件仍使用原始 lstat/read/rename。该文件只保存 SHA-256/length/字符指纹，本域未证明外部明文读取或破坏性外部写入；建议由 privacy 域统一接入 truth-path helper，不在本报告重复计票。

## 当前源码 SHA-256

```text
7c0b4cf7464ae7a232dbdc921622113cc4c134a20ba6dd3a572d99517310019b  apps/desktop/electron/main/memory/truth-path.ts
f33aaf9638ffcab335a2ae3b9b9fd70439e6b2d9b19c04b199a171ddc32a22f6  apps/desktop/electron/main/memory/settings.ts
b606839afec991e8d9e5373ebe7dbf4a3d7c61a6361c763cf6dca814a1f48699  apps/desktop/electron/main/memory/truth-batch.ts
078ae147c4d0612828c03c3d1f79fe66f16086f4c9a23df777f8b068e2c6a3ba  apps/desktop/electron/main/memory/store.ts
a16d8aacc944e72d50c8d4b2f93372f72ef411cc6593dfc386b6e84fcfde7dad  apps/desktop/electron/main/memory/service.ts
a248da76599d4106cbef68a80f4c0f1863e719507bf00809870eb81b4219d2d7  apps/desktop/test/memory-truth-batch.test.ts
7161862d6affdfc850eddf799c7d494355ead1e281f077d654c87f87080a3ce4  apps/desktop/test/memory-r8-regression.test.ts
cbc451c93a798355711eb2d7ad2621fb0fb5672f6899ab8fd7dce6b3458e79a2  apps/desktop/test/memory-round7-regression.test.ts
```

## 限制

- Windows 路径检查与 syscall 之间仍有 TOCTOU；一次 native probe + 两次 lstat、句柄身份和写后/删后复核只能缩小窗口。本报告的 B1-B5 针对的是缺失、跳过或明确陈旧的检查，不宣称消除所有 TOCTOU。
- symlink 探测在部分 Windows 场景可能 EPERM，当前 fail closed；未创建真实非 symlink reparse point，相关 reparse 复现使用 mock 属性。
- 未执行真实 Electron 打包环境、真实 Pi 子进程、杀进程、断电、磁盘满或真实用户存储测试。
- 无跨进程 dataDir 锁；`atomicWrite()` 不含 power-loss-grade 文件/目录 fsync 保证。
- 本次聚焦复现需要临时目录和故障注入；B4 为 helper 级证明，未实机执行“攻击竞争 + 进程崩溃 + 多载体残留”的完整链路。
- 工作树可能继续变化；上述哈希仅冻结本次实际阅读的版本。
