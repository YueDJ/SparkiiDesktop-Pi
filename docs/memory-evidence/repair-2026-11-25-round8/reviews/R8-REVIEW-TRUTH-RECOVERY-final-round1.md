# R8-REVIEW-TRUTH-RECOVERY 独立只读审查报告

## 审查范围

源码：

- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\memory\truth-batch.ts`
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\memory\store.ts`
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\memory\service.ts`
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\memory\extraction.ts`
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\memory\consolidation.ts`

测试：

- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\test\memory-truth-batch.test.ts`
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\test\memory-r8-regression.test.ts`
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\test\memory-extraction.test.ts`
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\test\memory-consolidation.test.ts`
- `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\test\memory-round7-regression.test.ts`

为闭合调用链，另只读检查了 `settings.ts`、`index.ts`、`tools.ts` 及相关调用点。未读取 `R8-MAPPING.md` 或既有审查摘要，未修改任何文件。

冻结清单 `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\docs\memory-evidence\repair-2026-11-25-round8\source-sha256.txt` 本身 SHA-256 为：

`c53408a911473a865e80ed5ab60786337b4d10d93f92d2ba9d7b6d6590a1b5a4`

清单全部 63 个文件均通过 `sha256sum -c`。

---

## 关键调用链证据

### 1. Truth batch 提交与恢复

- 服务写入统一进入 `writeRef()`：`service.ts:370-387`，随后调用 `commitTruthBatch()`。
- `commitTruthBatch()` 先恢复旧批次并检查 write-block：`truth-batch.ts:451-455`。
- 原文件先以 `copyFileSync()` 备份，再写 journal：`truth-batch.ts:467-475`。
- journal 后重新验证目标路径，再逐个写真相文件：`truth-batch.ts:487-493`。
- 全部真相写入后才写 `committed: true`：`truth-batch.ts:494`。
- 清理或回滚失败会尝试恢复并写持久阻断标记：`truth-batch.ts:496-504`。
- 恢复时依次检查 memory root、write-block、journal 结构、目标/备份路径，再恢复或隔离：`truth-batch.ts:371-443`。
- 阻断标记读取失败、结构非法或路径不安全均返回警告：`truth-batch.ts:308-325`。

### 2. 隐私删除预检与不可逆清理

- `privacyDeleteBySession()` 先执行 `preflightDeleteBySession()`：`service.ts:884-904`。
- 预检枚举注册项目、恢复项目、当前会话工作区，并检查损坏文件与身份冲突：`store.ts:1093-1110`。
- 身份规则来自同一 `allScopeFiles()` / `identityConflicts()` 链：`store.ts:382-451`、`store.ts:470-497`。
- 预检通过后才持久化隐私恢复日志，然后清理 gate、audit、errors、logger：`service.ts:904-924`。
- 之后才提交记忆真相清理：`service.ts:925-932`。
- 最后删除聊天文件、清理恢复日志并发出事件：`service.ts:933-947`。

因此，identity、projectId、corrupt 预检确实位于不可逆全局清理之前。

### 3. 同进程围栏

- 统一围栏位于 `MemoryStore.assertAvailable()`：`store.ts:356-365`。
- reconcile、row、search、rebuild 分别经过该围栏：`store.ts:559-560`、`store.ts:667-720`、`store.ts:754-756`、`store.ts:804-805`。
- 服务 list、search、直接项目修复在读取或写入前也有围栏：`service.ts:475-486`、`service.ts:1096-1124`、`service.ts:1128-1134`。
- extraction 在直接查询 `store.db` 前调用 `synchronize()`：`extraction.ts:134-137`；模型返回后经 `ensureProject()` 再次检查可用性：`extraction.ts:161-168`。
- consolidation 只在 `runOnce()` 开头检查一次：`consolidation.ts:80`，后续异步阶段存在缺口，详见阻塞发现 F-1。

### 4. 重启围栏

- `MemoryService` 构造时先恢复 truth batch，再检查 write-block，之后才加载隐私日志和创建 Store：`service.ts:112-134`。
- 未完成隐私删除通过 `unavailable` 回调注入 Store 围栏：`service.ts:124-140`。
- 重启后恢复隐私删除：`service.ts:157-166`。

---

## 发现（按严重度）

### F-1：高，Blocking — consolidation 异步阶段可绕过 privacy/write-block 围栏

**证据：**

- 仅在开始时检查一次：`C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\memory\consolidation.ts:80`。
- 随后等待模型：`consolidation.ts:114-119`、`consolidation.ts:218-223`、`consolidation.ts:278-284`。
- 压缩阶段模型返回后，畸形输出直接返回，没有重新检查围栏：`consolidation.ts:224-232`。
- 过期项目阶段直接读取 `store.db` 并发送明文 prompt：`consolidation.ts:267-280`。
- 最终直接写 `consolidation_state`：`consolidation.ts:122`。
- 该 setter 自身没有围栏：`C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\memory\store.ts:991-992`。

**可触发场景：**

1. consolidation 已通过初始围栏，并进入压缩或项目复核模型调用。
2. 模型 Promise 未完成期间，另一任务执行隐私删除；某个 sink 失败，使 `pendingPrivacyTexts` 保持非空：`service.ts:904-924`。
3. 模型返回畸形 JSON，当前阶段不重新检查围栏便返回。
4. `stalePhase` 继续直接查询项目记忆，并可再次把明文发送给模型；即使没有项目行，也会执行 `setConsolidationLastRun()`，在阻断期间改写 DB/WAL。

write-block 在模型调用期间被创建时，同样可触发。

**最小修复要求：**

- 在每个异步阶段入口、每次模型 `await` 之后、下一阶段开始前以及最终写状态前重新调用 `store.assertReadAvailable()` 或等价围栏。
- 为 `setConsolidationLastRun()` 及直接 DB 查询增加 Store 层防御性检查。
- 增加 deferred Promise 回归：模型等待期间注入 privacy pending 或 write-block，断言后续不再发送明文、不写 `consolidation_state`/WAL。

### F-2：高，Blocking — 合法的空“未提交 journal”会被当作可恢复状态并删除唯一备份

**证据：**

- `parseJournal()` 只拒绝“已提交但仍有文件项”，没有拒绝“未提交且文件项为空”：`C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\memory\truth-batch.ts:256-266`。
- 正常提交在 `pending` 为空时直接返回：`truth-batch.ts:456-460`；非空提交必然生成非空 `files`：`truth-batch.ts:467-473`。
- 恢复逻辑对空未提交 journal 执行空恢复，然后删除 journal 和 backups 并返回可用：`truth-batch.ts:408-438`。

**可触发场景：**

1. 某批次已写入部分新真相，但尚未写 committed marker，磁盘上保留非空 journal 和原字节备份。
2. journal 损坏为合法 JSON：`{"version":1,"files":[]}`。
3. 恢复逻辑不将其视为损坏，删除全部备份并返回 `[]`。
4. 服务随后把部分新真相当作有效数据索引，原始备份已丢失。

这直接违反损坏 journal 应 fail closed、原字节应可恢复的要求。

**最小修复要求：**

- 在 `parseJournal()` 中增加状态机不变量：`committed !== true` 时 `files.length` 必须大于零。
- 增加回归：准备部分新真相、原备份和空未提交 journal，断言返回阻断警告、保留 journal/backups、不索引部分真相。

---

## 回归覆盖评估

### 覆盖较强的部分

- truth batch 使用真实文件系统，断言完整真相字符串、journal/backups 清理、新文件回滚、注册表回滚、junction 拒绝、损坏 marker 和备份缺失：`memory-truth-batch.test.ts:39-352`。
- R8 隐私测试使用真实 Audit、Gate、Logger、ErrorStore、ChatSessionStore，并检查 DB/WAL/SHM/journal 字节：`memory-r8-regression.test.ts:67-109`。
- 隐私 sink 失败、重启恢复、聊天行已删除、同进程重试均有真实状态断言：`memory-r8-regression.test.ts:113-210`。
- identity/projectId/corrupt 预检失败断言真相字节、审计、日志、聊天状态均未改变：`memory-r8-regression.test.ts:289-323`。
- R7 回归仍真实断言 FTS、scope hash、DB/WAL、真相文件、审批状态和事件：`memory-round7-regression.test.ts:77-192`、`memory-round7-regression.test.ts:500-701`。
- 未发现 R7 已列围栏或断言被简单删除；未注册项目发现、冲突索引驱逐、修复前身份检查、隐私恢复等路径仍保留。

### 覆盖缺口

- 没有覆盖空未提交 journal，正对应 F-2。
- consolidation 只测试“调用前已有 marker”：`memory-consolidation.test.ts:54-64`，没有覆盖模型等待期间的围栏竞争，正对应 F-1。
- 隐私预检失败用例没有同时快照 memory DB/WAL 和索引事件。
- journal 删除/回滚失败的实际文件系统故障注入仍不充分；现有案例主要覆盖 journal 验证失败和 marker 持久化失败。

---

## 未验证限制

- 遵守只读要求，未运行 Vitest、typecheck 或其他会创建临时文件/缓存的命令；本报告是静态调用链与断言审查，不声称测试实际通过。
- 未验证断电级持久性。当前备份、journal 和 rename 路径没有显式 `fsync`，进程崩溃与操作系统掉电的保证不同。
- 未执行 Windows junction、并发文件系统替换或 TOCTOU 攻击测试。
- `MemoryStore.db` 是可变对象，且部分公开 mutator 未自行检查围栏；当前生产调用大多有同步前置保护，但防御性封装仍不足。此点除 F-1 涉及的生产路径外，不单独构成阻塞。

---

## 结论

**CHANGES_REQUIRED**

**Blocking finding count: 2**

必须修复 F-1 的 consolidation 异步围栏缺口和 F-2 的空未提交 journal fail-open 路径，并补充对应回归后，方可批准。
