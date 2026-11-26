# R8-REVIEW-TRUTH-RECOVERY 独立只读审查报告

- 审查日期：2026-11-25
- 仓库：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi`
- 冻结清单：`docs/memory-evidence/repair-2026-11-25-round8/source-sha256.txt`
- 清单 SHA-256：`4f95259778b780c3893d50a1efc54105f04879b1da3b0802afcae1014f6d9ddc`
- 清单核对：66/66 文件 `OK`
- 审查方式：独立静态读取生产调用链和回归断言；未依赖 `R8-MAPPING.md` 或先前审查摘要；未修改任何文件，未运行测试或构建。

## 结论

CHANGES_REQUIRED

Blocking finding count: 3

## R8-B1：回滚按写入正序恢复，部分回滚后可能使 journal 永久失效

位置：`apps/desktop/electron/main/memory/truth-batch.ts:270-284`、`:457-460`、`:488-501`；校验见 `:241-253`。

批次按 registry-first 顺序写入项目注册表，再写项目 `memory.json`。回滚却按正序恢复：若 registry 已恢复、项目文件尚未恢复时中断，下次恢复时旧 registry 不再授权新项目，`projectFiles` 也可能为空，`validateJournal()` 会在恢复前拒绝项目 target，导致 journal/backups 被隔离并持久阻断。现有测试只覆盖一次完整恢复，未覆盖第一项恢复后中断。

最小修复：未提交 journal 的回滚及 missing-backup best-effort 分支按 `journal.files` 逆序执行；写入仍保持 registry-first。增加“第一项回滚后中断、以空 projectFiles 重启”的回归，断言 registry、项目文件、journal 和 backups 最终一致。

## R8-B2：回滚成功后先删 backups、后删 journal，会把已恢复真相误判为备份缺失

位置：`apps/desktop/electron/main/memory/truth-batch.ts:328-337`、`:413-438`、`:498-501`。

全部目标恢复后，`cleanup()` 先删除 `.truth-backups`，再删除 journal。若在两者之间崩溃或 journal 删除失败，重启后看到未提交 journal 但备份缺失，`recoverTruthBatch()` 会把已经正确恢复的目标 quarantine 为 `truth-recovery-*` 并建立持久 write-block。清理顺序破坏了“未提交 journal 存在时恢复证据必须可用”的不变量。

最小修复：区分 committed cleanup 与 rollback cleanup；回滚清理先可靠删除 journal，确认不存在后才删除 backups；journal 删除失败必须保留 backups；orphan backups 清理失败应可重试，不得反推目标 truth 已损坏。增加备份删除后崩溃、journal 删除失败两个故障注入回归。

## R8-B3：truth write-block 会在加载隐私 pending journal 前中止服务构造

位置：`apps/desktop/electron/main/memory/service.ts:112-121`、`:144-155`、`:837-871`、`:941-980`。

隐私删除已持久化 pending journal 后，若 sink/truth/Pi/chat 清理未完成，随后 truth 回滚失败并建立 `.truth-write-block.json`，重启时 `recoverTruthBatch()` 返回 write-block warnings，`assertTruthAvailable()` 立即抛错；此时 `loadPendingPrivacyJournals()` 和 `registerPendingPrivacySinks()` 尚未执行，Logger、Audit、ErrorStore、ApprovalGate 的持久脱敏登记没有恢复，Pi/chat 明文也得不到继续清理。

最小修复：确认 memory root 安全后，先加载并验证 pending privacy journal、注册可持续 sink 脱敏，再执行 truth availability 判定；将 Pi/chat carrier 清理与 truth 写入分离，truth 阻断期间不写 truth，但完成可独立完成的持久脱敏和文件删除；truth 修复后继续剩余删除。增加“安全根 + truth write-block + pending privacy journal”组合回归；不安全根仍须拒绝访问。

## 已确认符合要求

- 空未提交 journal 被明确拒绝；唯一备份保留、证据隔离并建立 write-block。
- identity/corrupt preflight 在替换前执行，回归使用真实 truth 字节快照覆盖重复 memory ID、重复 projectId 和无关 corrupt 文件。
- reconcile/list/search/rebuild 经过 synchronize/fence；round7 回归包含真实 SQLite/FTS 和搜索结果断言。
- consolidation 在 target、slot、模型调用前后、synchronize 前后、phase 开始及最终状态写入前重查 fence；直接 SQLite 查询通过 fenced store 方法。
- `containsAcrossRecords()` 与 Logger 输出验证可识别同时包含换行和非换行内容的跨记录重建；纯换行匹配被刻意排除。
- 指定回归断言真实 truth/journal/backup/SQLite/WAL/SHM/FTS/list/search/Logger/Audit/Error/Chat 副作用，而非仅 mock 调用或源码字符串。

## 非阻塞建议

1. `parseJournal()`/`validateJournal()` 未拒绝重复 canonical target 或 backup，建议增加唯一性校验。
2. `ensureProject()` 的 `upsertProjectRef()` 是 truth batch 之外的单文件幂等写入例外，建议明确崩溃语义。
3. `MemoryStore.db` 为 public，部分低层方法不自行 fence；当前未发现生产绕过，建议收敛 API 边界。
4. `databaseBytes()` 通过 UTF-8 转字符串搜索；若声称严格原始字节保证，建议使用 Buffer 级包含断言。

## 验证范围与限制

完整读取 truth-batch、service、store、consolidation、privacy-redactions、logger、extraction、settings、types、chat-session-store、error-store，以及指定四个回归和 memory-audit/fence/index-fallback/logger/chat 测试；外围 runtime/IPC/tools 只读取相关调用点。未逐行阅读全部 66 个文件，但 66 个文件均完成哈希核对。未实机执行杀进程、断电、文件删除失败或 Windows 故障注入。Windows TOCTOU、symlink EPERM、`.sparkii` 外递归硬链接别名、多进程并发无锁、atomicWrite 无 fsync/目录 fsync 保证等限制仍存在。
