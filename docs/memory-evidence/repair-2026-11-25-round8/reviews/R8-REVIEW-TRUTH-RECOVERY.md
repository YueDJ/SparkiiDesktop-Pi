CHANGES_REQUIRED
Blocking finding count: 1
域：R8-REVIEW-TRUTH-RECOVERY / R8-REPAIR-MEMORY

阻断：`C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\memory\truth-batch.ts:371-376` 对 junction/不安全 memory 根仅返回警告、不持久化 marker；`C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\memory\service.ts:117-132` 仅收集警告仍构造 store；`C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\electron\main\memory\store.ts:225-239` 在可用性检查（356-361）前创建目录并打开 DB。启动路径因此绕过恢复 fail-closed。

复现：把 `dataDir\memory` 建为指向外部目录的 junction，外部放损坏 journal，再执行 `new MemoryService({dataDir})`；外部目录会新增 `agents`、`episode-proposals`。现有 `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop\test\memory-truth-batch.test.ts:205-222` 仅调用 recover/commit，未覆盖 MemoryService 启动。

验证范围：独立阅读 truth-batch 全链、store/service 恢复与隐私清理链、三组回归及 R8 before/after。测试确实执行生产分支，并断言 truth 原字节、journal、list/search/rebuild 和 DB/WAL/shm/journal；证据显示 focused 30、R7+R8 35、两轮全套 445 passed/1 skipped、typecheck 通过，但未覆盖上述阻断。

未验证限制：本次只读，未重跑测试；Windows TOCTOU、symlink EPERM、`.sparkii` 外递归硬链接别名风险仍存在。
