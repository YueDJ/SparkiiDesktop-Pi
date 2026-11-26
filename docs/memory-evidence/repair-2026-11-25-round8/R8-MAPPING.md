# R8-REPAIR-MEMORY 映射

- Task-id：`R8-REPAIR-MEMORY`
- 日期：2026-11-25 起；最终 round7 修复与验证日期：2026-11-26
- 仓库：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi`
- 基线：HEAD `101487d3f612764766cc024d4b28dbf846a926cf`，branch `main`
- 基线跟踪补丁 SHA-256：`84a5929b97f68c00a1ed3f5aee842449626608f05f66b03d28bc88b77f8c50dc`
- 工作树原有 R6/R7 未提交改动继续保留；本映射描述 R8 增量，不把全部 dirty 文件称为 R8 新增。

## 门禁状态

最终 round7 指定全套两轮与三域独立终审尚未完成。在本文件底部最终验证全部改写为当前通过结果之前，**不得宣称 R8 验收通过**。

## R8-P0-1 隐私删除崩溃恢复与明文围栏

生产源码：

- `apps/desktop/electron/main/memory/service.ts:121`：先加载 privacy write-block/journal，再向 Gate/Audit/Error/Chat/Logger 注册脱敏语料，最后才执行 truth recovery、建 store 和自动续清。
- `apps/desktop/electron/main/memory/service.ts:137`、`:138`：建库前检查 truth 可用性；未完成 privacy cleanup 通过 `unavailable` 围栏阻断读取。
- `apps/desktop/electron/main/memory/service.ts:148`、`:231`：启动自动续删；失败保留 journal、读取围栏和 memoryId→session 完成映射。
- `apps/desktop/electron/main/memory/service.ts:949`：journal 清零前、清零后回读前、回读后都重新围栏；原长度写零、fsync、同句柄回读、身份与删除复核。
- `apps/desktop/electron/main/memory/service.ts:1161`：preflight 后才失效 extraction、写 journal 和执行全局清理；sink 单项失败不阻止其他 sink 清理。
- `apps/desktop/electron/main/memory/truth-batch.ts:293`、`apps/desktop/electron/main/memory/store.ts:406`：磁盘 write-block 与隐私未完成围栏统一生效。

回归：`apps/desktop/test/memory-r8-regression.test.ts:282` 起覆盖 Logger/Audit/Gate/Error 清理失败、truth 部分写入恢复、chat/Pi 已消失、重启失败重试、journal 已消失解除内存围栏，并检查 truth、journal、list/search、Logger 当前及未来日志、Audit/Gate/Error/Chat、原始 DB/WAL/shm/journal 字节。

Before：`before/focused-memory-truth-logger-audit-valid.txt`。

After：`after/architecture-fixes-focused.txt`、`after/focused-runtime-logger-audit.txt`、`after/round6-truth-privacy.txt`；最终结果见文末。

## R8-P0-2 隐私删除先停止活跃运行时

生产源码：

- `apps/desktop/electron/main/ipc.ts:812`：privacy IPC 解析来源会话，经共享 `withSessionDeletion` 等待 teardown，再删除记忆。
- `apps/desktop/electron/main/ipc.ts:2756`：共享 teardown 使 opening epoch 失效、取消 pool acquisition，并复用同一停止 Promise。
- `apps/desktop/electron/main/ipc.ts:2770`：结束 task、取消 release timer、失效 document parser、按捕获 lease 解绑释放、取消 extraction；每次 await 后重检原 binding/admission。
- `apps/desktop/electron/main/ipc.ts:1217`：listing/acquire 前后检查 epoch/stopping/tombstone；旧 acquisition 只释放自己的不可变 lease。
- `packages/agent-host/src/pi-runtime-pool.ts:20`、`:185`：slot 暴露不可变 acquisition lease；`cancelAcquire` 拒绝排队请求，冷启动在绑定前停止 supervisor。
- 同 ID 替换时旧 teardown 返回 false，不删除替代会话、不释放替代 binding、不向旧或替代 client 发送命令。

回归：`apps/desktop/test/ipc.test.ts:4936` 起的 6 个 R8-P0-2 用例；`packages/agent-host/test/pi-runtime-pool.test.ts` 的排队/冷启动取消用例。检查 task 终止原因、extraction、parser、release lease、teardown 顺序、打开前/打开中取消、同 client 同 ID 替代绑定与零客户端命令。

Before：`before/r8-p0-2-valid.txt`、`before/focused-ipc-workflow-valid.txt`。

After：`after/architecture-fixes-focused.txt`、`after/focused-runtime-logger-audit.txt`、`after/repeated-runtime-races.txt`；最终结果见文末。

## R8-P1-1 workflow 原始 binding lease 贯穿

生产源码：

- `apps/desktop/electron/main/ipc.ts:3550`：workflow onReady/admission guard 同时校验 pool client/lease、openSessions 原 entry/lease、inFlightWorkflowRuns lease。
- `apps/desktop/electron/main/workflow.ts:239`、`:253`、`:279`：model/thinking 的 await 前后校验。
- `apps/desktop/electron/main/workflow.ts:308`：sendPrompt 固定原 client/lease，并贯穿模型设置、prompt 与事件边界。
- `apps/desktop/electron/main/workflow.ts:388`：runTool 在设置、知识查询、文档、审批和 broker await 边界校验。
- `apps/desktop/electron/main/workflow.ts:506`、`:557`、`:784`：workflow 启动、onReady、loop、journal、最终 release 均绑定原 lease。
- `apps/desktop/electron/main/workflow.ts:32`：stale approval 只能 denied。

回归：`apps/desktop/test/workflow-broker.test.ts:850` 起检查实际命令列表、prompt 数、journal step、审批结果和替代 binding；`apps/desktop/test/ipc.test.ts` 覆盖 admission guard。

Before：`before/focused-ipc-workflow-valid.txt`。

After：`after/architecture-fixes-focused.txt`、`after/repeated-runtime-races.txt`、`after/round6-runtime-suite.txt`；最终结果见文末。

## R8-P1-2 物理换行秘密不破坏 JSONL

生产源码：

- `apps/desktop/electron/main/logger.ts:14`：按原始 `\r\n|\r|\n` 物理边界分行。
- `apps/desktop/electron/main/logger.ts:43`、`:68`、`:116`：畸形物理行安全判定、字符串 token 解码脱敏或安全占位；不重写记录分隔符。
- `apps/desktop/electron/main/logger.ts:145`、`:158`、`:201`：prompt 清理、session 清理、export 都先按原物理行处理。
- `apps/desktop/electron/main/logger.ts:126`、`:137`：输出验证与同步 rewrite 防止未 awaited append 回写明文。

回归：`apps/desktop/test/logger.test.ts:464` 起对 `\n` / `\r\n` / `\r` 和三个入口逐行 JSON.parse、schema、消息、ctx、字段名、记录数及秘密值断言。

Before：`before/focused-memory-truth-logger-audit-valid.txt`。最初无效 harness 输出保留在 `before/focused-memory-truth-logger-audit.txt`，不作为缺陷证据。

After：`after/architecture-fixes-focused.txt`、`after/focused-runtime-logger-audit.txt`；最终结果见文末。

## R8-P1-3 write-block 阻断读取侧

生产源码：

- `apps/desktop/electron/main/memory/truth-batch.ts:289`、`:293`：不安全根 fail closed；损坏/异常 marker 返回阻断。
- `apps/desktop/electron/main/memory/service.ts:124`、`:137`：构造期根路径与可用性检查，避免先建库再发现不安全。
- `apps/desktop/electron/main/memory/store.ts:406`：all scope、reconcile、episode/extraction、row/search、touch、view、redaction、rebuild 和隐私恢复读取统一检查。
- `apps/desktop/electron/main/memory/service.ts` 的 ensureProject/previewScope/archiveProject/readRef 直接真相读取也先检查。

回归：`apps/desktop/test/memory-r8-regression.test.ts:636` 拒绝通过不安全 junction 构造服务且外部目录零变化；`:682` 检查同进程与重启的 search/list/row/rebuild、直接项目读取、损坏 marker，以及移除 marker 后重新索引。

Before：`before/focused-memory-truth-logger-audit-valid.txt`。

After：`after/architecture-fixes-focused.txt`、`after/round6-truth-privacy.txt`；最终结果见文末。

## R8-P1-4 journal 校验失败不丢原真相

生产源码：

- `apps/desktop/electron/main/memory/truth-batch.ts:404`：journal 写入后校验失败时先删除未生效 journal；删除失败则不删 backups，保留全部证据并抛错。
- `apps/desktop/electron/main/memory/truth-batch.ts:433`：目标写入后的回滚仍保持原恢复语义；回滚失败写 block 并保留 journal/backups。

回归：`apps/desktop/test/memory-truth-batch.test.ts:98`、`:131` 两个 R8-P1-4 用例；第二个注入 journal 路径不可删除，断言原目标字节、备份字节和 held journal 均保留。

Before：`before/focused-memory-truth-logger-audit-valid.txt`。

After：`after/architecture-fixes-focused.txt`、`after/round6-truth-privacy.txt`；最终结果见文末。

## R8-P1-5 隐私删除先做身份/损坏预检

生产源码：

- `apps/desktop/electron/main/memory/store.ts:1325`：复用同一套 scope conflict/corrupt/identity 规则生成 preflight plan。
- `apps/desktop/electron/main/memory/store.ts:1352`：commit 复用 preflight 的 refs/episodes/states，不复制规则。
- `apps/desktop/electron/main/memory/service.ts:1171`：在 extraction 失效、journal 写入和任何全局清理前执行 preflight。

回归：`apps/desktop/test/memory-r8-regression.test.ts:788` 的 identity/projectId/corrupt 三个用例；逐字节比较 truth、Audit/Logger/Chat/journal，并确认失败后原文仍保留。

Before：`before/focused-memory-truth-logger-audit-valid.txt`。

After：`after/architecture-fixes-focused.txt`、`after/round6-truth-privacy.txt`；最终结果见文末。

## R8-P1-6 Audit 持久防止明文回写

生产源码：

- `packages/approval/src/audit.ts:41`、`:120`：只保存 SHA-256 + UTF-16 code-unit 长度等非明文登记；损坏/不安全登记文件 fail closed。
- `packages/approval/src/audit.ts:141`：登记持久化失败设置 blocked，防止后续读写绕过。
- `packages/approval/src/audit.ts:280`：append 在插入前脱敏所有自由文本列。
- `packages/approval/src/audit.ts:338`：历史行事务脱敏、checkpoint、VACUUM；query/filter 防御性脱敏。
- `apps/desktop/electron/main/memory/service.ts:127`、`:162`：删除开始和重启 journal 恢复时注册 Audit 及其他 sink。

回归：`apps/desktop/test/memory-r8-regression.test.ts:618` 与 `packages/approval/test/audit.test.ts:60`、`:124`；覆盖完成后立即 append、清理中并发 append、restart 后 append、历史行及原始 DB/WAL 字节。

Before：`before/focused-memory-truth-logger-audit-valid.txt`。

After：`after/architecture-fixes-focused.txt`、`after/focused-runtime-logger-audit.txt`、`after/round6-gate-listener.txt`；最终结果见文末。

## Round6 终审追加修复

详细报告：`reviews/R8-FIX-round6-truth-privacy.md`、`reviews/R8-FIX-round6-gate-listener.md`、`reviews/R8-FIX-round6-prompt-turn.md`。

- 新鲜 `TruthAttributeProbe` 显式贯穿 truth-path/settings/truth-batch/service/store；单次逻辑身份复核使用一次 native probe + 两次 `lstat`，避免陈旧属性缓存和重复子进程。
- journal 写零后、同句柄回读前新增新鲜路径围栏；Pi carrier 删除前检查绝对路径、祖先 reparse、普通单链接文件和两次身份。
- 动态 pending-operation 键进入持久隐私语料并递归脱敏；survivor 动态键碰撞 fail closed； doomed entry 先删除，不被自身碰撞误阻断。
- Gate invalidation listener 按 proposal/逐 listener 保存未完成通知并重放；Audit 登记不被重放失败跳过；只有通知全部成功才解除 `privacyBlocked`。
- `apps/desktop/test/memory-round7-regression.test.ts:795` 新增真实 MemoryService + Gate + Audit 失败重试集成。
- prompt 已投递后，post-send `get_state` 失败或 ownership 变化不再提前释放串行 barrier；start/settled 按原 binding/admission 归属。
- 两个 pool fixture 补齐生产已要求的严格递增 `sessionGeneration`，未修改 pool 生产代码。

Round6 Before：`before/round6-truth-privacy.txt`（15 failed / 111 passed）、`before/round6-gate-listener.txt`（4 failed / 17 skipped）、`before/round6-prompt-turn.txt`（1 failed / 165 skipped）。

Round6 After：

- `after/round6-truth-privacy.txt`：3 files，127 passed。
- `after/round6-privacy-fences-focused.txt`：16 passed，111 个名称过滤 skip；完整三文件无 skip。
- `after/round6-gate-listener.txt`：2 files，32 passed。
- `after/round6-prompt-turn.txt`：1 passed，165 skipped。
- `after/round6-pool-fixtures.txt`：2 files，3 passed。
- `after/round6-runtime-suite.txt`：7 files，291 passed。
- `after/round6-typecheck.txt`：workspace typecheck 通过。

`after/round6-probe-profile.txt` 是旧性能诊断超时输出，已由 `after/round6-probe-profile-superseded.md` 明确取代，不作为最终通过证据。

## Round7 终审追加修复

详细报告：`reviews/R8-FIX-round7-runtime.md`、`reviews/R8-FIX-round7-truth-commit-copy.md`。

- `packages/agent-host/src/pi-runtime-pool.ts:240` 起以 per-child lifecycle lane 串行 configure/switch/new/bind/release；`waitForAcquire()` 覆盖排队、进行中的 bind 与取消退休。privacy stop 先捕获该 promise 再取消，等待打开/重置终态后才执行破坏性清理。
- `packages/agent-host/src/pi-sdk-runtime.ts:142` 起捕获非阻塞 prompt 拒绝并保留 `promptId`；`pi-runtime.ts:76` 起仅转换带精确相关 id 的 terminal prompt error。IPC 按原 turn/client/lease/admission/grant 归属清理，generic 或迟到错误不得结束 replacement。
- `settings.ts` 的 `atomicWrite()` 在 rename 成功点立即触发 `onRenamed`；`truth-batch.ts` 随即标记 committed。post-rename 验证抛错时安全重读 journal，确认 committed 后只清理、不 restore；无法确认则保留证据并写 truth write-block。
- `truth-path.ts:237` 的 verified copy 在 destination 最后探测后重新 fresh probe + 双 lstat source，并在 copy 后复核 source/destination 身份与内容。Windows 合法覆盖只允许 size/mtime/ctime 变化，仍锚定 dev/ino/mode/nlink。
- `store.ts:1314` 的 DB corrupt backup/journal 清理使用 no-follow open、fstat、原长度 ftruncate/写零/fsync、同句柄回读、关闭后路径复核和 verified remove；`compact()` 的目录枚举也改为 verified directory read。
- `service.ts:1059` 的 privacy journal temp rename 保存 source 完整身份，rename 前重围栏，rename 后 fresh probe、双 lstat、身份/内容校验；失败时保留 journal 并阻断后续 sink/truth 清理。retry 不再因调用方已更新 pending maps 而跳过 journal 重写。
- `truth-path.ts:202` 新增 verified directory read；`store.ts:271`、`:442`、`:540`、`:574` 在构造、truth discovery、agents/proposals 枚举前围栏并在枚举后复核。`truth-path.ts:220` 将 verified read 后源消失规范化为 `TruthPathSafetyError`。

Round7 Before：

- `before/round7-runtime-privacy-opening.txt`：1 failed / 53 skipped。
- `before/round7-runtime-prompt-error.txt`：3 files failed；6 failed / 179 skipped。
- `before/round7-truth-commit-point.txt`：2 failed / 51 skipped。
- `before/round7-truth-copy-source.txt`：2 failed / 51 skipped。
- `before/round7-truth-cleanup-journal-directory.txt`：8 failed / 1 passed / 50 skipped；失败分别为 DB/journal 清零、journal rename 内容回读、四类目录枚举和读取后源消失，无 harness ENOENT 伪失败。

Round7 After：

- `after/round7-runtime-privacy-opening.txt`：2 passed / 221 skipped。
- `after/round7-runtime-prompt-error.txt`：3 files passed；6 passed / 179 skipped。
- `after/round7-truth-commit-point.txt`：2 passed / 51 skipped。
- `after/round7-truth-copy-source.txt`：2 passed / 51 skipped。
- `after/round7-truth-cleanup-journal-directory.txt`：9 passed / 50 skipped。
- `after/round7-memory-suite.txt`：当前完整 memory 套件结果见文件。
- `after/round7-workspace-typecheck.txt`：当前 workspace typecheck 结果见文件。

`packages/agent-host/test/runtime-actions.test.ts:18`、`:39` 的既有 exact-object 断言已补齐生产 envelope 的 `sessionGeneration: 0`；未改变生产 generation 契约。

## Round7 终审追加修复与性能收敛

- `service.ts` 的 completed journal 缺失路径允许完成清理并解除内存围栏；journal 仍存在时必须与 pending 保存的原身份一致。全部 journal 身份统一为 `truthFileIdentity()` 的 `dev:ino:mode:nlink:size:mtimeMs:ctimeMs`，避免四段/七段格式混用造成误判。
- `truth-path.ts` 新增 `inspectTruthFiles()` / `inspectTruthFilesTwice()`，让同一逻辑边界内的 parent/target/temp 等相关路径共享一次 fresh native probe，同时保留逐路径双 `lstat` 与完整身份校验；`readTruthFileVerifiedResult()` 一次返回内容和身份，消除读取前重复 inspect。
- `settings.ts` 的 `atomicWrite()` 批量检查 parent/target 与 rename 前 temp/target、rename 后 target/temp，仍在每个实际使用边界 fresh probe、比较 dev/ino/mode/nlink/size、verified read 内容并确认 temp 消失。
- `store.ts` 仅在顶层同步复合操作入口 fresh 检查 write-block，嵌套真相读取不再重复同一操作级 marker probe；每个实际文件读取仍独立 fresh probe、双 `lstat`、读后身份复核，privacy unavailable 检查没有被嵌套跳过。
- 基础路径真实 `SandboxProbe.exe` 计数由 221 次降至 151 次；未提高 Vitest timeout、未跳过用例、未用假 probe。临时导出和 profiling 测试已移除。

Round7 Before：

- `before/round7-completed-journal-absence.txt`：completed journal 已不存在时错误要求原身份，1 failed。
- `before/round7-privacy-journal-identity-format.txt`：四段/七段身份混用，聚焦失败。
- `before/round7-memory-service-performance.txt`：基础用例 5902ms，5000ms 超时失败。
- `before/round7-native-probe-profile-counted.txt`：真实 native probe count=221，5404.3117ms，5 秒超时失败。

Round7 After：

- `after/round7-completed-journal-absence.txt`：completed journal 缺失路径通过。
- `after/round7-privacy-journal-identity-format.txt`：统一身份格式聚焦通过。
- `after/round7-memory-service-performance.txt`：同一基础用例 4199ms，通过。
- `after/round7-truth-focused-optimized.txt`：3 files，146 passed，包含 R7/R8/truth-batch 完整回归。
- `after/round7-native-probe-profile-operation-fence.txt`：count=151，基础路径测试 4105ms，通过；该诊断只作性能证据，最终代码不保留临时 probe 导出。

## R7 保留

R7 源码清单与证据清单哈希在最终仍为：

- source：`c7e148a3de4f31321b740b5ffba4bac16f606aa22f748b255f525b5cb4573b5a`
- evidence：`a9bf43dbacd32ad3b8c2a896a6edd2f7789768a056a7cb7f22f22a8a5c5903bd`

见 `after/final-r7-manifests.txt`。R7 全部既有回归保留；两个读取断言由“返回空”加强为“隐私删除尚未完成”抛错，没有删除用例或降低安全断言。

## 最终验证

待最终 round6 两轮指定全套、IPC 聚焦、Approval/Audit、三域终审和哈希复核完成后，以本节列出的当前文件为准。

## 已知限制

- Windows 路径检查与使用之间仍有 TOCTOU；fresh probe、双 `lstat`、句柄身份和删除后复核缩小窗口，不声称消除。
- symlink 在部分 Windows 场景可能返回 EPERM；仍 fail closed。
- `.sparkii` 外递归硬链接别名风险仍是既有披露限制。
- 相邻 Pi carrier 密钥不是 DPAPI；能同时读取 DB 与 key 的攻击者可解密，本轮未声称解决。
- 没有跨进程 dataDir 锁，也没有新增 power-loss-grade fsync 保证。
- IPC/workflow/pool 的 FakeHandle 测试证明命令、lease 和 teardown 逻辑，不证明真实 Pi 子进程；真实 child fixture 只覆盖其明确场景。
- 既有 workspace integration 套件的 1 个 skip 继续保留；最终计数以当前两轮输出为准。
- 未修改依赖、CI/CD、Git 配置；未触碰真实安装目录、用户记忆或数据库；未 reset、restore、clean、stage、commit 或 push。
