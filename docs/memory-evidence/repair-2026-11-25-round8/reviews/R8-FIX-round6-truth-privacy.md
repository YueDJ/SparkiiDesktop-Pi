# R8-FIX-round6-truth-privacy

- 日期：2026-11-26
- 仓库：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi`
- 对应复审：`R8-REVIEW-TRUTH-RECOVERY final-round5 B1`、`R8-REVIEW-PRIVACY-FENCE final-round5 B2/B3/B5`
- 结论：本轮四项生产修复及关联 Gate 重试集成已完成；三文件完整串行 127/127、聚焦 16/16、Gate + Audit 32/32、workspace typecheck 与 `git diff --check` 均通过。最终 R8 验收仍以两轮指定全套、三域最终复审和哈希清单为准。

## 范围

生产修改：

- `apps/desktop/electron/main/memory/truth-path.ts`
- `apps/desktop/electron/main/memory/settings.ts`
- `apps/desktop/electron/main/memory/truth-batch.ts`
- `apps/desktop/electron/main/memory/service.ts`
- `apps/desktop/electron/main/memory/store.ts`

测试修改：

- `apps/desktop/test/memory-truth-batch.test.ts`
- `apps/desktop/test/memory-r8-regression.test.ts`
- `apps/desktop/test/memory-round7-regression.test.ts`

Gate 的生产修复及单元回归见 `R8-FIX-round6-gate-listener.md`。本轮没有改依赖、CI/CD、Git 配置、R7 证据目录或真实安装/用户数据；没有提交、暂存或推送。

## 修复 1：新鲜 reparse 探测贯穿真相边界

### 实现

- `apps/desktop/electron/main/memory/truth-path.ts:153`：`inspectTruthFile` 每次先调用注入的 `TruthAttributeProbe`，再读取经过 symlink、普通文件/目录、`nlink === 1n` 检查的 `lstat`。
- `apps/desktop/electron/main/memory/truth-path.ts:163`：`inspectTruthFileTwice` 每次身份复核使用**一次新鲜 native probe + 两次 `lstat`**，比较两次身份；保留预期身份复核。避免把跨调用的旧属性结果当作安全证据，也避免同一逻辑复核重复启动两次 native 子进程。
- `apps/desktop/electron/main/memory/truth-path.ts:202`：verified read 在读取前执行上述双读身份检查，读取后再次进行带 fresh probe 的身份断言。
- `apps/desktop/electron/main/memory/truth-batch.ts:43`：`TruthBatchOptions.probeAttributes` 显式注入探测实现；recovery、registry、authorization、write-block、quarantine、cleanup 与 commit 路径不再隐式丢失测试/平台实现。
- `apps/desktop/electron/main/memory/settings.ts:28`：`atomicWrite` 接受同一 probe，父路径、目标检查及后续原子写入边界均使用它。
- `apps/desktop/electron/main/memory/service.ts:57`、`:465`、`:778`、`:1293`：`MemoryServiceDeps` 持有 probe，并贯穿启动 recovery、直接真相读取和 `commitTruthBatch`。
- `apps/desktop/electron/main/memory/store.ts:239`、`:246`：`MemoryStore` 持有同一个 probe；`:481`、`:505`、`:1295`、`:1357` 的第二次真相读取不再依赖第一次安全结果。

### 回归

`apps/desktop/test/memory-truth-batch.test.ts:906` 起覆盖：pre-backup 后改成外部硬链接、rollback preflight 后替换 restore 目标、reconcile/rebuild 第一次逐文件探测后转换、`viewOf` 新鲜围栏、`allScopeFiles` 后第二次删除读取重新探测。每个用例都断言失败关闭和外部文件原字节未被改写。

`apps/desktop/test/memory-r8-regression.test.ts` 的测试 mock 同时包裹 `assertTruthPathSafe`、`inspectTruthFile` 与 `readTruthFileVerified`，使 registry/settings 的内部调用也进入确定性 reparse harness；唯一真实 native 集成用例仍直接执行仓库内 `SandboxProbe.exe reparse-attributes`，没有被 harness 替代。

## 修复 2：清零前后都重新围栏 journal

### 实现

`apps/desktop/electron/main/memory/service.ts:949` 的 `removeZeroedPrivacyFile` 不把调用前已经验证的身份当作免检凭证：

1. `:953`、`:970`：清零前两次新鲜路径围栏，并比较 `lstat` 身份。
2. `:976`：`openSync` 后用 `fstatSync` 验证句柄仍指向同一普通单链接文件。
3. `:982`：原长度 `ftruncate`、写零、`fsync`。
4. `:985`：**写零完成后、回读之前**新增新鲜路径围栏；该边界确保验证之后发生的替换不会通过同一旧描述符完成“安全回读”。
5. `:987`、`:988`：同一句柄回读并再次 `fstat`。
6. `:991`、`:992`：关闭后再次新鲜围栏；长度不足或任一非零字节均抛错。
7. `:995`、`:1002`：最终身份/大小复核后调用 verified remove；任何失败都保留 privacy write-block 并抛出。

`apps/desktop/test/memory-r8-regression.test.ts:824` 的 journal 回归在已通过 cleanup 身份检查后再次替换路径，断言没有先对替代目标清零、外部字节不变、原硬链接仍存在且隐私读取继续被阻断。

## 修复 3：Pi carrier 绝对路径、reparse 与身份围栏

`apps/desktop/electron/main/memory/service.ts:187` 的 `cleanupPrivacyCarriers` 在删除原始 Pi carrier 前：

- `:190` 拒绝非绝对路径；
- `:191`、`:203`、`:210` 在删除前和删除后执行新鲜路径/reparse 围栏；
- `:194`、`:204` 两次 `lstat`，并要求普通文件、非 symlink、`nlink === 1n` 和完整身份一致；
- 只有删除成功且目标确实消失后才调用 chat 清理。

`apps/desktop/test/memory-r8-regression.test.ts:824` 起覆盖真实祖先 junction、非 symlink reparse 目录/文件、删除前身份替换、同进程重试和服务重启。均断言外部/victim 字节保留、journal 保留，移除不安全路径后可正常重试。

## 修复 4：动态 pending-operation 键进入隐私语料并递归脱敏

### 实现

- `apps/desktop/electron/main/memory/service.ts:83`、`:92`：递归收集动态对象键和字符串值；只有通过结构校验的 `op/degradedFrom/targetId/projectId/mergeIds` 才作为控制字段排除。`:1182` 将结果加入待删除秘密语料并写入持久 journal。
- `apps/desktop/electron/main/memory/store.ts:1175`：递归脱敏字符串、数组和动态键，保留通过校验的结构字段；`:1183` 对脱敏后重复键 fail closed，绝不覆盖一个值。
- `apps/desktop/electron/main/memory/store.ts:1348`：先筛选将被删除的 entry，只对 survivor 调用 `redactEntryForPrivacy`。 doomed entry 的整体删除不会因其自身动态键碰撞阻断清理；survivor 的真实碰撞仍抛错且 truth 不变。
- 注册表仍持久保存非明文指纹；重启后的 survivor 和未来写入继续使用相同秘密语料。marker 与秘密字符冲突仍走既有 marker 轮换保护。

### 回归

`apps/desktop/test/memory-round7-regression.test.ts:827`：

1. 删除 entry 的嵌套动态键被收集进 journal；survivor 顶层/嵌套键和值被清理；控制字段保留；同进程失败、重启恢复及未来写入均无秘密。
2. 两个独立删除记忆分别注册两个动态键；survivor 同时含这两个键时 fail closed，原 truth 字节不变，journal 保留，读取继续被阻断。

fixture 的调整没有降低断言：第一个 fixture 避免同一对象容器上两个已注册键必然碰撞，第二个 fixture 用两条删除记忆保证两个键各自真正进入脱敏注册表，而不是让测试因“未注册所以未碰撞”而误绿。

## Gate listener 失败重试的真实服务集成

`apps/desktop/test/memory-round7-regression.test.ts:795` 使用真实 `MemoryService`、`ApprovalGate` 与 Audit：listener 首次抛错时删除失败、journal 存在、truth 仍含秘密且 Gate 读取被阻断；第二次生产删除重放 listener 后成功，断言 listener 调用 1→2、journal 清除、truth/list/Audit 无秘密、proposal 完成 privacy redaction。

该用例补上了 Gate 单元测试只能模拟的 journal 生命周期。Gate 内部逐 listener 重放、Audit 继续登记和封锁解除规则见 `R8-FIX-round6-gate-listener.md`。

## 验证证据

### 修复前红灯

命令：

```text
pnpm exec vitest run apps/desktop/test/memory-truth-batch.test.ts apps/desktop/test/memory-r8-regression.test.ts apps/desktop/test/memory-round7-regression.test.ts --reporter=dot
```

结果：3 个文件，126 项中 **15 failed / 111 passed**。失败覆盖 fresh-probe、journal 重新围栏、Pi carrier、动态键注册和动态键碰撞；原始输出：`before/round6-truth-privacy.txt`。

Gate listener 的独立修复前红灯为 4 failed / 17 skipped，见 `before/round6-gate-listener.txt`。新增真实服务集成发生在修复后，不以它冒充修复前证据。

### 修复后完整三文件串行

同一三文件命令，加 `--maxWorkers=1 --no-file-parallelism`：**3 files passed，127 passed / 0 failed / 0 skipped**。

- `memory-round7-regression.test.ts`：28
- `memory-r8-regression.test.ts`：50
- `memory-truth-batch.test.ts`：49
- 合计：127

原始输出：`after/round6-truth-privacy.txt`。

### 修复后聚焦

`-t "R8 round6"` 对应的 truth/privacy 聚焦三文件：**16 passed / 111 skipped**；111 个 skip 是名称过滤未选中的既有用例，完整三文件已另行全部执行。原始输出：`after/round6-privacy-fences-focused.txt`。

Gate + Audit 完整串行：**2 files passed，32 passed**（Gate 21、Audit 11），原始输出：`after/round6-gate-listener.txt`。

### 类型与 diff

- `pnpm typecheck`：退出码 0；`Scope: 9 of 10 workspace projects`，`packages/ui typecheck: Done`，`apps/desktop typecheck: Done`。原始输出：`after/round6-typecheck.txt`。
- `git diff --check`：退出码 0；仅保留既有 CRLF 转换警告，没有 whitespace error。

`after/round6-probe-profile.txt` 是性能诊断期间的旧超时输出，已被上述 127/127 完整结果取代，**不是最终通过证据**。

## 性能修正与测试真实性

早期单用例曾因生产路径重复启动约 800 个 native probe 子进程超过 5000 ms。修复方式不是调 timeout、跳过用例或 mock 掉安全分支，而是：

- 在逻辑身份复核内使用一次 native probe + 两次 `lstat`；
- 通过生产 API 显式注入 probe；
- 普通回归注入确定性属性，保留专门的真实 native 集成用例。

所有 R7 手工重建的 `MemoryService` 也注入同一确定性 probe，避免测试 host 启动无关 native 子进程。临时计数器、栈日志和碰撞诊断已移除。

## 仍有限制

1. Windows 上路径检查与使用之间仍有 TOCTOU 窗口；fresh probe、双 `lstat`、句柄身份和删除后复核缩小窗口，但不声称消除。
2. symlink 探测在部分 Windows 场景可能返回 EPERM；仍 fail closed，不把 EPERM 当安全结果。
3. `.sparkii` 外递归硬链接别名仍是既有披露限制；本轮只保护被检查的单链接真相/carrier 文件，不声称解决所有外部别名。
4. native probe 与随后 `lstat/read` 不是单个原子系统调用；一次 probe + 两次 `lstat` 是性能与重复检测的折中，最终安全仍受 TOCTOU 限制。
5. 没有跨进程 dataDir 锁，也没有新增 power-loss-grade fsync 保证。
6. 本轮测试使用临时目录、临时数据库和 FakeHandle/手工故障注入，不证明真实 Pi 子进程、Electron 打包环境或真实用户存储。
7. 最终 R8 验收尚未完成；本报告不替代指定全套两轮运行、三域最终 APPROVE、source/evidence 哈希独立复核和最终 Git 状态。
