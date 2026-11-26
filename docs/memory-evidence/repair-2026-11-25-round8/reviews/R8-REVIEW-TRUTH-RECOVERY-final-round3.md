# R8-REVIEW-TRUTH-RECOVERY 独立架构审查报告

- 审查日期：2026-11-25
- 审查角色：R8-REPAIR-MEMORY
- 审查域：R8-REVIEW-TRUTH-RECOVERY
- 仓库：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi`
- 冻结清单：`docs/memory-evidence/repair-2026-11-25-round8/source-sha256.txt`
- 清单 SHA-256：`5a8e91cbbeb23670de30edcfdfb22c36b8dc314112c80d3bb51916553c5cd313`
- 逐项核对：66/66 OK
- 审查方式：独立只读静态读取生产调用链和回归断言；未依赖交付方摘要；未修改文件，未运行测试或构建。

## 结论

CHANGES_REQUIRED

Blocking finding count: 5

## B1：commitTruthBatch 未拒绝规范化重复目标

位置：`apps/desktop/electron/main/memory/truth-batch.ts:467-520`、`service.ts:352-370`、`service.ts:621-695`。

`validateTarget()` 计算规范化路径，但 `commitTruthBatch()` 没有对 changes/pending 建立规范化唯一性集合。Service 保留原始 workspace path 作为 bucket key，Windows 大小写别名可形成两个 bucket，后写覆盖先写，而接口返回两个 bucket 的 ids，SQLite 最终只保留后者，造成静默数据丢失。现有测试只覆盖 journal 重复项，未覆盖提交前别名。最小修复：创建 backup/journal 前按 `pathKey(canonicalSafe(target))` 拒绝重复；Service bucket 也按规范化物理路径合并；增加大小写/等价路径回归。

## B2：journal projectFiles 自我扩展恢复授权

位置：`truth-batch.ts:203-215`、`:246-265`、`:417-428`、`:494-498`。

恢复直接采用 `journal.projectFiles ?? []` 并加入 `allowedProjectFiles()`，使 journal 声明成为自身授权依据。能放置 journal/backup 的本地攻击者可声明任意外部 `/.sparkii/memory.json`，启动恢复据 `existed` 覆盖或删除它。最小修复：恢复授权只来自可信 registry 或启动注入 workspace；必须支持 registry-first 中断时，仅允许可信绑定证据证明的新增项目，不能任意自授权；增加恶意 journal 回归。

## B3：reconcile/rebuild 使用不同文件快照写索引和哈希

位置：`store.ts:458-469`、`:562-592`、`:595-617`、`:704-710`。

`rebuild()` 先 `readAllTruth()` 解析，事务中再次 `hash(readFileSync(...))`；`reconcile()` 的 entries 与 `replaceScopeIndex()` 的哈希也来自两次读取。并发编辑且条目数不变时，旧 entries 可配新哈希，后续 reconcile 永久跳过，FTS 保留旧明文。最小修复：每个文件只读一次，解析、entries、哈希共用快照；提交前验证身份/哈希，变化则重读或 fail closed；增加双读间编辑回归。

## B4：privacy journal 临时文件崩溃后永久保留明文

位置：`service.ts:869-910`、`:913-937`。

完整 journal 先写 `<hash>.json.<uuid>.tmp` 再 rename。启动只枚举 `.json`，rename 前崩溃会留下含 texts/sessionId/memoryIds/workspacePaths 的永久明文文件，且不进入恢复。最小修复：启动识别安全临时命名，校验普通文件、非 symlink、nlink=1 后清零删除或纳入验证恢复；异常对象 fail closed；增加 rename 前中断回归。

## B5：SQLite 主库与 sidecar 缺少链接/硬链接围栏

位置：`settings.ts:47-49`、`store.ts:265-296`。

`openDatabase()` 在 `new Database(path)` 前未检查 memory.db、wal/shm/journal 的普通文件、nlink=1、symlink/reparse point；损坏隔离还会 rename/delete sidecar。本地攻击者可将索引链接到外部 SQLite 文件。最小修复：首次/fallback 打开及隔离清理前统一检查主库和所有 sidecar；增加链接、硬链接、junction 回归。

## 已确认符合要求

- 原始字节备份、registry-first 写入、逆序回滚。
- 恢复后先删 journal 再删 backup；journal 删除失败保留 backup。
- committed 后清理失败不回滚；orphan backup 可重试。
- 不可恢复时保留证据、quarantine 并持久/内存 write-block。
- 空 journal、非法 committed、重复 journal target/backup 拒绝。
- write-block 覆盖恢复及 list/search/row/preview/archive/repair/rebuild。
- 隐私 sink 围栏先于 truth recovery；truth block 启动失败前仍清理 Pi/chat。
- identity/corrupt preflight 在修改前执行。
- consolidation 不直接修改 active truth，异步边界重查 fence。
- 回归包含真实 truth/journal/backup/SQLite/WAL/SHM 副作用。

## 非阻塞建议

1. committed 后清理失败应返回结构化“已提交、清理待修复”语义，避免调用方误判。
2. 收敛绕过 truth batch 的 Store API；当前未发现生产调用。
3. 增加 truth atomicWrite 临时文件的启动清理策略。
4. 增加 committed journal 删除失败、多文件部分 backup 缺失、真实中断和 sidecar 攻击测试。

## 验证范围与限制

已核对冻结清单及 66 项源码哈希；完整静态读取 truth-batch、service、store、consolidation、extraction 和指定记忆回归。未运行构建、测试或运行时故障注入；未实机验证崩溃、断电、Windows junction/硬链接攻击或并发写入。Windows TOCTOU、symlink EPERM、`.sparkii` 外递归硬链接别名、多进程无锁、atomicWrite 无 fsync/目录 fsync 保证仍存在。
