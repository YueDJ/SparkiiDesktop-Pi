# R8-REPAIR-MEMORY 映射

- Task-id：`R8-REPAIR-MEMORY`
- 日期：2026-11-25 起；最终 round7 修复与验证日期：2026-11-26；最终 round8 复审修复与冻结日期：2026-11-27
- 仓库：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi`
- 基线：HEAD `101487d3f612764766cc024d4b28dbf846a926cf`，branch `main`
- 基线跟踪补丁 SHA-256：`84a5929b97f68c00a1ed3f5aee842449626608f05f66b03d28bc88b77f8c50dc`
- 工作树原有 R6/R7 未提交改动继续保留；本映射描述 R8 增量，不把全部 dirty 文件称为 R8 新增。

## 门禁状态

当前实现已完成两轮串行完整指定套件（29 files，595 passed / 1 skipped）、focused 5 files 204 passed、Approval 95、agent-host 219、Runtime A/B/C、完整 typecheck 与 `git diff --check`，均为确定性通过。

`ipc.test.ts` 全文件对 `R8 round5 blocker5` 的非确定性挂起已在 final-r16 关闭：`npx vitest run apps/desktop/test/ipc.test.ts` 连续 10 次全部 `171 passed`，曾经的触发对与整个 runtime 绑定组各连续 6 次全绿（`after/final-r16-ipc-full-repeat{1..10}.txt`）。
根因是测试前提缺失而非生产缺陷——B、C 在同一同步块并发入队，谁先登记到会话队列尾部由各自 open 阶段的 promise 完成顺序决定，单次 settle 只放行队首，而测试断言被放行的必须是 B。
本节此前记录的“停在 `startSessionTask → createTaskGrant → admitWorkspace` await”**是错误结论**：该判断基于 vitest 控制台输出，而用例超时后 vitest 会丢弃未刷新的输出，日志尾部的最后一条并非真正的停点。改用同步写文件的时序日志后真相才明确（`after/final-r16-blocker5-queue-race-trace.txt`），排查过程与纠错记录保留在 `reviews/R8-FINDING-IPC-BLOCKER5-NONDETERMINISM.md`。
修复为测试侧：`blocker5` 改为逐个入队并新增“C 在 B 终态前不得发送”的断言，另加 `blocker5b` 覆盖并发入队的确定序放行；生产代码未改动。判别力校验（把栅栏改为不等待前一轮后两条用例同时失败）见 `after/final-r16-blocker5-fix-and-mutation-check.txt`。

首轮三域审查中的 Runtime blocker、truth 域 r14 的 worker 模块类型阻断、privacy 复审的两项证据/映射 blocker、runtime 复审的 `agent_end` 终态阻断均已修复并复验；三域终审（r15）为 APPROVE / 0 blocking，final-r16 仅改动测试文件，未触及被评审的生产实现。

## R8-P0-1 隐私删除崩溃恢复与明文围栏

生产源码：

- `apps/desktop/electron/main/memory/service.ts:124`、`:125`、`:126`：先加载 privacy write-block/journal，再向 Gate/Audit/Error/Chat/Logger 注册脱敏语料，最后才执行 truth recovery、建 store 和自动续清。
- `apps/desktop/electron/main/memory/service.ts:136`、`:143`：建库前检查 truth 可用性；未完成 privacy cleanup 通过 `unavailable` 围栏阻断读取。
- `apps/desktop/electron/main/memory/service.ts:147`、`:230`：启动自动续删；失败保留 journal、读取围栏和 memoryId→session 完成映射。
- `apps/desktop/electron/main/memory/service.ts:984`：journal 清零前、清零后回读前、回读后都重新围栏；原长度写零、fsync、同句柄回读、身份与删除复核。
- `apps/desktop/electron/main/memory/service.ts:1237`：preflight 后才失效 extraction、写 journal 和执行全局清理；sink 单项失败不阻止其他 sink 清理。
- `apps/desktop/electron/main/memory/truth-batch.ts:279`、`apps/desktop/electron/main/memory/store.ts:449`：磁盘 write-block 与隐私未完成围栏统一生效。

回归：`apps/desktop/test/memory-r8-regression.test.ts:302` 起覆盖 Logger/Audit/Gate/Error 清理失败、truth 部分写入恢复、chat/Pi 已消失、重启失败重试、journal 已消失解除内存围栏，并检查 truth、journal、list/search、Logger 当前及未来日志、Audit/Gate/Error/Chat、原始 DB/WAL/shm/journal 字节。

Before：`before/focused-memory-truth-logger-audit-valid.txt`。

After：`after/architecture-fixes-focused.txt`、`after/focused-runtime-logger-audit.txt`、`after/round6-truth-privacy.txt`；最终结果见文末。

## R8-P0-2 隐私删除先停止活跃运行时

生产源码：

- `apps/desktop/electron/main/ipc.ts:811`：privacy IPC 解析来源会话，经共享 `withSessionDeletion` 等待 teardown，再删除记忆。
- `apps/desktop/electron/main/ipc.ts:2858`：共享 teardown 使 opening epoch 失效、取消 pool acquisition，并复用同一停止 Promise。
- `apps/desktop/electron/main/ipc.ts:2899`：结束 task、取消 release timer、失效 document parser、按捕获 lease 解绑释放、取消 extraction；每次 await 后重检原 binding/admission。
- `apps/desktop/electron/main/ipc.ts:1248`：listing/acquire 前后检查 epoch/stopping/tombstone；旧 acquisition 只释放自己的不可变 lease。
- `packages/agent-host/src/pi-runtime-pool.ts:20`、`:192`：slot 暴露不可变 acquisition lease；`cancelAcquire` 拒绝排队请求，冷启动在绑定前停止 supervisor。
- 同 ID 替换时旧 teardown 返回 false，不删除替代会话、不释放替代 binding、不向旧或替代 client 发送命令。

回归：`apps/desktop/test/ipc.test.ts:4954` 起的 6 个 R8-P0-2 用例；`packages/agent-host/test/pi-runtime-pool.test.ts` 的排队/冷启动取消用例。检查 task 终止原因、extraction、parser、release lease、teardown 顺序、打开前/打开中取消、同 client 同 ID 替代绑定与零客户端命令。

Before：`before/r8-p0-2-valid.txt`、`before/focused-ipc-workflow-valid.txt`。

After：`after/architecture-fixes-focused.txt`、`after/focused-runtime-logger-audit.txt`、`after/repeated-runtime-races.txt`；最终结果见文末。

## R8-P1-1 workflow 原始 binding lease 贯穿

生产源码：

- `apps/desktop/electron/main/ipc.ts:3688`、`:3709`：workflow onReady/beforeRelease admission guard 同时校验 pool client/lease、openSessions 原 entry/lease、inFlightWorkflowRuns lease。
- `apps/desktop/electron/main/workflow.ts:236`、`:248`、`:258`：model/thinking 的 await 前后校验。
- `apps/desktop/electron/main/workflow.ts:308`：sendPrompt 固定原 client/lease，并贯穿模型设置、prompt 与事件边界。
- `apps/desktop/electron/main/workflow.ts:417`：runTool 在设置、知识查询、文档、审批和 broker await 边界校验。
- `apps/desktop/electron/main/workflow.ts:545`、`:667`、`:846`、`:894`、`:903`：workflow 启动、onReady、loop、审批与最终 release 均绑定原 lease。
- `apps/desktop/electron/main/workflow.ts:44`：stale approval 只能 denied。

回归：`apps/desktop/test/workflow-broker.test.ts:914`、`:977`、`:1027` 检查实际命令列表、prompt 数、journal step、审批结果和替代 binding；`apps/desktop/test/ipc.test.ts` 覆盖 admission guard。

Before：`before/focused-ipc-workflow-valid.txt`。

After：`after/architecture-fixes-focused.txt`、`after/repeated-runtime-races.txt`、`after/round6-runtime-suite.txt`；最终结果见文末。

## R8-P1-2 物理换行秘密不破坏 JSONL

生产源码：

- `apps/desktop/electron/main/logger.ts:14`：按原始 `\r\n|\r|\n` 物理边界分行。
- `apps/desktop/electron/main/logger.ts:43`、`:68`、`:116`：畸形物理行安全判定、字符串 token 解码脱敏或安全占位；不重写记录分隔符。
- `apps/desktop/electron/main/logger.ts:145`、`:158`、`:201`：prompt 清理、session 清理、export 都先按原物理行处理。
- `apps/desktop/electron/main/logger.ts:126`、`:137`：输出验证与同步 rewrite 防止未 awaited append 回写明文。

回归：`apps/desktop/test/logger.test.ts:463` 起对 `\n` / `\r\n` / `\r` 和三个入口逐行 JSON.parse、schema、消息、ctx、字段名、记录数及秘密值断言。

Before：`before/focused-memory-truth-logger-audit-valid.txt`。最初无效 harness 输出保留在 `before/focused-memory-truth-logger-audit.txt`，不作为缺陷证据。

After：`after/architecture-fixes-focused.txt`、`after/focused-runtime-logger-audit.txt`；最终结果见文末。

## R8-P1-3 write-block 阻断读取侧

生产源码：

- `apps/desktop/electron/main/memory/truth-batch.ts:297`、`:301`：不安全根 fail closed；损坏/异常 marker 返回阻断。
- `apps/desktop/electron/main/memory/service.ts:123`、`:136`：构造期根路径与可用性检查，避免先建库再发现不安全。
- `apps/desktop/electron/main/memory/store.ts:449`：all scope、reconcile、episode/extraction、row/search、touch、view、redaction、rebuild 和隐私恢复读取统一检查。
- `apps/desktop/electron/main/memory/service.ts` 的 ensureProject/previewScope/archiveProject/readRef 直接真相读取也先检查。

回归：`apps/desktop/test/memory-r8-regression.test.ts:730` 拒绝通过不安全 junction 构造服务且外部目录零变化；`:776` 检查同进程与重启的 search/list/row/rebuild、直接项目读取、损坏 marker，以及移除 marker 后重新索引。

Before：`before/focused-memory-truth-logger-audit-valid.txt`。

After：`after/architecture-fixes-focused.txt`、`after/round6-truth-privacy.txt`；最终结果见文末。

## R8-P1-4 journal 校验失败不丢原真相

生产源码：

- `apps/desktop/electron/main/memory/truth-batch.ts:422`、`:432`：journal 写入后校验失败时先删除未生效 journal；删除失败则不删 backups，保留全部证据并抛错。
- `apps/desktop/electron/main/memory/truth-batch.ts:458`、`:473`：目标写入后的回滚仍保持原恢复语义；回滚失败写 block 并保留 journal/backups。

回归：`apps/desktop/test/memory-truth-batch.test.ts:111`、`:280` 两个 R8-P1-4 用例；第二个注入 journal 路径不可删除，断言原目标字节、备份字节和 held journal 均保留。

Before：`before/focused-memory-truth-logger-audit-valid.txt`。

After：`after/architecture-fixes-focused.txt`、`after/round6-truth-privacy.txt`；最终结果见文末。

## R8-P1-5 隐私删除先做身份/损坏预检

生产源码：

- `apps/desktop/electron/main/memory/store.ts:1689`：复用同一套 scope conflict/corrupt/identity 规则生成 preflight plan。
- `apps/desktop/electron/main/memory/store.ts:1717`：commit 复用 preflight 的 refs/episodes/states，不复制规则。
- `apps/desktop/electron/main/memory/service.ts:1237`：在 extraction 失效、journal 写入和任何全局清理前执行 preflight。

回归：`apps/desktop/test/memory-r8-regression.test.ts:1019` 的 identity/projectId/corrupt 三个用例；逐字节比较 truth、Audit/Logger/Chat/journal，并确认失败后原文仍保留。

Before：`before/focused-memory-truth-logger-audit-valid.txt`。

After：`after/architecture-fixes-focused.txt`、`after/round6-truth-privacy.txt`；最终结果见文末。

## R8-P1-6 Audit 持久防止明文回写

生产源码：

- `packages/approval/src/audit.ts:41`、`:125`、`:131`：只保存 SHA-256 + UTF-16 code-unit 长度等非明文登记；损坏/不安全登记文件 fail closed。
- `packages/approval/src/audit.ts:141`：登记持久化失败设置 blocked，防止后续读写绕过。
- `packages/approval/src/audit.ts:280`：append 在插入前脱敏所有自由文本列。
- `packages/approval/src/audit.ts:338`：历史行事务脱敏、checkpoint、VACUUM；query/filter 防御性脱敏。
- `apps/desktop/electron/main/memory/service.ts:126`、`:161`：删除开始和重启 journal 恢复时注册 Audit 及其他 sink。

回归：`apps/desktop/test/memory-r8-regression.test.ts:712` 与 `packages/approval/test/audit.test.ts:60`、`:124`；覆盖完成后立即 append、清理中并发 append、restart 后 append、历史行及原始 DB/WAL 字节。

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
- `packages/agent-host/src/pi-sdk-runtime.ts:155` 起捕获非阻塞 prompt 拒绝并保留 `promptId`；`pi-runtime.ts:78` 起仅转换带精确相关 id 的 terminal prompt error。IPC 按原 turn/client/lease/admission/grant 归属清理，generic 或迟到错误不得结束 replacement。
- `settings.ts` 的 `atomicWrite()` 在 rename 成功点立即触发 `onRenamed`；`truth-batch.ts` 随即标记 committed。post-rename 验证抛错时安全重读 journal，确认 committed 后只清理、不 restore；无法确认则保留证据并写 truth write-block。
- `truth-path.ts:671` 的 verified copy 在 destination 最后探测后重新 fresh probe + 双 lstat source，并在 copy 后复核 source/destination 身份与内容。Windows 合法覆盖只允许 size/mtime/ctime 变化，仍锚定 dev/ino/mode/nlink。
- `store.ts:1552` 的 DB corrupt backup/journal 清理使用 no-follow open、fstat、原长度 ftruncate/写零/fsync、同句柄回读、关闭后路径复核和 verified remove；`compact()` 的目录枚举也改为 verified directory read。
- `service.ts:1089`、`:1198` 与 `truth-path.ts:721` 的 privacy journal temp rename 保存 source 完整身份，rename 前重围栏，rename 后 fresh probe、双 lstat、身份/内容校验；失败时保留 journal 并阻断后续 sink/truth 清理。retry 不再因调用方已更新 pending maps 而跳过 journal 重写。
- `truth-path.ts:535` 新增 verified directory read；`store.ts:298`、`:299`、`:485`、`:487`、`:665`、`:1617` 在构造、truth discovery、agents/proposals 枚举前围栏并在枚举后复核。`truth-path.ts:572` 将 verified read 后源消失规范化为 `TruthPathSafetyError`。

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

`packages/agent-host/test/runtime-actions.test.ts:18`、`:44` 的既有 exact-object 断言已补齐生产 envelope 的 `sessionGeneration: 0`；未改变生产 generation 契约。

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

## Round8 最终追加修复

本地基线提交 `b411f47` 后，根据完整门禁失败补齐以下实现。当前最终代码仍未 push。

### Runtime B1 prompt/task origin

- `apps/desktop/electron/main/ipc.ts:982` 起维护 Main 创建的不可变 `runtimeOrigins`；action、proposal、connector-read 均按 session、client、lease、Task/admission 精确解析 owner。
- `packages/agent-host/src/pi-sdk-runtime.ts` 使用 `AsyncLocalStorage` 保持重叠 prompt 的 origin；SDK 命令缺少 `originToken` 时 fail closed。
- `apps/desktop/electron/main/security/runtime-action-router.ts:561` 的 revalidate 异常、`:580` 的 allow audit 异常，以及 approval 异常均先重检原 owner；owner 已变化时返回 `TASK_REVOKED`，不会把拒绝误报为普通审批失败，也不执行。
- `apps/desktop/electron/main/workflow.ts:308` 起 workflow prompt 通过 `rt.promptTurn({ waitForSettled: true })` 参与同一条串行 prompt turn；`ipc.ts:2320` 的 workflow 分支必须等待当前 turn 的 settled promise，不能因 prompt command accepted 而返回。
- `apps/desktop/electron/main/ipc.ts:2215` 在 command 发送前把 turn promptId 回调给 workflow；`workflow.ts:358` 对早于回调到达的 correlated `prompt_error` 暂存，回调后立即消费，避免 acceptance/event 竞态。terminal 事件、correlated prompt error 或 settled 完成才进入终态；binding 变化后的迟到事件不能完成旧步骤。
- `apps/desktop/test/workflow-broker.test.ts:204` 的 proposal 断言更新为当前更强生产错误 `workflow proposal origin is not executable`；同时保留旧 `admission is not ready` 兼容分支。拒绝仍在 submit 之后、执行之前，未删断言。
- A/B/C 用例 `apps/desktop/test/ipc.test.ts:6289` 明确证明：late A action/proposal/connector 均 denied；executor 与 workspace executor 零调用；document read 零调用；approval submit/event 数不变；shell grant 的 grant/allows 调用数不变；C 的 Task、admission、binding/lease 和 session generation 保持。

### Privacy journal 替换与删除围栏

- `apps/desktop/electron/main/memory/service.ts:1089`：隐私 journal 目标已存在时，先按目标 fresh identity 走完整清零、同句柄回读和删除围栏，再 fresh 重检 source/destination；只有确认目标消失才 rename。
- `apps/desktop/electron/main/memory/service.ts:1209`：journal 替换失败的原始路径/链接/清零原因会保留在错误信息中，不再被泛化成无法定位的“无法保存”。
- `apps/desktop/electron/main/memory/truth-path.ts:789`、`:756`：单路径和批量删除均恢复“初始双 lstat + 紧邻删除前双 lstat + 删除后复核”，未以批量边界替代逐路径新鲜检查。

### Truth copy、索引快照与读取复用

- `apps/desktop/electron/main/memory/truth-path.ts:671`：verified copy 顺序恢复为 destination probe → source probe → destination last probe → source recheck → destination recheck → copy → destination readback → source post-copy fence，使 source 在最后一次 destination 检查处被替换时会在 copy 前以硬链接失败。
- `apps/desktop/electron/main/memory/store.ts:1037`、`:1040`：`reconcileAllWithTruth()` 返回同一顶层同步操作已经验证的 refs、snapshots 与 identity conflicts；同操作消费，不把它当作跨操作读取凭证。
- `apps/desktop/electron/main/memory/store.ts:654`：truth discovery 和 project scope 枚举一次生成 fresh snapshot map；`rowsFromDiscoverySnapshots()` 复用该 map，避免同操作重复 `readAllTruth`。
- 直接 `readScopeSnapshot()`、`markSourcesDeleted()` 与 `deleteMemoryEntriesBySession()` 的第二次实际 truth read 仍保留，不能靠 persistent cache 跳过。
- `apps/desktop/electron/main/memory/store.ts:940`：索引事务同时做 fresh identity fence 与 content hash recheck，不能只凭 mtime identity 宣称未变化。

### 常驻原生探针

- `apps/desktop/native/windows-sandbox/SandboxProbe.cpp:105`：新增 `reparse-daemon`，按长度前缀 binary 协议连续处理多个 batch；每个 path fresh `GetFileAttributesW`，缺失路径返回 invalid marker，异常/非法数量退出。
- `apps/desktop/electron/main/memory/truth-path.ts:179`：Node worker 持有 daemon child，主线程通过 SharedArrayBuffer 同步请求，避免每次 probe 启动新进程。worker 事件循环不阻塞，child exit/error/非法响应会触发失败。
- `apps/desktop/electron/main/memory/truth-path.ts:286`、`:258`：默认走 resident probe；worker 超时、退出、非法响应，或显式设置 `SPARKII_TRUTH_PROBE_DAEMON_DISABLED=1` 时，回收 bridge 并回退到原单次 `reparse-attributes`。回退只改变执行方式，不跳过 fresh attribute probe。
- `apps/desktop/test/memory-truth-probe-daemon.test.ts`：直接验证一个 daemon 连续处理两批、missing path 返回 invalid、超大 count fail closed、resident bridge 禁用后 one-shot 仍可用。
- 真实应用退出后的 OS 进程生命周期以及打包资源路径尚未做 Electron 端到端验证，作为残留风险披露。

Round8 Before：

- `before/R8-B1-origin-baseline-tests.txt`：Runtime B1 原始基线红。
- `before/R8-B1-origin-missing-envelope-red.txt`：缺少 origin envelope 时未 fail closed。
- `after/final-r10-full-suite-round1.txt`：首轮复验暴露 5 files / 32 failed，保留为修复前状态。

Round8 After（当前最终候选为 `final-r14-*`；r10–r13 文件保留为定位与中间验证历史）：

- `after/final-r10-memory-r8-after-journal-replacement.txt`：首轮 journal 替换修复，memory R8 59 passed。
- `after/final-r11-pi-runtime-focused.txt`：Pi runtime/SDK/queue/supervisor 4 files，45 passed。
- `after/final-r11-ipc-r8.txt`：IPC R8 41 passed / 129 skipped。
- `after/final-r11-approval-audit.txt`：Approval/Audit/Proposal 3 files，39 passed。
- `after/final-r12-truth-daemon-workflow.txt`：r12 truth/daemon/workflow 3 files，96 passed。
- `after/final-r13-review-remediation-focused.txt`：memory R8、truth batch、truth daemon、workflow、runtime router 5 files，200 passed。
- `after/final-r13-ipc-r8-abc.txt`：Runtime B1 A/B/C 1 passed / 169 skipped。
- `after/final-r13-ipc-blocker5-repeat{1,2,3}.txt`：queued replacement barrier 连续三次通过，排除首轮高负载偶发超时。
- `after/final-r13-ipc-full.txt`：IPC 170 passed。
- `after/final-r13-approval-full.txt`：Approval package 15 files，95 passed。
- `after/final-r13-agent-host-full.txt`：agent-host 32 files，219 passed。
- `after/final-r13-full-suite-round1.txt`：29 files，591 passed / 1 skipped。
- `after/final-r13-full-suite-round2.txt`：29 files，591 passed / 1 skipped；两轮数字一致。
- `after/final-r13-typecheck.txt`：workspace typecheck 通过。
- `after/final-r14-review-remediation-focused.txt`：memory R8、truth batch、truth daemon、workflow、runtime router 5 files，202 passed。
- `after/final-r14-ipc-r8-abc.txt`：Runtime B1 A/B/C 1 passed / 169 skipped。
- `after/final-r14-ipc-full.txt`：IPC 170 passed。
- `after/final-r14-approval-full.txt`：Approval package 15 files，95 passed。
- `after/final-r14-agent-host-full.txt`：agent-host 32 files，219 passed。
- `after/final-r14-full-suite-round1.txt`：29 files，593 passed / 1 skipped（`--no-file-parallelism` 串行）。
- `after/final-r14-full-suite-round2.txt`：29 files，593 passed / 1 skipped；两轮数字一致。
- `after/final-r14-typecheck.txt`：workspace typecheck 通过。
- `after/final-r14-git-diff-check.txt`：exit 0，仅仓库既有 CRLF 提示。
- 当前候选的源码/证据清单与最终 Git 状态见 `source-sha256-final-r14.txt`、`evidence-sha256.txt`、`final-git-state-r14.txt`。

### r15（含 runtime `agent_end` 终态修复后的最终候选）

- `after/final-r15-full-suite-round1.txt`：29 files，595 passed / 1 skipped（`--no-file-parallelism` 串行）。
- `after/final-r15-full-suite-round2.txt`：29 files，595 passed / 1 skipped；两轮数字一致。
- `after/final-r15-review-remediation-focused.txt`：memory R8、truth batch、truth daemon、workflow、runtime router 5 files，204 passed。
- `after/final-r15-approval-full.txt`：Approval package 15 files，95 passed。
- `after/final-r15-agent-host-full.txt`：agent-host 32 files，219 passed。
- `after/final-r15-ipc-r8-abc.txt`：Runtime B1 A/B/C 1 passed / 169 skipped。
- `after/final-r15-ipc-full-repeat{1..5}.txt`：IPC 全文件五次重复，4 通过 / 1 失败——失败即上述 `blocker5` 非确定性挂起，保留为未解决阻断的原始输出。
- `before/final-r14-workflow-retryable-agent-end.txt` / `after/final-r14-workflow-retryable-agent-end.txt`：`agent_end{willRetry:true}` 被当作本轮终态时，步骤以中途文本 `RETRY_INTERMEDIATE_73A` 记为 completed；修复后同一用例以 `FINAL_RETRY_ANSWER_73C` 通过。
- `after/final-r15-typecheck.txt`：workspace typecheck 通过。
- `after/final-r15-git-diff-check.txt`：exit 0，仅仓库既有 CRLF 提示。

### r16（blocker5 非确定性关闭后的最终候选）

- `after/final-r16-ipc-full-repeat{1..10}.txt`：`ipc.test.ts` 全文件连续十次，每次 `171 passed`（修复前五连 4 通过 / 1 失败）。
- `after/final-r16-blocker5-queue-race-trace.txt`：同步文件时序日志，证明是 C 先登记导致单次 settle 放行 C、测试等待的 B 压在队尾；并记录此前“停在准入 await”的错误结论是如何产生的。
- `after/final-r16-blocker5-fix-and-mutation-check.txt`：测试侧修复说明 + 生产栅栏变异后两条用例同时失败（判别力），随后 SHA-256 校验还原。
- `after/final-r16-full-suite-round{1,2}.txt`：29 files，595 passed / 1 skipped，两轮一致。
- `after/final-r16-review-remediation-focused.txt`：5 files，204 passed。
- `after/final-r16-approval-full.txt`：15 files，95 passed；`after/final-r16-agent-host-full.txt`：32 files，219 passed。
- `after/final-r16-ipc-r8-abc.txt`：Runtime A/B/C 1 passed / 170 skipped。
- `after/final-r16-typecheck.txt`、`after/final-r16-git-diff-check.txt`：typecheck Done、`git diff --check` exit 0。

## R7 保留

R7 源码清单与证据清单哈希在最终仍为：

- source：`c7e148a3de4f31321b740b5ffba4bac16f606aa22f748b255f525b5cb4573b5a`
- evidence：`a9bf43dbacd32ad3b8c2a896a6edd2f7789768a056a7cb7f22f22a8a5c5903bd`

见 `after/final-r7-manifests.txt`。R7 全部既有回归保留；两个读取断言由“返回空”加强为“隐私删除尚未完成”抛错，没有删除用例或降低安全断言。

## 三域终审后的追加修正

三份首轮独立审查结果：truth `APPROVE / 0 blocking`，privacy `APPROVE / 0 blocking`，runtime `CHANGES_REQUIRED / 1 blocking`。Runtime blocker 已修复，非阻断项处理如下：

- `apps/desktop/electron/main/ipc.ts:2137`：workflow prompt turn 新增 `onPromptId`、`waitForSettled` 契约；`:2215` 在 prompt command 发送前回调 promptId；`:2320` 仅 workflow 的 `behavior === 'prompt'` 等待当前 turn settled 后才返回，避免“command accepted 即 step completed”。
- `apps/desktop/electron/main/workflow.ts:358`：promptId 尚未回调时暂存同 promptId 的 `prompt_error`，回调后立即消费；`:399` 请求 `waitForSettled`，并在真正 terminal/settled 后完成。
- `apps/desktop/test/workflow-broker.test.ts:100`：默认 harness promptTurn 先回调 promptId、再发送 command，并只接受带同一 promptId 且 terminal 的 `prompt_error`，与生产关联语义一致；`:1146` acceptance-only 回归证明 promptTurn 已返回仍不会把 LLM step 判为完成，`:1204` 覆盖 terminal 错误早于 promptId 回调时的暂存消费路径。
- `apps/desktop/test/memory-truth-batch.test.ts`：移除 R8 debug `console.log`；临时 profiling 文件此前已删除。
- `apps/desktop/electron/main/memory/service.ts:1097`：隐私 journal 已存在时先完整清零旧 journal 再替换；`:1209` 保留清零/链接失败原始原因。新增 focused assertion，检查替换调用 `removePath` 时 destination 已全零。
- `docs/memory-evidence/repair-2026-11-25-round8/source-manifest-sha256.txt`：原先对 `source-sha256.txt` 的哈希锚点不可复现，已重新生成并校验。
- `apps/desktop/electron/main/memory/truth-path.ts:535`：single directory verified read 的 `readdirSync` 异常统一规范为 `TruthPathSafetyError`。
- `apps/desktop/electron/main/security/runtime-action-router.ts:318`：approval 异常且 owner 未变化时也写 `action.denied` 审计，消除拒绝留痕不对称。
- `apps/desktop/electron/main/memory/service.ts:1011`：隐私 journal 清零 open flag 与 DB artifact cleanup 统一为 `O_RDWR | O_NOFOLLOW`。

修正后重新执行两轮完整指定套件、IPC、Approval、agent-host、focused 与 Runtime A/B/C；当前最终候选计数见下节 `final-r14-*`。

## 复审 r14 修复（truth 与 privacy）

Privacy 域 final-r13 复审结论为 `CHANGES_REQUIRED / 2 blocking`（引用的 focused 证据文件当时不存在、映射行号漂移），两项均为证据与文档问题，未复现新的生产行为缺陷。Truth 域 final-r14 复审另给出 1 项真实阻断，同一轮非阻断项一并处理。全部修复如下：

- Truth r14 BLOCKING-1：`PROBE_DAEMON_SOURCE` 原先以 `require('node:worker_threads')` 开头。`new Worker(code, { eval: true })` 的求值模块类型继承父线程启动方式，按 ESM 求值时 `require` 不存在，worker 编译期即失败；而主线程此时停在同步 `Atomics.wait(..., 5000)`，`worker.on('error')` 只能排队投递、无法提前唤醒，于是每个逻辑 truth 边界冻结主线程满 5s 才回退一次性 `execFileSync`。修复见 `apps/desktop/electron/main/memory/truth-path.ts:26`（改为 `Promise.all([import(...), import(...)])` 引导，两种求值模式都合法），实测对比见 `after/final-r14-probe-worker-module-kind.txt`。
- 该缺陷的影响范围仅限“按 ESM 求值 eval worker”的启动环境：本轮在同一台机器上实测默认启动方式（plain node ESM 父线程与 vitest fork）bridge 正常，5 次生产探测 296ms 且调用结束仍有 1 个常驻 `SandboxProbe.exe`。因此 Round7 的 `221 → 151` 真实探针计数收敛与 `4199ms` 基础用例、以及 r13 隐私用例 1210ms 的既有证据仍然成立，不因本条修复而作废；`final-r14-probe-resolver-foreign-cwd-after.txt` 原先把 junction 拒绝归因于原生 reparse 分支，已按实际分支改正。
- `apps/desktop/electron/main/memory/truth-path.ts:179`：主线程等待按状态 1（请求就绪）/2（worker 已取走）续等并重算截止时间，避免高负载下把“正在处理”误判成意外状态而回收健康 bridge。
- `apps/desktop/test/memory-truth-probe-daemon.test.ts`：新增生产路径回归——连续五次 `assertTruthPathSafe` 必须 < 2000ms，且调用结束时常驻 `SandboxProbe.exe` 数增加、warm 之后 junction 仍被拒绝；这一断言专门盯住“bridge 未启动 → 每批探测等满 5s”的失效形态。
- `apps/desktop/electron/main/memory/truth-path.ts:258`、`:275`：新增 `moduleRelativeProbeHelper()`，按模块位置上溯查找 `native/windows-sandbox/bin/SandboxProbe.exe`，命中即缓存；`resolveProbeHelper()` 逐级短路 resourcesPath → 模块相对 → `process.cwd()`，打包环境不再每批探测重复必定落空的目录回溯。修复前未打包运行（`pnpm start` 的工作目录是 `apps/desktop`）会拼出不存在的路径并抛 `Windows reparse-point attribute probe is unavailable`，truth 读写全线失败。
- `apps/desktop/electron/main/memory/truth-path.ts:179`：为 bridge worker 增加 `error` / `exit` 监听，失效记录就地回收；`terminate()` 捕获拒绝。缺少监听时 worker 编译失败或未捕获异常会以未处理 `error` 事件终止 Electron 主进程，回退一次性 `execFileSync` 才是唯一安全路径。
- `apps/desktop/test/memory-truth-probe-daemon.test.ts`：native helper 路径改用 `import.meta.dirname` 相对解析，套件不再依赖调用目录。
- `before/final-r14-probe-resolver-foreign-cwd-before.txt`、`after/final-r14-probe-resolver-foreign-cwd-after.txt`：同一子进程驱动、同一非仓库根工作目录的真实前后对比——修复前普通文件即探针不可用，修复后普通文件通过且 junction 仍被原生 reparse 探测拒绝，解析方式变化未降低围栏强度。
- `apps/desktop/test/workflow-broker.test.ts:100`、`:1204`：默认 harness 与生产 prompt 关联语义对齐，并补齐 terminal 错误早于 promptId 回调的回归（同时闭环 runtime 复审 NB-1/NB-2/NB-3）。
- 本文全部 `file:line` 引用按当前代码重新核对，包括 Round7 段与 `workflow.ts`、`ipc.ts`、`store.ts`、`service.ts`、`runtime-action-router.ts`、各测试用例锚点。
- Privacy 复审 NB-2：`source-manifest-filelist-r12.txt`、`source-manifest-filelist-r12-sorted.txt` 当时确实未被封入（旧 `evidence-sha256.txt` 是按 r13 的文件集合生成的）。本轮改为对 `repair-2026-11-25-round8/` 全树重扫生成 `evidence-sha256.txt`（仅排除清单自身），这两份文件与 r14/r15 新增证据一并封入，独立复核见 `after/evidence-sha256-verification-final-r15.txt`。
- Privacy 复审 NB-3：`docs/memory-evidence/repair-2026-11-24/ui-probe.mjs` 属于 Round7 证据树，由 Round7 证据清单 `docs/memory-evidence/repair-2026-11-24-round7/evidence-sha256.txt` 第 9 行封存（另见 `docs/memory-evidence/repair-2026-11-24/evidence-sha256.txt` 第 9 行的同名条目），其聚合哈希 `a9bf43dbacd32ad3b8c2a896a6edd2f7789768a056a7cb7f22f22a8a5c5903bd` 记录在本文“R7 保留”一节；R8 清单只覆盖 `repair-2026-11-25-round8/` 自身，不重复封存 R7 树。

## Runtime 复审 r14/r15 修复

Runtime 域 final-r13 复审为 APPROVE / 0 blocking，但 r14 复审在 Pi 1.5 源码对照下发现一项真实阻断，并已修复：

- `apps/desktop/electron/main/workflow.ts:374`：Pi 在每一次有界重试前都会派发 `agent_end`，并带 `willRetry: true`（`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:766`、`_willRetryAfterAgentEnd` 在 812 行；默认 `retry.enabled=true, maxRetries=3`）。原实现把任意 `agent_end` 当终态，于是 `finish()` 立即 `off()` 解除监听，重试后的真正回答再也进不来，步骤会以重试前的中途文本被 journal 为 `completed`。现改为只在 `agent_settled` 或 `agent_end && willRetry !== true` 时终态；`apps/desktop/electron/main/ipc.ts:3646` 的另一条等待路径同样加上该门。
- `apps/desktop/test/workflow-broker.test.ts:1251`：新增回归，事件序列为 `message_end(中途文本) → agent_end{willRetry:true} → message_end(最终文本) → agent_settled`，断言步骤输出必须是最终文本。修复前该用例以 `output: "RETRY_INTERMEDIATE_73A"` 失败，见 `before/final-r14-workflow-retryable-agent-end.txt`；修复后通过，见 `after/final-r14-workflow-retryable-agent-end.txt`。默认 harness 的终态规则同步改为该门。
- `packages/approval/src/audit.ts:299`：`payload_summary` 的 512 字符上限改到脱敏之后施加。原先调用方先截断，若登记过的秘密切在 512 边界上，截断留下的前缀不再等于登记指纹，会以明文残留在审计库与 `-wal`。预截断点已全部取消：`runtime-action-router.ts:136`、`runtime-action-router.ts:175`（复审 N2 指出的 `auditReviewer` 自由文本 `reason`/`error` 路径）、`workspace-file-service.ts:102`、`workspace-file-service.ts:200`、`ipc.ts:3233`、`workspace-relocation.ts:151`；`memory/tools.ts:53` 保留（其 summary 只含 `scope:id`、sha256 摘要与计数）。新增两条回归：`packages/approval/test/audit.test.ts` 的“先脱敏后截断”用例断言入库后恰为 512 字符且 `.db`/`-wal` 字节不含密钥前 12 字符；`apps/desktop/test/runtime-action-router.test.ts` 的“full payload”用例在恢复预截断后会失败（`expected '{"policyVersion":…' to contain '_TAIL_AFTER_CAP'`），前后实测见 `after/final-r15-audit-payload-cap-order.txt`。
- `apps/desktop/electron/main/security/runtime-action-router.ts:151`：新增 `auditDenial()`，14 处拒绝类审计写入失败不再把整次派发变成异常（调用方仍拿到结构化 `denied`）；放行路径的审计失败仍必须转成 `AUDIT_FAILED`，未改成吞异常。
- `apps/desktop/electron/main/memory/truth-path.ts:258`：模块回溯在遇到最近的 `package.json`（包根）时停止，不再一路回溯到磁盘根，避免执行祖先目录里植入的同名可执行文件。
- `apps/desktop/test/memory-r8-regression.test.ts:295`：`SandboxProbe.exe` 路径改为 `import.meta.dirname` 相对解析；此前从 `apps/desktop` 运行该套件会 ENOENT（privacy 复审 NB）。
- 未解决项见“门禁状态”一节的 `blocker5` 非确定性挂起，另见 `reviews/R8-FINDING-IPC-BLOCKER5-NONDETERMINISM.md`。

## 最终验证

- `source-sha256-final-r15.txt` / `source-sha256-final-r16.txt`：同一 82 个源文件集合，逐条按当前盘态重算；r15 聚合 `0c9b04398b37cf21e4ca4a3cf170c264fe1cabcc392ccf03b985ee298cdad2aa`，r16 聚合见 `source-manifest-sha256.txt` 的 r16 锚点行（该文件按内容自哈希，可重复校验）。
- `evidence-sha256.txt`：以文件自身和 `after/evidence-sha256-verification-final-r15.txt` 的独立重算结果为准（不在被清单覆盖的文档内硬编码自身聚合哈希）。本轮清单为全树重扫，覆盖 r14/r15/r16 全部证据与三份终审报告。
- `final-git-state-r16.txt`：记录冻结时的 HEAD、本地 ahead 数与工作树状态。
- `after/source-sha256-verification-final-r16.txt`、`after/evidence-sha256-verification-final-r16.txt`：两类清单独立复核 exit 0。

三域终审报告已落盘：`reviews/R8-REVIEW-TRUTH-RECOVERY-final-round8-r15.md`、`reviews/R8-REVIEW-PRIVACY-FENCE-final-round8-r15.md`、`reviews/R8-REVIEW-RUNTIME-LOGGER-final-round8-r15.md`，均为 APPROVE / 0 blocking；首轮与中间轮次的阻断项及闭环对照见 `architecture-reviews.md`。

三域已批准不等于 R8 验收完成：`apps/desktop/test/ipc.test.ts` 全文件运行对 `R8 round5 blocker5` 的非确定性挂起仍未解决（`reviews/R8-FINDING-IPC-BLOCKER5-NONDETERMINISM.md`），本轮不予验收、不执行 push。

## 已知限制

- Windows 路径检查与使用之间仍有 TOCTOU；fresh probe、双 `lstat`、句柄身份和删除后复核缩小窗口，不声称消除。
- symlink 在部分 Windows 场景可能返回 EPERM；仍 fail closed。
- `.sparkii` 外递归硬链接别名风险仍是既有披露限制。
- 相邻 Pi carrier 密钥不是 DPAPI；能同时读取 DB 与 key 的攻击者可解密，本轮未声称解决。
- 没有跨进程 dataDir 锁，也没有新增 power-loss-grade fsync 保证。
- IPC/workflow/pool 的 FakeHandle 测试证明命令、lease 和 teardown 逻辑，不证明真实 Pi 子进程；真实 child fixture 只覆盖其明确场景。
- 既有 workspace integration 套件的 1 个 skip 继续保留；最终计数以当前两轮输出为准。
- 未修改依赖、CI/CD、Git 配置；未触碰真实安装目录、用户记忆或数据库；未 reset、restore、clean、stage、commit 或 push。
