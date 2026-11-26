# R8-REVIEW-PRIVACY-FENCE 独立架构审查报告

- 审查日期：2026-11-26
- 审查域：R8-REVIEW-PRIVACY-FENCE
- 仓库：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi`
- 审查对象：当前未提交工作树，不是 HEAD 快照
- 审查方式：独立只读静态读取实现、调用链和回归断言；未运行测试、类型检查、构建、Electron 或真实 Pi 子进程
- 写入范围：仅本报告；未修改源码、测试、配置或旧证据

## 结论

CHANGES_REQUIRED

Blocking finding count: 3

上轮四项隐私修复的主体已落地，但 Gate 的失败通知重试、MemoryStore 的动态对象键脱敏、Pi carrier 的 reparse 围栏仍未满足验收要求。

## 阻塞发现

### B1 — Gate listener 失败后，重试可在未成功通知的情况下解除封锁

**严重度：High / Blocking**

**位置**

- `packages/approval/src/gate.ts:184-214`，关键为 `:194-209`
- `apps/desktop/electron/main/memory/service.ts:1138-1154`、`:1171`
- `apps/desktop/electron/main/workflow.ts:40-55`

**触发**

1. Gate 中存在包含已删除秘密的 proposal。
2. 调用 `gate.redactTexts([secret])`。Audit 登记成功后，proposal 被替换为脱敏对象并加入 `invalidated`。
3. 任一 invalidation listener 抛错。Gate 捕获错误并设置 `privacyBlocked`；MemoryService 因此保留 journal 并返回清理失败。
4. 使用同一非空语料重试。此时 proposal 已是脱敏对象，`audit.redactValue(proposal).redacted` 为 false，`invalidated` 为空。
5. 没有任何 listener 被重新调用，但 `gate.ts:209` 仍执行 `this.privacyBlocked = undefined`。MemoryService 随后可完成删除并在 `service.ts:1171` 清除 journal。

**影响**

这直接违反“listeners 成功后解除封锁”。失败通知没有待重放状态，重试把“没有新变化”误当成“所有 listener 已成功”。生产 workflow listener 负责 settle resolver；一旦失败，重试不会补偿，审批等待可能只能依赖超时，其他 listener 副作用也会永久丢失，而隐私删除却可能被报告为完成。

**最小修复要求**

- 在 Gate 内保留尚未成功完成的 invalidation 通知队列或等价的逐 proposal/listener 状态。
- 每次非空 `redactTexts` 重试先重放待通知，再允许解除 `privacyBlocked`；队列非空或任一 listener 失败时保持封锁。
- 空语料和 `updateApprovedPayload` 继续只做 fail-closed 检查，不得间接清队列或解除封锁。
- 增加“listener 首次抛错、第二次成功”的 Gate 回归，以及 MemoryService 在该场景下 journal 必须保留到 listener 成功的集成回归。

**测试缺口**

`packages/approval/test/gate.test.ts:327-354` 覆盖了 Audit 清理失败后的空 redact、空白 redact 和 `updateApprovedPayload` 封锁，但没有 listener 抛错后重试的用例。现有 17 项通过证据不能证明该项验收。

### B2 — Memory 隐私语料与 truth 递归脱敏忽略对象键，秘密可持久保留

**严重度：High / Blocking**

**位置**

- `apps/desktop/electron/main/memory/service.ts:78-93`、`:1103-1112`
- `apps/desktop/electron/main/memory/store.ts:1337-1349`、`:1355-1375`
- `apps/desktop/electron/main/memory/types.ts:13-20`

**触发**

- `pendingContentTexts()` 只递归 `Object.values()`；`pendingOperationTexts()` 虽遍历 `Object.entries()`，但不把 key 加入语料。
- `PendingOperation` 明确允许 `[key: string]: unknown`，动态键是合法持久数据，不是仅针对畸形输入的假设。
- MemoryStore 的 `redactValue()` 和 `redactPendingOperation()` 原样保留每个 key，只脱敏 value。

因此，若秘密 S 是某个待删除 entry 的 `pendingOp` 动态键，S 不会被收集进 journal/registry；若 S 因其他字段已登记，survivor entry 的 `pendingOp` 动态键仍会保留 S。嵌套对象键同样不受处理。

**影响**

秘密可继续存在于 user/agent/project 的 truth JSON，并随 `list` 等返回 `pendingOp` 的路径暴露；若 S 从未因值字段登记，restart 后也没有持久 pattern 可清掉它。该问题绕过全局递归脱敏要求，且不仅影响当前删除，还影响后续使用相同动态键的写入。

**最小修复要求**

- 隐私语料收集必须覆盖非结构键的对象键；已验证的结构键仍按 `isPendingStructuralFieldValid` 处理。
- truth 递归脱敏必须同时处理动态 key，并检测脱敏后的 key 冲突；不得静默覆盖碰撞项。可复用 Audit 的 key-aware 递归策略或采用全对象输出验证后 fail closed。
- 增加 deleted entry 键、survivor entry 键、嵌套键、后续写入及 restart 回归，并检查原始 truth JSON 与 API 输出均不含秘密。

**测试缺口**

`apps/desktop/test/memory-r8-regression.test.ts` 没有 `pendingOp` 动态键用例；现有 raw DB/WAL/log 字节断言也不能覆盖 truth JSON 对象键。

### B3 — Pi carrier 直接 `rmSync`，未使用现有目录/文件 reparse 围栏

**严重度：High / Blocking**

**位置**

- `apps/desktop/electron/main/memory/service.ts:170-184`，关键为 `:180-183`
- 调用点：`apps/desktop/electron/main/memory/service.ts:173`、`:1092`、`:1164`
- 原始路径装配：`apps/desktop/electron/main/runtime.ts:223`
- 已有但未用于 carrier 的围栏：`apps/desktop/electron/main/memory/truth-path.ts:44-68`、`:94-102`

**触发**

`sessionFileOf()` 返回的加密原始 Pi 路径不经过 `assertPrivacyPathSafe()`，直接被 `rmSync(file, { force: true })`。若该路径任一祖先目录在删除前已是 junction/非 symlink reparse point，Windows 路径解析会沿重解析点访问外部目录；这里不需要利用检查与使用之间的 TOCTOU，因为 carrier 删除根本没有执行检查。

**影响**

隐私删除可越过预期会话目录边界删除外部同名文件，之后仍继续删除 Chat 行并清除 journal。现有 Pi 原始路径修复只保证“读到未脱敏路径”，没有保证“安全地使用该路径”。文件 reparse 与身份替换同样缺少 carrier 侧断言和删除后确认。

**最小修复要求**

- 删除前对原始 Pi 路径执行现有绝对路径、逐段 symlink/reparse、普通文件及身份检查；缺失文件可幂等视为已清理。
- 在删除边界重新围栏并验证预期身份/不存在结果；失败必须保留 journal，不得清 pending 状态。
- 覆盖正常删除、同进程重试和 restart 恢复；至少增加祖先 junction/非 symlink reparse 与文件 reparse 用例，断言外部目标字节不变且 journal 保留。

**测试缺口**

`apps/desktop/test/memory-r8-regression.test.ts:697-758` 只覆盖普通 Pi 路径、secret 命中文件名、restart 和 truth-block 后重试，没有 Pi carrier reparse/身份替换回归。

## 上轮四项与相关围栏复核

| 要求 | 当前结论 | 证据 |
| --- | --- | --- |
| Chat 脱敏不得先污染 Pi 原始路径 | 主体已修复；carrier 安全使用仍见 B3 | `runtime.ts:223` 使用 `rawPiSessionFile(id, true)`；`chat-session-store.ts:271-285` 解密原始路径并仅对非清理读取施加隐私阻断 |
| Audit/Gate 登记物理换行 fragment | 已修复 | `packages/approval/src/audit.ts:45-53` 生成 raw/JSON-escaped 及 CRLF/CR/LF fragment；`packages/approval/test/audit.test.ts:124-166`、`gate.test.ts:201-250` 覆盖历史、未来与 restart |
| 同进程 truth write-block 不阻断独立 Pi/Chat 清理 | 已修复 | `service.ts:1091-1092` 在 preflight 前清理独立 carrier；`memory-r8-regression.test.ts:731-758` 覆盖回滚失败后重试 |
| 启动提升有效 tmp 并续删；损坏/失败持久 block 且保留上下文 | 已修复 | `service.ts:979-1028` 校验命名、digest、普通文件/非 symlink/nlink=1 后 rename 并恢复上下文；异常保留文件并写 block；`:195-204` 自动续删 |
| journal 清零回读全零，失败持久 block | 已修复 | `service.ts:907-939` 写入零缓冲、回读逐字节检查、复核 dev/ino/size，再安全删除；失败设置 `privacyJournalFailure` 并持久化 write-block |
| store registry 失败不截断其他 sink | 已修复 | `service.ts:1129-1153` 各 sink 独立 try/catch；`memory-r8-regression.test.ts:570-590` 验证 Gate/Audit/Error/Logger 仍执行 |
| Gate 空 redact / updateApprovedPayload 不绕过封锁 | 已修复；listener 重试仍见 B1 | `gate.ts:90-99`、`:184-187` 均先 `assertPrivacyAvailable()`；CAS、approved、privacyRedacted、payload hash 和 pattern 检查保留 |
| journal 先于 truth recovery/index，读取 fail closed | 已修复 | `service.ts:119-141` 顺序为 root fence、write-block、journal、sink 登记、truth recovery、logger、truth availability、MemoryStore/index、续删；`:148-152` 与 `store.ts:407-422` 阻止 pending 期间普通读取 |
| 原始 DB/WAL/log 字节 | 相关实现与断言存在，但非本轮实机验证 | Audit `:374-378`、ErrorStore `:114-118`、ChatSessionStore `:316-320` 使用 secure_delete、WAL truncate、VACUUM；Logger `:126-143` 做输出复查；测试包含 DB/WAL/log 字节断言 |
| 全局递归脱敏 | 不满足，见 B2 | Audit `:201-235` 包含 key；Logger `:31-41` 对动态 key 做输出验证；MemoryStore `:1337-1349` 保留 key |
| `.sparkii` fence 不回归 | 未发现回归 | `truth-batch.ts:124-170` 仅允许显式 project file 或 registry 授权的 `.sparkii/memory.json`；`:228`、`:255`、`:272` 等继续执行 reparse/hardlink 围栏 |

## 非阻塞建议

1. `service.ts:1039-1044` 的未变化 journal 重试以 `pathAlreadyFenced=true` 跳过目录重围栏。最终 `clearPendingPrivacy()` 在 `:1073-1078` 仍会重新围栏后才清零/删除，因此本次未证明存在可成功清除 journal 的绕过；仍建议在重试入口重新围栏，并把最终围栏异常统一纳入持久 write-block 路径。
2. store registry 失败回归没有显式 spy/断言 Chat 登记。实现中 Chat 登记位于独立 try/catch，代码层面未被截断，但测试应补断言，避免后续顺序回归。

## Round5 测试真实性评估

- 有效覆盖：tmp 清零与删除失败（`memory-r8-regression.test.ts:218-245`）、非零回读注入（`:462-499`）、有效 tmp 重启提升并续删（`:527-544`）、损坏 tmp 保留与 block（`:505-525`）、journal 目录/文件 reparse（`:546-568`）、独立 sink 清理（`:570-590`）、Pi 原始路径/restart/同进程 carrier（`:697-758`）。
- 部分覆盖：损坏 tmp 与 reparse 用例直接调用私有 `loadPendingPrivacyJournals()`，不是全新构造；它们能验证加载器，但不能单独证明完整启动顺序。有效 tmp 用例使用 `makeService()`，覆盖了完整重启。
- 未覆盖：B1 的 listener 失败重试、B2 的 MemoryStore/pendingOp 动态键、B3 的 Pi carrier reparse/身份替换。
- 历史 after 证据显示相关 focused 用例通过，但本审查未重跑；且当前冻结清单已过期，不能把历史通过结果无条件绑定到当前工作树。

## 冻结清单与范围限制

- 冻结清单：`docs/memory-evidence/repair-2026-11-25-round8/source-sha256.txt`
- 清单 SHA-256：`57ab2583264705467b2d8f1389ea2a14e4f7cddb916de3586dda031301108704`
- 当前逐项核对：**54/70 匹配，16/70 不匹配，0 缺失**。不匹配项包括 `ipc.ts`、`memory/service.ts`、`memory/settings.ts`、`memory/store.ts`、`memory/truth-batch.ts`、`runtime.ts`、`security/task-lifecycle.ts`、`workflow.ts`、对应 memory/ipc/task/workflow 测试，以及 `packages/approval/src/gate.ts`、`packages/approval/test/gate.test.ts`。
- 因此本报告以读取时的当前文件为准，不声称冻结清单证明当前实现一致，也不声称历史 after 证据覆盖当前全部变更。

本轮审查重点文件的读取时 SHA-256：

- `apps/desktop/electron/main/memory/service.ts`：`e8555de18d82e8ce47f6f739729aaeefee38b4c2400c109b01e293ecb7ebbec9`
- `apps/desktop/electron/main/memory/store.ts`：`52a3be017b093d6f9b2fe5a40fb739d4279d69dde7640add8a5e82bd6b47d58d`
- `apps/desktop/electron/main/runtime.ts`：`a1ea5b4e31e6a8527dcabc3f239f6fa81c1294eb57b86b7d39af1588a897f242`
- `packages/approval/src/gate.ts`：`f1052fc24cd15faa4b8aff61bfaa8ef0ddcd50a50546a8ae58e17d85c79c7f2a`
- `apps/desktop/test/memory-r8-regression.test.ts`：`4f75d185254b60569357e7a170fc72e2e97d8fe9849a684889c7e9e7cdb46264`
- `packages/approval/test/gate.test.ts`：`df507ba355befc46adbc671ad79992faf592e6e52b69d7b955827138925e1ac4`

保留的已知限制，不作为本轮新增阻断：

- Windows 路径检查与使用之间仍存在 TOCTOU。
- symlink 在部分 Windows 场景可能返回 EPERM；fail-closed 不等于该限制已消除。
- `.sparkii` 外部递归硬链接别名风险仍存在。
- 没有跨进程 `dataDir` 锁。
- 没有断电级 fsync/目录 fsync 保证。
- Pi 相邻密钥未使用 DPAPI 保护。

此外未实机验证 Windows junction、杀进程/掉电、SQLite 原始盘字节、真实 Pi 子进程退出或并发攻击；静态调用链和测试断言审查不等同于运行时故障注入。
