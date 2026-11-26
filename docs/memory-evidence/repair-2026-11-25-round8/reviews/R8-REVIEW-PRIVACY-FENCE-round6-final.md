# R8-REVIEW-PRIVACY-FENCE 独立架构终审报告

- 审查日期：2026-11-26
- 审查域：R8-REVIEW-PRIVACY-FENCE
- 仓库：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi`
- 基线 HEAD：`101487d3f612764766cc024d4b28dbf846a926cf`
- 审查对象：当前未提交工作树，不是 HEAD 快照
- 审查方式：独立只读静态阅读生产实现、调用链、回归断言和指定历史证据；未运行测试、类型检查、构建、Electron 或真实 Pi 子进程
- 写入范围：仅本报告；未修改生产代码、测试、配置或旧证据，未执行 Git 写操作，未触碰真实用户目录或数据库

## 结论

CHANGES_REQUIRED

Blocking finding count: 2

Round6 的 journal/temp、Pi carrier、Gate listener 和动态键主体修复已经落地，但仍有两条可复现的明文持久化/再暴露路径：结构字段豁免被递归应用到扩展对象；生产记忆提炼的 episode 写入绕过持久隐私脱敏。因此不能给出 APPROVE。

## 阻塞发现

### B1 — 结构字段豁免递归下探，合法外观的嵌套值可保留已删除明文

**严重度：High / Blocking**

**位置**

- `apps/desktop/electron/main/memory/types.ts:23-34`：`targetId`、`projectId`、`mergeIds` 只做非空字符串/数组检查。
- `apps/desktop/electron/main/memory/store.ts:1175-1186`：`redactPendingValue()` 对每一层对象都使用 `isPendingStructuralFieldValid()`；命中时同时保留 key 和整个 value。
- `apps/desktop/electron/main/memory/store.ts:1191-1201`：`redactEntryForPrivacy()` 直接信任上述结果，没有最终明文输出复核。
- `apps/desktop/electron/main/memory/service.ts:92-98`：语料收集对顶层结构字段做豁免；任意非空字符串即可被视为合法 `targetId`/`projectId`。
- `apps/desktop/electron/main/memory/service.ts:620-665`、`apps/desktop/electron/main/ipc.ts:798-808`：`addMemory` 不校验 `pendingOp` 扩展结构，IPC 还展开传入对象，因此该形状可由生产入口进入真相源。

**触发路径**

1. 用户删除的记忆正文包含秘密 S，使 S 进入持久脱敏登记。
2. 另一条 survivor pending memory 的 `pendingOp` 含有 `{ op: 'ADD', extension: { targetId: S } }`，或任意嵌套扩展对象中的合法外观 `projectId`/`mergeIds`。
3. `redactPendingValue()` 递归到 `extension` 后仍开启 `preserveStructuralFields`；嵌套 `targetId` 只因为是非空字符串就被判定为结构字段，S 被原样保留。
4. 隐私删除成功、journal 清除；S 仍存在于 user/agent/project truth JSON，并通过 `list()` 的 `pendingOp` 返回。重启后注册表仍在，但同一豁免仍会保留 S。
5. 若 S 只出现在被删除 entry 的顶层合法外观 `targetId`/`projectId` 中，它甚至不会进入删除语料；随后其他 entry 或未来写入使用同一字段时也没有 pattern 可清除。

现有 R7 非法结构字段用例只覆盖对象/数组等明显非法值（`memory-round7-regression.test.ts:292-320`），没有覆盖“嵌套位置 + 非空字符串”的组合；Round6 动态键用例的结构字段均为顶层控制值（`:827-870`），不能证明该路径安全。

**影响**

这是 final-round5 B2 的剩余旁路：秘密可绕过全局递归脱敏，在隐私删除报告成功后继续存在于真相源和 API 输出，并跨重启保留。它不是 Windows TOCTOU 或外部硬链接限制，而是确定性的代码路径。

**建议**

- 结构豁免应限于 pendingOp 的真实顶层控制字段，并结合操作类型、ID 格式和引用存在性验证；扩展对象中的 `targetId`/`projectId`/`mergeIds` 名称不自动获得结构身份。
- 对确实需要保留的顶层 ID，如果值命中已登记隐私 pattern，应 fail closed（保留 journal/read fence），不能静默保留明文或破坏引用。
- 对最终序列化输出执行登记模式复核；任何残留秘密都在 truth commit 前失败。
- 增加 deleted-only 结构值、survivor 顶层/嵌套合法外观结构值、未来写入及 restart 回归，断言原始 truth JSON、API、索引和 journal 语料均符合预期。

### B2 — 生产 episode 提炼写入绕过隐私脱敏，可在删除后重新持久化秘密

**严重度：High / Blocking**

**位置**

- `apps/desktop/electron/main/memory/service.ts:762-768`：`addMemoriesBatch()` 将 `commit.episode` 原样追加到 `episodes.jsonl`，没有应用 `PrivacyRedactions`。
- `apps/desktop/electron/main/memory/service.ts:787-790`：同一未脱敏 `commit.episode` 被直接写入 SQLite episode 索引。
- `apps/desktop/electron/main/memory/extraction.ts:164-184`：生产 `ExtractionScheduler` 将模型输出的 `sessionSummary`、`topics` 放入该 commit。
- `apps/desktop/electron/main/memory/store.ts:1004-1012`：`indexEpisode()` 原样索引 summary/topics。
- `apps/desktop/electron/main/memory/store.ts:1034-1043`、`:1065-1075`：`appendEpisode()` 和 `updateEpisodeSummary()` 也没有脱敏未来写入。
- `apps/desktop/electron/main/memory/store.ts:944-980`、`:1059-1062`：episode 可通过搜索和 `listEpisodes()` 重新返回。

**触发路径**

1. 对会话 A 执行隐私删除，秘密 S 已写入 MemoryStore 的持久脱敏登记，journal 已正常清除。
2. 另一会话 B 的提炼模型输出 `sessionSummary: S` 或 `topics: [S]`。模型可能从跨会话材料、旧上下文或普通重复内容中再次生成 S；代码没有假设它不会发生。
3. `ExtractionScheduler.flush()` 调用 `addMemoriesBatch()`。Memory entry 本身经过 `redactEntryForPrivacy()`，但 episode 分支直接拼接原始 JSON。
4. S 被写入 `episodes.jsonl`、`episodes` 表和 FTS；`searchMemory(S)`、`store.listEpisodes()` 及原始 DB 字节可重新暴露 S。重启后仍从真相源重建相同明文。
5. 直接调用 `appendEpisode()` 或 `updateEpisodeSummary()` 也构成相同的未来写入旁路。

R7 回归覆盖了删除时已有 episode 的全局清理和 superseded 旧记录（`memory-round7-regression.test.ts:414-451`），但没有覆盖隐私删除完成后的新 episode ingress；现有 future-write 断言主要针对 memory entry、Chat、Logger、Audit 和 ErrorStore。

**影响**

这违反“当前与未来写入均不得重新引入 plaintext”的隐私围栏。删除可以成功完成，但后续正常提炼即可把同一秘密重新持久化并通过搜索/API 暴露；持久 journal 已不存在，启动时不会自动补救。该问题不依赖文件系统攻击或 TOCTOU。

**建议**

- 在 episode 写入真相源之前，对 summary、topics 及其他自由文本字段应用同一 `PrivacyRedactions`，并生成一个脱敏后的 canonical `EpisodeRecord`。
- truth JSONL、`indexEpisode()` 和 FTS 必须使用同一个已脱敏对象；禁止原始对象和脱敏对象混用。
- `appendEpisode()`、`updateEpisodeSummary()` 和 `addMemoriesBatch()` 统一走该写入边界，并在序列化/索引前验证输出不含登记 pattern。
- 增加“先删除 S，再提炼含 S 的 episode”的生产 `ExtractionScheduler`/`addMemoriesBatch` 回归，覆盖同进程、restart、原始 JSONL、原始 DB/WAL、FTS、搜索和 `listEpisodes()`。

## 旧 finding 核对

| 旧项 | 当前结论 | 证据 |
| --- | --- | --- |
| final-round5 B1：Gate listener 失败后重试可无通知解封 | 已关闭 | `gate.ts:195-267` 逐 proposal/listener 保存并重放未成功通知；错误或队列非空保持 `privacyBlocked`。`gate.test.ts:83-222` 与 `memory-round7-regression.test.ts:795-824` 覆盖首次失败、重试、新增 listener、持续失败和真实 MemoryService journal 生命周期。 |
| final-round5 B2：动态 pending-op 键未进入语料/递归脱敏 | 主体已修复，但未完全关闭 | 动态 key 已收集，survivor 动态 key 递归脱敏，碰撞 fail closed，doomed entry 先排除；但结构豁免递归下探见本报告 B1。 |
| final-round5 B3：Pi carrier 直接 rm，无 reparse/身份围栏 | 已关闭 | `service.ts:187-220` 要求绝对路径、新鲜祖先/文件 reparse 围栏、普通单链接文件、两次完整身份、删除后不存在，再清理 Chat。`memory-r8-regression.test.ts:857-949` 覆盖真实祖先 junction、非 symlink reparse、身份替换、重试和 restart。 |
| 用户所指 final-round5 B5 | 该文档没有 B5 编号 | final-round5 实际只有 B1/B2/B3。更早的 journal temp 明文残留项在 final-round3 标为 B4、在 R8 测试/round6 说明中称 B5；当前实现已关闭，见下表。 |
| 更早 journal temp 残留/损坏恢复 | 已关闭 | `service.ts:949-1013` 原长度清零、同句柄 fsync/回读、读后身份复核和 verified remove；`:1051-1100` 校验并提升有效 temp，损坏/未知文件持久 block。`memory-r8-regression.test.ts:501-580`、`:772-855` 覆盖残留、损坏、dangling/reparse 和清零前替换。 |

## 重点核对证据

### crash/failure/restart 与 journal

- 启动顺序为 root fence → privacy write-block → pending journal → sink 登记 → truth recovery → 必要时 carrier 恢复 → Logger 旧 prompt 清理 → truth availability → MemoryStore → 隐私续删（`service.ts:121-149`）。truth recovery 不能先于持久隐私 read fence 恢复明文。
- journal 在 preflight 成功后、任何 sink/truth 变更前持久化（`service.ts:1171-1199`）；持久化失败时已有内存 pending fence，并尝试持久 write-block。
- 每个 pending session 的 Gate/Audit/Error/Chat/Logger 登记独立尝试，异常由 journal 保持可重试（`:162-175`）。四 sink 失败不会截断其他清理。
- 只有 journal 清零/删除成功才移除内存 pending maps（`:1145-1158`）；truth write-block 与 privacy journal 是独立围栏，已有 journal 且 truth blocked 时仍先清理独立 Pi/Chat carrier（`:1162-1164`）。
- journal 身份使用 `dev:ino:size:mtimeNs`，要求普通文件、非 symlink、`nlink === 1`；清零使用原长度、`ftruncate`、写零、`fsync`、同句柄 `readSync` 全零检查、关闭后路径身份复核和 verified remove（`:897-1013`）。

### Pi/Chat 与运行时

- 生产 `runtime.ts:223` 在隐私清理时使用 `rawPiSessionFile(id, true)`，避免先用脱敏路径污染原始 carrier 路径。
- carrier 删除前捕获绝对原始路径并执行新鲜围栏；文件缺失可幂等处理，删除后必须确认 ENOENT，之后才删除 Chat 行（`service.ts:187-220`）。
- IPC 隐私删除使用 `withSessionDeletion()`，停止旧 runtime、保留失败 tombstone，并阻止删除期间重新打开同 ID（`ipc.ts:2732-2814`）；启动/open 路径使用非清理 `rawPiSessionFile()`，命中隐私 pattern 会拒绝恢复。
- Chat 当前行和未来 create/update 均经过 `safeRecord()`；原始 Pi 路径另存加密 BLOB，隐私清理时先登记再事务重建幸存行、checkpoint/VACUUM（`chat-session-store.ts:165-233`、`:288-321`）。

### Logger / Audit / Gate / ErrorStore

- Logger append、rewrite、export 使用动态键感知和输出复核；物理 CRLF/CR/LF、JSON escape、malformed history 和跨记录 fragment 均有实现与回归（`logger.ts:28-173`、`:183-207`）。
- Audit 注册表只持久 SHA-256/length/字符指纹，不持久明文；raw/JSON-escaped 与物理换行 fragment 对齐（`audit.ts:41-54`、`:119-179`）。历史行更新、未来 append、query/export 防御性脱敏及 WAL truncate/VACUUM 已存在（`:280-385`）。
- Gate submit/decide/updateApprovedPayload 使用 Audit 的 key-aware 脱敏、canonical CAS、payload hash 和 `privacyRedacted` 检查；listener 队列在重试前重放，新增 listener 收到最新 canonical，移除 listener 不再调用，持续失败保持封锁（`gate.ts:52-111`、`:195-273`）。
- ErrorStore 对未来 append 的所有自由文本字段脱敏，历史行事务重建并处理主键碰撞，随后 checkpoint/VACUUM（`error-store.ts:55-120`）。

### preflight / truth / R7

- `preflightDeleteBySession()` 在 journal、sink、carrier 或 truth 修改前完成损坏、身份冲突和全量发现；失败时 `privacyDeleteBySession()` 尚未设置 pending maps（`service.ts:1161-1191`）。R8 回归对 identity/project/corrupt 三种失败断言 truth、journal、Audit、Logger、Chat 均不变（`memory-r8-regression.test.ts:787-821`）。
- truth verified read/copy/rename/remove 使用新鲜 native probe、连续身份和删除后复核（`truth-path.ts:153-300`）。root 不安全时启动 fail closed，不再降级为 warning 后继续创建 MemoryStore。
- R7 的全局旧行/未来 carrier、superseded episode、pending extension、非法结构字段、caller-mode canonical approval、同进程重试、未注册项目发现和原始 DB/WAL 断言仍保留；未发现这些既有修复被 Round6 回退。新的 B2 说明 future episode ingress 仍是覆盖缺口。

## 测试证据评估

本轮按委托未启动任何测试。指定历史证据已阅读：

- `after/round6-truth-privacy.txt`：3 files / 127 passed，包含 memory R7/R8/truth-batch。
- `after/round6-privacy-fences-focused.txt`：16 passed / 111 skipped，聚焦 journal/Pi/dynamic key/listener。
- `after/round6-gate-listener.txt`：Gate + Audit 32 passed。

这些结果支持相应既有回归，但不能证明本报告两条新路径安全：现有断言没有覆盖嵌套合法外观结构字段，也没有覆盖隐私删除后的新 episode 写入。历史 after 文件没有绑定本轮读取的源码哈希，故不作为当前工作树的独立通过证明。FakeHandle、临时目录/数据库和故障注入也不等同于真实 Pi、Electron、Windows 文件系统或用户存储验证。

本轮读取时核心实现 SHA-256：

- `apps/desktop/electron/main/memory/service.ts`：`a16d8aacc944e72d50c8d4b2f93372f72ef411cc6593dfc386b6e84fcfde7dad`
- `apps/desktop/electron/main/memory/store.ts`：`078ae147c4d0612828c03c3d1f79fe66f16086f4c9a23df777f8b068e2c6a3ba`
- `apps/desktop/electron/main/memory/types.ts`：`d299931a4d03da1d3396ba9bf361c1afa4b78f37635870523b4f980d57135c3f`
- `apps/desktop/electron/main/memory/truth-path.ts`：`7c0b4cf7464ae7a232dbdc921622113cc4c134a20ba6dd3a572d99517310019b`
- `packages/approval/src/gate.ts`：`0c53f5e35a41850c8c61f66a6fbe478d8d5c535e71c6b8d42f5d8dc0a461ba6b`
- `packages/approval/src/audit.ts`：`02ee441e45639583d81af96a273f68e9e165e6994a9855cd74e2fda73b7c9783`

## 非阻塞保留项

- `logger.ts:137-143` 仍使用固定 `${path}.redact.tmp`，未像 journal temp 一样采用随机 `wx` 和完整路径身份围栏。旧 final-round3 已将其列为非阻塞建议；当前 rewrite 在写 temp 前验证脱敏输出，因此本报告不把它升级为本次明文再暴露阻断，但仍建议后续 hardened，尤其防范本地预置链接/硬链接造成的越界覆盖。
- Gate listener 契约仍为同步回调；异步 listener 的 Promise rejection 不在当前队列保证内。生产 workflow listener 是同步 `settle()`。
- 结构 ID、session ID、Pi 相邻密钥等结构性/加密边界不能笼统视为“所有字节都被内容脱敏”；本报告 B1 针对的是扩展对象错误继承结构豁免，而不是要求破坏合法引用。

## 范围与限制

- 本轮只做静态架构审查，没有动态复现、真实 Windows junction 攻击、杀进程/掉电、SQLite 原始盘取证或真实 Pi 子进程测试。
- 不声称消除 Windows 路径检查与使用之间的 TOCTOU；fresh probe、双 `lstat`、句柄身份和删除后复核只能缩小窗口。
- 不声称消除 symlink 在部分 Windows 场景返回 EPERM 的限制；相关路径仍 fail closed。
- 不声称解决 `.sparkii` 外递归硬链接别名、所有本地预置链接或跨进程 `dataDir` 并发写入。
- 没有跨进程 `dataDir` 锁，也没有新增 power-loss-grade 文件/目录 fsync 保证；journal 创建后、sink 修改前的掉电持久性仍是已披露边界。
- Pi 相邻密钥未使用 DPAPI；加密 BLOB 的存在不等于真实用户存储威胁模型已被完全解决。
- 仅当上述两条阻断发现关闭并补充有效回归后，才可重新作出 APPROVE 结论。
