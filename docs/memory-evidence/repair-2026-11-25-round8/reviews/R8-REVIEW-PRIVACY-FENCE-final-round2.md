# R8-REVIEW-PRIVACY-FENCE 独立只读审查报告

- 审查日期：2026-11-25
- 仓库：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi`
- 冻结清单：`docs/memory-evidence/repair-2026-11-25-round8/source-sha256.txt`
- 清单 SHA-256：`4f95259778b780c3893d50a1efc54105f04879b1da3b0802afcae1014f6d9ddc`
- 清单核对：66/66 文件 `OK`
- HEAD：`101487d3f612764766cc024d4b28dbf846a926cf`
- 审查方式：独立静态读取生产调用链和回归断言；未依赖 `R8-MAPPING.md` 或先前摘要；未修改文件，未运行测试、类型检查或构建。

## 结论

CHANGES_REQUIRED

Blocking finding count: 5

## B1：新进程中的登记文件缺失或 dangling symlink 不会 fail closed

位置：`apps/desktop/electron/main/privacy-redactions.ts:35-39`；消费者见 `logger.ts:17-19`、`error-store.ts:27-31`、`chat-session-store.ts:51-54`。

已完成隐私删除并生成登记文件后，该文件被删除，或在重启前变成 dangling symlink。新进程构造时 `signature === ''`，`existsSync()` 对缺失文件和 dangling symlink 都返回 false，于是成功返回；随后 Logger、ErrorStore、ChatSessionStore 以空模式集合接受未来写入，重新把已删除秘密写入 log、DB/WAL 或会话记录。当前只对同进程曾加载过的文件缺失 fail closed。

最小修复：增加独立于登记内容的“登记系统曾初始化”持久标记/tombstone；首次登记非空秘密时写入；启动时标记存在而登记文件缺失则拒绝构造或阻断写入。路径检查改用 `lstatSync()`，只对真实 ENOENT 且确认从未初始化时放行；symlink 包括 dangling symlink 一律 fail closed。保留真正首次安装的合法空状态。

## B2：ApprovalGate 的所有未来 ingress 都没有持久秘密过滤

位置：`packages/approval/src/gate.ts:41-48`、`:51-59`、`:68-78`、`:148-204`；生产可达路径见 `workflow.ts:56-60`、`ipc.ts:2545`、`:2609-2640`。

调用 `gate.redactTexts([secret])` 后，新 `submit()` 仍可把 secret 放入 summary、preview、payload 并返回明文；`decide()` 的 note 可写入 `decisionNote`；`updateApprovedPayload()` 可把含 secret 的 payload 放回未标记 `privacyRedacted` 的提案并执行。重启只清空内存 proposals，不恢复模式。AuditStore 的自脱敏不能保护 Gate Map、renderer 事件或执行 payload。

最小修复：Gate 使用持久非明文模式，或共享 AuditStore 已持久化模式；对 submit、decide(note)、updateApprovedPayload 的所有字符串 ingress 统一脱敏或拒绝；重启恢复模式。补充同进程和重启后的未来提交、note、payload 回归。

## B3：ChatSessionStore 登记当前删除语料过晚，journal 未完成期间存在无保护窗口

位置：`apps/desktop/electron/main/memory/service.ts:144-155`、`:941-980`；`chat-session-store.ts:220-242`；`runtime.ts:216-227`。

journal 持久化后，若 truth commit 或 Pi 文件删除失败，流程会在 `deleteChatSession()` 前退出；journal 持久化失败分支的 `registerPendingPrivacySinks()` 也包含 Gate、Audit、ErrorStore、Logger，但不包含 ChatSessionStore。此时并发 create/update/relocation 可把 secret 重新写入 sessions.db。重启加载 pending journal 同样没有 ChatSessionStore 的“仅登记”入口。R7 要求 chat cleanup 未成功前保留其他会话行，因此不能提前调用 `privacyDelete()`。

最小修复：为 ChatSessionStore 增加独立“仅登记 texts、不删除行”入口，在 journal 持久化成功后任何 sink/truth 清理前、journal 持久化失败分支、启动加载 pending journal 时立即调用；最终 `privacyDelete()` 仍负责删行、checkpoint、VACUUM 和最终 checkpoint。补充 truth/Pi 清理失败及重启后的未来写入测试。

## B4：Audit、Gate、MemoryStore 的固定 `[已删除]` marker 会保留或重建已删除秘密

位置：`packages/approval/src/audit.ts:86-113`、`:193-215`；`packages/approval/src/gate.ts:151-158`、`:191-195`；`apps/desktop/electron/main/memory/store.ts:1134-1140`、`:1160-1186`。

秘密为 `已删除` 时替换结果 `[已删除]` 仍包含原秘密；秘密为 `[已删除]` 时替换前后相同。Audit 旧行不更新且未来 append 继续保存；MemoryStore survivor/episode/pendingOp 与 truth 仍含秘密；Gate 不改变序列化结果，因此不设置 `privacyRedacted`，提案仍可决定或执行。Logger 已有动态 collision-safe marker，其他三者没有。

最小修复：统一使用能避开全部已登记字符的 collision-safe marker，例如 `PrivacyRedactions.marker()`；输出后验证不含任何登记模式。Gate 失效判断基于是否命中模式，不能只比较 JSON。为 Audit、Gate、MemoryStore 增加 `已删除`、`[已删除]` 和 marker 边界组合测试。

## B5：privacy journal 的 dangling symlink 会被当作“不存在”而放行

位置：`apps/desktop/electron/main/memory/service.ts:837-846`、`:896-903`。

已有 pending journal 后，`privacy-pending` 目录在重启前变成 dangling symlink。`existsSync(dir)` 返回 false，加载函数直接返回，pending texts 未恢复且未设置 `privacyJournalFailure`，读取围栏消失。journal 文件在清理阶段变成 dangling symlink 时，`clearPendingPrivacy()` 也会跳过并释放内存围栏。

最小修复：移除 `existsSync()` 预判，直接 `lstatSync()` 并只对真实 ENOENT 返回；所有 symlink 包括 dangling symlink 均设置 `privacyJournalFailure`。清理阶段重新验证 journal 身份，不能在验证后直接释放 maps。补充 dangling directory/file symlink 回归。

## 已核对符合要求

- privacy journal 在 preflight 成功后、任何 sink/truth 变更前持久化；sink 逐个尝试，任一失败保留 journal 和语料；truth 清理后删 Pi 文件，最后清 chat；仅 chat 成功后清 journal。
- journal 无法持久化时有内存围栏和持久 `.privacy-write-block.json`，restart 后仍阻断。
- chat row 或 Pi 文件已消失时可凭 journal 恢复。
- 登记文件存在且完整时，Audit、ErrorStore、Logger、ChatSessionStore 的旧行、同进程未来写入、restart 写入均有实现和真实 DB/WAL/log 字节回归。
- `setChatTitle` 复用 `ensureOpenSession()`，经过 stopping、epoch、lease、binding 检查；stale acquisition 回归断言 client.send 未调用、旧 lease 释放、替代 binding 未释放。
- privacy delete 停止 active task、parser、extraction timer 和 Pi binding；extraction/consolidation 在关键异步边界重查 fence。
- `.sparkii` direct path、junction/canonical escape、nested reserved delete/rename/move 均有围栏和回归。

## pending journal 期间其他 carrier 的可见性

当前 pending journal 阻断 memory list/search/synchronize/repair 和后续模型 prompt，但不全局阻断 Gate/Audit/Error/Logger/Chat 旧行读取。这符合 R7 `memory-round7-regression.test.ts:311-363` 的重试语义，尤其第 348 行要求 chat cleanup 未完成时其他会话保留 otherSecret。B3 应通过“提前登记未来写入模式、延迟删行”修复，而不是提前删除所有 carrier 或全局阻断读取。

## 非阻塞建议

1. `setChatTitle` 在 runtime 守卫前已发送 renderer title 事件并更新 pool meta，建议后移或失败回滚。
2. `.privacy-write-block.json` 没有人工恢复入口，建议提供显式审计化恢复流程。
3. `privacyDelete()` 的 redacted-ID 碰撞 Map 会丢弃行；`list(profileId)` 参数未脱敏可能漏行。
4. Audit 未登记物理换行 fragment，建议补齐。
5. journal 未检查 nlink，清零后删除可能影响硬链接别名，建议纳入单链接校验。

## 验证范围与限制

未运行测试或构建；真实副作用断言为代码审阅结论。Windows TOCTOU、symlink EPERM、`.sparkii` 外递归硬链接别名仍存在。Pi pool/supervisor 测试主要使用 FakeHandle/ManualHandle，不代表真实 Windows 子进程。未实机验证 Electron utilityProcess 普通退出；原子 rename 未验证掉电级 fsync。结论覆盖进程崩溃恢复，不宣称 sudden power loss。
