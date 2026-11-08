# Sparkii Desktop 自动升级实现 —— 独立只读审核报告

> 审核日期：2026-11-08 ｜ 审核者：独立审核 Agent（只读）｜ 盘态 HEAD：`1756670`
> 基准：`2026-11-06-auto-update-design.md`（v3 + §0.7 修订 + §5.2.1 定案 A）。契约 §10 与 implementation-review 只当线索，不采信其结论。
> 约束遵守：除本报告外未创建/修改/删除任何仓库文件；未改产品代码做变异实验；未跑 `dist`；未动真实安装目录与真实 `data\`；未 commit/push。全部结论来自我自己读到的代码与我自己跑出的输出。
> **重要更正**：本报告初稿曾判「有条件通过／无 Blocker」。派出的只读子审核 C 读了**真实 NSIS 模板**后发现安装握手在生产路径断裂；我已逐一对照模板与源码自行复验（证据见 §4 B1/M1/M2），据此**改判不通过**。初稿漏判的根因与 23 轮自审相同：安装链路只用假 `.mjs` 安装器测过，从未读真实 NSIS 的 `CHECK_APP_RUNNING` 宏——这正是提示词 §5 警告的共识性盲区。

---

## 1. 结论与判级理由

**结论：不通过。**

- 存在 **1 条 Blocker（B1）**：静默安装时 NSIS 的 `CHECK_APP_RUNNING` 会把 watchdog 当作「正在运行的应用」杀掉（watchdog 以 `$INSTDIR\Sparkii.exe` + `ELECTRON_RUN_AS_NODE` 运行、且阻塞等待安装器退出），导致 `install-result.json` 永不写入、安装结果协议失效。我从真实模板 `allowOnlyOneInstallerInstance.nsh:105-164` + `installSection.nsh:33` + `installer.ts:991/996` 自行静态确认（真机复核列为修复后必跑项）。
- 另有 **4 条 Major**：M1 无 `--force-run` ⇒ 静默装完不自动重启（B-gate ②）；M2 旧卸载器在 `customInstall` 前无条件删标记+运行时 ⇒ 每次升级重解压（B-gate ⑥）；M3 `supervisor.stop()` 不等待子进程退出（B-gate ⑤）；M4 安装最后一公里 TOCTOU（验签后不持句柄、watchdog 不重哈希）。**11 条 Minor**。
- B1/M1/M2 同时击穿 §9 B-gate ②④⑥——自动升级的**生产安装握手根本跑不通**，不是可发布后慢慢补的缺口，故判不通过。
- 信任链本身（B 维 Ⅰ–Ⅹ、fail closed、无第二网络入口、服务器不产出 latest.yml、IPC 重验签、危险开关恒真、无密钥/IP 入库）经我独立核对**仍然成立**；全量套件我自己连跑两次 `2137 passed | 3 skipped`、0 failed、数字一致。但**测试全绿掩盖了 B1/M1/M2**（假安装器测试缝，见 §6），不能据此判通过。
- 产物层与真机层当前「未验证」（out/ 旧盘态、真机 M 清单需隔离 VM），叠加 B1 ⇒ 不具备发布条件。

---

## 2. 改动清单核对表（当前盘态 69 项）

**规模核对（我自己跑的 `git status --porcelain`）**：`29 M + 39 ?? + 1 D = 69`，staged = 0，HEAD = `1756670`。
**与提示词 §2 的「68 项」不一致**：第 39 个 `??` 是 `docs/superpowers/specs/2026-11-07-independent-audit-prompt.md`——**本审核任务自身的提示词文件**，不属于实现改动。扣除它即 68 项实现改动，与提示词一致。`.workbuddy/` 已在提示词的 38 项基线内。

| # | 盘态 | 文件 | 符合设计 | 可解释 | 备注 |
|---|---|---|---|---|---|
| 1 | M | `.gitignore` | 部分 | ✓ | 覆盖 out//*.key/*.private.pem/.sparkii-release-keys//*.sig/.codex-handoff/；**缺 `.workbuddy/`**（m1，`git check-ignore` 实测 NOT_IGNORED） |
| 2 | M | `PRODUCT.md` | ✓ | ✓ | :9 NSIS+L2 订正，无 MSIX |
| 3 | M | `README.en.md` | ✓ | ✓ | :155 订正 |
| 4 | M | `README.md` | ✓ | ✓ | :154-158 订正 |
| 5 | M | `apps/desktop/build/installer.nsh` | 部分 | ✓ | 宏纯 ASCII（实测 0 非 ASCII）；但 **customUnInstall 无 isUpdated 守卫 ⇒ M2**；无 customCheckAppRunning ⇒ **B1** |
| 6 | M | `electron/main/document-parse-quit.ts` | ✓ | ✓ | 靠 isUpdating 放行 |
| 7 | M | `electron/main/index.ts` | ✓ | ✓ | 单实例锁 whenReady 前(:53-54)、失败 app.exit(0)；3s 兜底(:140)；documentParse 钩子(:218) |
| 8 | M | `electron/main/ipc.ts` | ✓ | ✓ | 12 handlers(:2258-2302)；versionOpts choke point(:2262)；fail-closed |
| 9 | M | `electron/main/settings.ts` | ✓ | ✓ | update settings 字段 |
| 10 | M | `electron/preload/api-types.ts` | ✓ | ✓ | 三层契约类型 |
| 11 | M | `electron/preload/api.ts` | ✓ | ✓ | 三层暴露 |
| 12 | M | `native/windows-sandbox/bin/HostShellRunner.exe` | ✗ | 需还原 | **构建副产物**，非更新设计；建议还原 HEAD（§5-6） |
| 13 | M | `native/windows-sandbox/bin/SandboxProbe.exe` | ✗ | 需还原 | 同上 |
| 14 | M | `native/windows-sandbox/bin/SparkiiSandbox.exe` | ✗ | 需还原 | 同上 |
| 15 | M | `apps/desktop/package.json` | ✓ | ✓ | electron-updater "6.3.0"(:42)；dist 加 --config(:28) |
| 16 | M | `src/App.tsx` | ✓ | ✓ | 更新 UI 装配；启动零网络(:300-308) |
| 17 | M | `src/shell/SettingsView.tsx` | ✓ | ✓ | 设置页三入口 |
| 18 | M | `src/shell/Shell.tsx` | ✓ | ✓ | 状态栏 pill 集成 |
| 19 | M | `test/document-parse-quit.test.ts` | ✓ | ✓ | isUpdating 放行断言 |
| 20 | M | `test/preload-api.test.ts` | ✓ | ✓ | 精确断言同步更新 |
| 21 | M | `test/release-config.test.ts` | ✓ | ✓ | I-45 恒实跑 fallback(:66-75) |
| 22 | M | `docs/deploy.md` | ✓ | ✓ | :12/:41 自动更新入范围 |
| 23 | M | `docs/release-windows.md` | ✓ | ✓ | :5 NSIS+L2，无 MSIX |
| 24 | M | `docs/superpowers/plans/2026-10-23-windows-internal-release.md` | ✓ | ✓ | :475-478 旧文保留 + superseding note |
| 25 | M | `packages/agent-host/src/pi-runtime-pool.ts` | 部分 | ✓ | 复用 stopAll()+stopped 闸门；**acquire 闸门 TOCTOU m9**；stop 不等待 ⇒ M3（在 supervisor） |
| 26 | M | `packages/approval/src/gate.ts` | 部分 | ✓ | 逐条 expire+审计；**submit 无 quitting 闸门 m10** |
| 27 | M | `packages/ui/src/patterns/Shell.tsx` | ✓ | ✓ | 状态栏集成 |
| 28 | M | `packages/ui/src/patterns/StatusBar.tsx` | ✓ | ✓ | pill+小进度条，不弹窗不抢焦点 |
| 29 | M | `pnpm-lock.yaml` | ✓ | ✓ | electron-updater@6.3.0 锁定(:1585/:4772) |
| 30 | D | `apps/desktop/electron-builder.yml` | ✓ | ✓ | 按设计删除；替代载体 electron-builder.config.mjs |
| 31 | ?? | `.workbuddy/` | ✗ | ✓ | 项目数据目录，不该进版本库；.gitignore 未盖（m1） |
| 32 | ?? | `apps/desktop/electron-builder.config.mjs` | ✓ | ✓ | 唯一构建载体；占位 URL(:15)；verifyUpdateCodeSignature:false(:50)；watchdog extraResources(:43)；oneClick/perMachine:false |
| 33 | ?? | `electron/main/shutdown.ts` | 部分 | ✓ | §7.7 顺序写死；**abort 先于 stopPool ⇒ m10 窗口** |
| 34 | ?? | `electron/main/update-bootstrap.ts` | ✓ | ✓ | 装配+调度；m4/m5/m6 调度 Minor |
| 35 | ?? | `electron/main/update/`（15 模块） | 部分 | ✓ | §7.1 模块划分+合理拆分；**M4 在 installer/downloader；m8 在 snapshot；m11 在 installer prune** |
| 36 | ?? | `scripts/build-main.mjs` | ✓ | ✓ | define 注入(:38-41)；空 keys 抛错(:29-36)；未注入 fail-closed |
| 37 | ?? | `scripts/publish-release.mjs` | 部分 | ✓ | 本地落盘顺序正确(:215-232)；**无 SSH 上传/远端回读 m3** |
| 38 | ?? | `scripts/release-keys.mjs` | ✓ | ✓ | homedir 默认(:39)；overwrite guard(:52-59) |
| 39 | ?? | `scripts/sign-release.mjs` | ✓ | ✓ | Ed25519 kid‖0x00‖sha256 |
| 40 | ?? | `scripts/update-source-template/` | ✓ | ✓ | 更新源模板 |
| 41 | ?? | `scripts/update-watchdog.mjs` | 部分 | ✓ | 等 PID 消失(:173-183)+单一写入；**被 NSIS 杀掉 B1**；**不重哈希 M4**；假安装器测试缝(:196) |
| 42 | ?? | `scripts/verify-release.mjs` | ✓ | ✓ | 验签工具 |
| 43 | ?? | `src/shell/SettingsUpdatePane.tsx` | ✓ | ✓ | 设置页更新面板 |
| 44 | ?? | `test/gate-expire.test.ts` | ✓ | ✓ | 审批门 expire |
| 45 | ?? | `test/publish-release.test.ts` | ✓ | ✓ | 发布顺序 |
| 46 | ?? | `test/shutdown-order.test.ts` | ✓ | ✓ | 关机顺序（9 tests 实跑绿；只断顺序，不测真实子进程退出） |
| 47 | ?? | `test/sign-release.test.ts` | ✓ | ✓ | 签名 |
| 48 | ?? | `test/update-artifacts.test.ts` | ✓ | ✓ | 产物断言；skipIf artifact；**时效性存疑**（out/ 旧，§7） |
| 49 | ?? | `test/update-bootstrap.test.ts` | ✓ | ✓ | 调度 |
| 50 | ?? | `test/update-config-keys.test.ts` | ✓ | ✓ | 公钥注入 fail-closed |
| 51 | ?? | `test/update-download-resume.test.ts` | ✓ | ✓ | 断点续传 |
| 52 | ?? | `test/update-ipc.test.ts` | ✓ | ✓ | IPC 门禁 |
| 53 | ?? | `test/update-service-settings.test.ts` | ✓ | ✓ | 设置 |
| 54 | ?? | `test/update-signature-parity.test.ts` | ✓ | ✓ | 签名一致性 |
| 55 | ?? | `test/update-state-mirror.test.ts` | ✓ | ✓ | DPAPI 镜像；**both-erased 未覆盖 m2** |
| 56 | ?? | `test/update-status-ui.test.tsx` | ✓ | ✓ | 状态 UI |
| 57 | ?? | `test/update-version-parity.test.ts` | ✓ | ✓ | 版本一致性 |
| 58 | ?? | `test/update-version-traversal.test.ts` | ✓ | ✓ | 版本遍历安全 |
| 59 | ?? | `test/update-watchdog.test.ts` | ✓ | ✓ | 9 tests 绿；**用假 .mjs 安装器，不跑 NSIS 宏 ⇒ B1/M1/M2 全盲** |
| 60 | ?? | `test/update/`（子目录） | ✓ | ✓ | 单元套件实跑绿 |
| 61 | ?? | `docs/operations/` | ✓ | ✓ | 运维文档 |
| 62 | ?? | `specs/2026-11-06-auto-update-design.md` | ✓ | ✓ | 权威基准 v3（§7.8 与 B-gate ⑥ 内部矛盾 ⇒ M2） |
| 63 | ?? | `specs/2026-11-06-auto-update-kickoff-prompt.md` | — | ✓ | 过程文档 |
| 64 | ?? | `specs/2026-11-06-handoff-prompt.md` | — | ✓ | 过程文档 |
| 65 | ?? | `specs/2026-11-06-implementation-review.md` | — | ✓ | 被审对象（自审记录，不采信） |
| 66 | ?? | `specs/2026-11-06-task0-results.md` | — | ✓ | 被审对象（线索；T0-5 假安装器缝） |
| 67 | ?? | `specs/2026-11-06-task0-scripts/` | — | ✓ | 过程产物 |
| 68 | ?? | `specs/2026-11-06-update-interfaces.md` | — | ✓ | 被审对象（契约 §6 钉死 /S 无 --updated/--force-run ⇒ B1/M1 设计侧缺口） |
| 69 | ?? | `specs/2026-11-07-independent-audit-prompt.md` | — | ✓ | **审核任务自身**（第 69 项，超出提示词 68） |

`update/` 15 模块实测：audit / config / decision / dirs / downloader / globals.d.ts / installer / local-artifacts / scheduler / service / snapshot / state-store / types / updater-adapter / verifier。dirs/snapshot/globals/shutdown/update-bootstrap 为合理拆分。

---

## 3. 六维逐项核对表

| 维度 | 结论 | 证据（文件:行号 / 命令输出） |
|---|---|---|
| **A 设计一致性** | 部分符合 | D1–D18 大体落地；模块/状态机/IPC 三层/UI 符合；调度 4 处 Minor（m4–m7）。**§7.8 与 §9 B-gate ⑥ 设计稿内部矛盾**（M2）；契约 §6 钉死的 /S 参数与真实 NSIS 行为冲突（B1/M1 设计侧缺口）。 |
| **B 安全/信任链** | 符合（1 Major + 2 Minor） | Ⅰ–Ⅹ 全链 verifier.ts:195-349；唯一元数据入口 :172/226/259；latest.yml 本地派生 :378、服务器不上传 publish-release.mjs:14/229/323；URL 绝对+origin 锁 :398-417；httpExecutor 先于 setFeedURL updater-adapter.ts:392→393、file:-only :148-161；download() 各闸 :167-318；IPC 重验 service.ts:928/1063；HMAC fail closed state-store.ts:140-148；sequence 严格相等 verifier.ts:291；flags 恒真 :389-391；6.3.0 锁定；publisherName 键缺席断言 release-config.test.ts:74-75。**M4** TOCTOU、**m2** both-erased、**m3** 发布 CLI 无远端。 |
| **C 生命周期/数据安全** | **不符合（1 Blocker + 3 Major）** | 关机顺序/三库 close/快照覆盖/目录解析/保留回滚保护**本身健全**（shutdown.ts:45-52、snapshot.ts:199/202-207、installer.ts:511-538/1237-1239）。**但生产安装握手断裂**：**B1** watchdog 被 NSIS `CHECK_APP_RUNNING` 杀（allowOnlyOneInstallerInstance.nsh:113/120/127 + installSection.nsh:33 + installer.ts:991/996）；**M1** 无 --force-run 静默不重启（installSection.nsh:94-97 + NsisTarget.js:579）；**M2** 旧卸载器先删标记+运行时（installSection.nsh:52→82 + uninstaller.nsh:156-157 + build/installer.nsh:62-72）；**M3** supervisor.stop() 不等退出（pi-runtime-supervisor.ts:211-216）。Minor m8/m9/m10/m11。 |
| **D 测试有效性** | 单元有效；**安装握手全盲** | 我自己两次全量 0 failed、数字一致；恒实跑 fallback 覆盖产物 skip；I-80 承重用例绿。**但 update-watchdog.test.ts 用假 .mjs 安装器（update-watchdog.mjs:196 asScript 分支），不执行任何 NSIS 宏 ⇒ B1/M1/M2 无任何用例能抓**（§6）。这是测试缝造成的共识性盲区。 |
| **E 产物/构建** | 配置符合；**产物层未验证** | 唯一载体 config.mjs、yml 已删、dist 加 --config；占位 URL、define 注入、公钥空表 fail closed。**out/ 旧盘态（11-07 18:24-18:26）不含 I-80…I-88/R22/R23 ⇒ 产物断言时效性存疑，发布前须重跑 dist**（§7）。 |
| **F 文档/契约同步** | 大体符合 | release-windows/deploy/README/PRODUCT/plan 均订正。**m2 注释分叉**（service.ts:140 vs update-bootstrap.ts:191）；**M2 设计稿内部矛盾**（§7.8 行 614 vs B-gate ⑥）需回写。 |

---

## 4. 缺陷清单（Blocker / Major / Minor）

### Blocker

**B1 — 静默安装时 NSIS `CHECK_APP_RUNNING` 杀掉 watchdog，安装结果协议失效。（生产路径，静态确认于真实模板）**
- 证据链（我逐一读过）：
  - `installer.ts:976-986` watchdog 透传给 NSIS 的参数只有 `/S /D=…`（**无 --updated、无 --force-run**）；`:991` env `ELECTRON_RUN_AS_NODE:'1'`、`:996` `spawnFn(deps.execPath ?? process.execPath, …)` ⇒ watchdog 进程镜像 = `$INSTDIR\Sparkii.exe`。
  - `installSection.nsh:14-33` ONE_CLICK 下 `:33 !insertmacro CHECK_APP_RUNNING` 在 `${IfNot} ${Silent}` 块（:18-32）**之外** ⇒ 静默也跑。
  - `allowOnlyOneInstallerInstance.nsh:106-107` 安装器自身镜像是 setup exe（在 data\updates\，非 Sparkii.exe）⇒ `$3 != APP_EXECUTABLE_FILENAME` 成立 ⇒ 进入检查；`:113 FIND_PROCESS` PowerShell 分支 `:66` 匹配 `Path.StartsWith('$INSTDIR')`、tasklist 分支 `:75` 匹配 `IMAGENAME eq Sparkii.exe` ⇒ **watchdog 命中**（它的 Path/IMAGENAME 正是 $INSTDIR\Sparkii.exe）。
  - `:114 $R0==0`（找到）⇒ `:120 MessageBox … /SD IDOK IDOK doStopProcess` 静默自动 OK ⇒ `:127 KILL_PROCESS`（PowerShell `:94` 杀所有 Path.StartsWith($INSTDIR) 的进程，**不排除当前 PID**；taskkill `:99` 排除的是安装器 PID 而非 watchdog）⇒ **watchdog 被杀**。
  - watchdog 此刻正阻塞等安装器退出（update-watchdog.mjs:201 spawn 后 await child exit）⇒ 它死了就永不写 `install-result.json`（:220-228 只在 child exit 后写）。安装器自身镜像不在 $INSTDIR ⇒ 存活、继续装完，但**结果协议死**。
- 违反：§7.7 步骤 7.4（watchdog 单一写入结果）+ §9 B-gate ④（watchdog 须能上报安装失败）。叠加 M1 ⇒ B-gate ② 也死。
- 为什么 `--updated` 救不了：`:115-118` isUpdated=true 也只是 Sleep 1000 后 `Goto doStopProcess`，照样 KILL_PROCESS。electron-updater 标准流程不踩此坑是因为 app 先退出、安装器跑时**没有**活的 Sparkii.exe；本设计的 watchdog 偏偏以 Sparkii.exe 活着等结果 ⇒ 必被匹配。
- 测试为何没抓：T0-5/update-watchdog.test.ts 用假 `.mjs` 安装器（:196 asScript），从不执行 NSIS 宏 ⇒ 9 条断言全绿但生产路径未 exercised。
- 最小修法：定义 `customCheckAppRunning` 豁免 watchdog PID（经哨兵/标志传入）同时仍杀 stray 进程；或把 watchdog 拷成 $INSTDIR 之外、不同镜像名的 exe 运行。**修复后必须真机确认**。
- 归因备注：契约 §6 钉死 /S 参数、设计 §7.7 选 watchdog 模式但未考虑 NSIS app-running 检查 ⇒ 含设计侧缺口；按审核 §1 记录设计问题，但生产断裂这一事实仍判 Blocker。

### Major

**M1 — 无 `--force-run` ⇒ 静默 oneClick 装完不自动重启。** `installer.ts:983-985` 透传仅 `/S /D=`；`installSection.nsh:93-97` RUN_AFTER_FINISH 下重启条件 `${ifNot} ${Silent} ${orIf} ${isForceRun}`，静默时前者 false ⇒ 需 isForceRun；`NsisTarget.js:579` isForceRun 仅由 `--force-run` 置位（缺席）⇒ 不重启。违反 §9 B-gate ②。最小修法：透传补 `--force-run`（并 `--updated`）。

**M2 — 旧卸载器在 customInstall 前无条件删标记+运行时 ⇒ 每次升级重解压。** `installSection.nsh:52 uninstallOldVersion` 先于 `:82 customInstall`；`installUtil.nsh:206/224` 旧卸载器带 `--updated` 跑；`uninstaller.nsh:156-157` 无条件插入 customUnInstall（无 isUpdated 守卫）；`build/installer.nsh:62-72` customUnInstall 无条件 `RMDir /r portable-git/document-parse`(:63-64) + `Delete marker`(:68) ⇒ customInstall(:20-24) 读不到标记 ⇒ 走 sparkii_runtime_deploy 重解压。违反 §9 B-gate ⑥。**设计稿内部矛盾**：§7.8 行 614 要求 customUnInstall 删标记，B-gate ⑥ 要求升级跳过——两者经 uninstallOldVersion 顺序冲突。最小修法：customUnInstall 的运行时+标记清理加 `${ifNot} ${isUpdated}` 守卫（升级时旧卸载器收到 --updated ⇒ 跳过；完整卸载仍清理）；并回写设计稿消除矛盾。

**M3 — `supervisor.stop()` 不等待子进程退出。** `pi-runtime-supervisor.ts:211-216` `stop()` 只 `handle?.kill()` + `client?.close()` + 置空引用，**不 await onExit**；`transports.ts:25` kill=()=>child.kill() 即发即忘；`pi-runtime-pool.ts:257-266` stopAll() await stop() 立即 resolve。⇒ 关机进到快照/退出时子进程可能仍持 SQLite WAL/文件句柄。违反 §7.7 步骤 3（行 586「等待所有 Agent 会话结束」）+ §9 B-gate ⑤。当前被 NSIS KILL_PROCESS 掩盖——但那同时杀 watchdog（B1）且只匹配 $INSTDIR 镜像、不匹配 data\pi-agent\bin 的 fork 子进程。最小修法：stop() 在 kill() 后 await onExit（带超时）。

**M4 — 安装最后一公里 TOCTOU：验签后不持句柄，watchdog 按路径执行且不重哈希。** `service.ts:1079` 传路径串 → `installer.ts:879 verifyArtifactBytes` → `downloader.ts:76 createReadStream` 读完即关（installer.ts 全文无 openSync/持句柄，我 grep 确认）→ `installer.ts:982` spawn watchdog 传 `--installer <path>` → `update-watchdog.mjs:166` 仅 `existsSync`、`:201` spawn 执行该路径任意字节（不 import crypto）。违反 §7.3 行 525「持有句柄直到交给安装器」+ §0.4 不变量 4。可利用性低（需同用户本地替换 pending/ 字节；网络 MITM 已被信任链覆盖；IPC 入口确实重验签 service.ts:1063）。最小修法：watchdog spawn 前重算 sha512+bytes 比对 sentinel.packageSha512，不符 abort。

### Minor

- **m1** `.workbuddy/` 未 gitignore（`git check-ignore` NOT_IGNORED），会被误提交。修：.gitignore 增 `.workbuddy/`。
- **m2** 防回滚下限「双锚点同删」静默清零 + 注释矛盾（共识盲区）。`service.ts:140` 注释「双删⇒显式报错」假；`:395 if(!m)return false` + `update-bootstrap.ts:202 raw==null⇒null` ⇒ 双删⇒首装 ALLOW；`:191` 注释才是真行为「允许」。违反 §6.3.4 行 432 意图，但属 mirror 机制固有局限（无第三锚点无法区分真首装/双删）；重放仍需有效签名+未过期 expiresAt(verifier.ts:302)+用户级删两锚点 ⇒ 边界低。修：改正 :140 注释、§6.3.4 登记局限；决策者拍板是否需抗删第三锚点。
- **m3** 发布 CLI 只本地落盘（publish-release.mjs:239-241），无 SSH 上传/远端回读（§8.1 行 650、§8.2 步骤 4-6 未实现）；本地顺序正确；非信任链断裂（客户端 fail closed 覆盖）。修：实现上传+回读，或写明人工规程并订正 §8.2/文件头。
- **m4** 启动首检恒 ~105s 零散布：`scheduler.ts:49 jitterDelay=base×(0.85..1.15)`；`update-bootstrap.ts:531 spread∈[76.5,103.5]s`、`:530 gateUpper=105s`、`:532 Math.max` ⇒ 恒 105；`:529` 注释数学不成立。违反 §7.10 行 632 散布意图。低影响。
- **m5** 周期抖动 ±15% of 1h（±9min）而非 ±15% of 周期：`update-bootstrap.ts:475 jitterDelay(seed,3600)-3600`。违反 §7.10 行 634。低影响。
- **m6** 「连续 7 轮」≠「7 天」降级：`update-bootstrap.ts:411` 计轮次、退避 [30s,5min,30min,2h,12h,24h] ⇒ 7 轮≈2.66 天。违反 §7.10 行 636（实施方 :414-416 自述选轮次，口径未回写设计）。低影响。
- **m7** 缺 If-None-Match：全 update/ grep 零命中；§7.10 行 640 要求（8s 超时已有）。带宽优化缺失。低影响。
- **m8** 快照先拷贝后哈希**源文件**：`snapshot.ts:223 copy(f.absPath,dst)`、`:225 hashFileSha256(f.absPath)`（哈希源非 dst）⇒ 拷贝与哈希之间源被改则清单哈希≠拷贝字节（恢复时 fail-safe 拒绝，但快照内部不一致）；walk 之后新建的文件漏掉。违反 §7.8 一致快照。修：哈希 dst 或 walk 前冻结写者。
- **m9** `acquire()` stopped 闸门 TOCTOU：`pi-runtime-pool.ts:111` 入口查 stopped、`:116 await start()`、`:126 push` 无复检 ⇒ stopAll 在 await 期间置 stopped 后仍可起新 agent。违反 §0.7 P0-1。修：start() 后复检 stopped，若已停则停新 supervisor 并 throw。
- **m10** 审批重提交竞态：`gate.ts:30 submit()` 无 quitting 闸门；`shutdown.ts:45-52` abortPendingApprovals 先于 stopPool ⇒ 窗口内 agents 仍活、submit 可逃出 expire+审计。违反 §7.7 步骤 2（设计继承顺序）。修：submit 加 closed/quitting 标志，或 stopPool 后再 abort 一次。
- **m11** 无 `data/updates/` 总字节上限：`installer.ts` prune 仅按**数量**（keep 当前版本包 :1253、keep N 快照 :1322-1338），无字节累计；且只在成功后跑 ⇒ 反复失败安装无限累积。违反 §7.9 行 626「总容量上限（如 1.5× 包体）」。修：累计 pending+snapshots 字节，超限驱逐最旧非保护项。

> 三个 native .exe（#12-14）为构建副产物，建议提交前还原 HEAD（§5-6），非更新链路缺陷。m4–m7 低影响，不列发布阻塞最小集合。

---

## 5. §5 残留项与自审闭合复核结论

### 8 项残留

| # | 实施方口径 | 我的独立结论 |
|---|---|---|
| 1 | A⑦「部分达成」sandbox-spike ACL 环境项 | 我两次全量该用例 8 tests 实跑通过、0 failed（run1/run2 :113/:114 ✓）；更新链不触发 ACL（grep 确认）。在我盘态不构成红项；环境敏感，发布机需复核（进 M 清单）。 |
| 2 | --maxWorkers=4 取数 | 我**未降并发**，仓库根默认并发两次 0 failed、数字一致 ⇒ 非判据弱化；实施方所述 worker 超时在我空闲机未复现。 |
| 3 | out/ 旧盘态不含 I-80…I-88 | 属实。恒实跑 fallback 只替代配置/派生侧，**不能替代真实 built app-update.yml**（update-artifacts.test.ts:154 skipIf 读旧产物）⇒ 产物层「未验证」，发布前独占重跑 dist。 |
| 4 | skip 3↔4 = skipIf(!existsSync(appUpdateYmlPath)) | 成立：我盘态 out/ 存在 ⇒ update-artifacts 实跑 11 tests、skip=3（document-parse-python `!hasPython` + ontology-e2e `!hasGate`，均环境门、与更新无关）。发布机无 out/ ⇒ skip=4，真实产物断言仍缺。 |
| 5 | installer.ts 曾占位、G7b 接续 | **Electron 侧完整**（再验 :879、目录解析+anchor :894/527/535、fail closed :900、哨兵、watchdog 定位/回收 :963-967、单一写入 :667）；**但 NSIS 握手断裂**（B1/M1/M2）——「完整实现」只在 Electron 侧成立，生产安装路径未通。M4 句柄缺口亦在。 |
| 6 | 三个 native .exe 被改 | 构建副产物（dist 就地重编），与更新无关；建议提交前还原 HEAD。非 Blocker。 |
| 7 | ?? .workbuddy/ | 属实（NOT_IGNORED）= m1。 |
| 8 | R10 派发失败重派 R13 | 架构线我以自己读码为准。本轮派 A/B/C 三只读子审核：A（调度）B（安全）C（生命周期）均返回，**其承重证据我已逐一对照盘态/模板复验**（尤其 C 的 B1/M1/M2/M3 我读了真实 NSIS 模板与 supervisor 源码自行确认）。 |

### R22 六条 Major 闭合

| 条目 | 结论 |
|---|---|
| state-store 悬空 junction 误判 absent | 真修：state-store.ts:179 statSync 父探 + :188 lstatSync；非 ENOENT⇒第三态(:207-218)；I-80 用例 state-store.test.ts:60-85 绿。 |
| service clearDownloaded/cancelDownload 第三态出口 | 真修：refuseUnreadableState 早退（:1150 等）；第三态每次重读(:159)。 |
| decision/installer 版本比较 semver | 真修：installer.ts:1253 compareVersions（build 不参与）。 |
| enforceFloorFromMirror readFailureCode 闸门 | 真修：state-store.ts:267 抛 UnreadableStateError；service.ts:402-407 重建失败⇒拒绝。 |
| GATE_SUPPRESSED 移除不可达项 | 真修：update-bootstrap.ts:405-408 只留 STATE_WRITE_FAILED；STATE_TAMPERED 仍计入(:401-403)。 |
| 文档计数校正 | 部分：m2 新暴露 service.ts:140 vs :191 分叉需再收敛。 |

### R15c 六处文档分叉

大部分收敛（F 维核过）；**未收敛**：m2 防回滚双删行为两处注释矛盾；**新增 M2 设计稿内部矛盾**（§7.8 行 614 vs B-gate ⑥）需回写。

### R23 三条「不通过」理由

| 理由 | 我的判断 |
|---|---|
| out/ 未重编 | 发布阻塞（产物层未验证）；只读阶段不重跑 dist 可接受（会就地重编三 exe），发布前必须独占重跑。 |
| 真机/真实 IO 未验证 | 发布阻塞；**本轮静态已确认 B1/M1/M2 生产断裂 ⇒ 真机验证不再是「补充」而是「修复后必跑」**。 |
| 全量唯一红项「部分达成」 | 该红项在我盘态未复现（两次 0 failed）；但**全绿掩盖了 B1/M1/M2**（假安装器缝）⇒ 「全量绿」不能作通过证据。 |

---

## 6. 测试有效性抽样（5 条 × 能否抓住错）

| 用例 | 改坏会不会红 | 依据 |
|---|---|---|
| 验签拒绝 verifier.test.ts（22 绿） | **会红** | 断言绑定 fail() 具体 reason + update.verify-failed 审计；verifier.ts:63-65 空表⇒拒绝、:198-201 每失败写审计。非 toBeDefined。 |
| sequence 回退 state-store/verifier | **会红** | service.ts:358/372 isTampered()?MAX_SAFE_INTEGER:lastSeenSequence()⇒SEQUENCE_REGRESSION；state-store.ts:336 回退守卫。 |
| nonce 换值 verifier（Ⅶ） | **会红** | verifier.ts:311-313 同 seq 换 nonce⇒拒绝，断言绑定该格。 |
| IPC 门禁 update-ipc.test.ts | **会红（重验签）/ 不会红（持句柄）** | service.ts:1063 verifyCompanion 校 signature/sha512/sequence/nonce/expiresAt；删重验⇒篡改包用例红。但 M4「持句柄到安装器」无承重用例。 |
| **watchdog 单一写入 update-watchdog.test.ts（9 绿）** | **不会红 B1/M1/M2** | **关键盲区**：用假 `.mjs` 安装器（update-watchdog.mjs:196 asScript 分支），从不执行 NSIS `CHECK_APP_RUNNING`/`uninstallOldVersion`/`customInstall` 宏。把 watchdog 改成「会被 NSIS 杀」、把透传改成「无 --force-run」、把 customUnInstall 改成「升级也删标记」——**这 9 条断言一条都不红**。单一写入断言（installer.ts:667 writer==='watchdog'）只测 Electron 侧约定，测不到生产握手。 |

**结论**：单元/信任链测试有效；**安装握手（B1/M1/M2）处于测试盲区**，假安装器缝使生产 NSIS 路径完全未被覆盖。这正是 23 轮自审 + 我初稿共同漏判的根因。弱断言扫描：承重单元用例未见仅 toBeDefined/吞断言/漏 await；但「测试缝覆盖不到生产路径」是比弱断言更严重的有效性缺陷。

---

## 7. 未验证项与风险

1. **B1/M1/M2 真机确认（静态已确认，真机待跑）**：我已读真实 NSIS 模板（app-builder-lib@26.15.3）静态确认 kill/relaunch/marker 路径；但**真实 `/S` 下 watchdog 镜像是否被匹配并杀、kill 时序、UAC/SmartScreen** 需隔离 VM 确认（§0 禁真装）。静态路径无歧义，真机是修复后必跑项而非「可能没问题」。
2. **产物层（未验证）**：out/ 旧盘态（11-07 18:24-18:26）不含 I-80…I-88/R22/R23；真实 built app-update.yml publisherName 缺席、bytes/sha256、派生 feed 时效性存疑。我没跑 dist（§0 禁 + 就地重编三 exe）。发布前独占重跑重取。
3. **真机 M 清单（未验证）**：/S 无 UAC、MOTW/SmartScreen、安装目录锚定（本机 InstallLocation 空、UninstallString 在 D:\software\SparkiiPi）、watchdog PID-wait、真实 NSIS install-result 单一写入、断电恢复、data\ 快照还原。需隔离 VM。
4. **DPAPI keyring 删除语义（m2）**：从 update-bootstrap.ts:202 推演 null-on-absent，未探活机。
5. **远端 SSH 上传+回读（m3）**：不在仓内，无法确认服务端真跑。
6. **Pi 子进程镜像位置（M3 备注）**：utilityProcess（$INSTDIR）vs fork（data\pi-agent\bin）决定 NSIS KILL_PROCESS 能否清掉它们；未真机确认。
7. **M4 真实可利用性**：需同用户本地写 pending/ 现场实验（§0 禁变异），静态判低可利用性。

**共识性盲区命中（两处）**：① B1/M1/M2——假安装器测试缝 + 23 轮自审从未读真实 NSIS app-running 模板，「安装链路完整」被反复继承成已确认；② m2——service.ts:140「双删显式报错」被当成已确认，代码与 :191 做相反行为。本轮均戳穿。

---

## 8. 不通过 —— 修复后重新送审前必须闭合的最小集合

**第一优先（生产安装握手，Blocker/Major，修复后必须真机验证）：**
1. **B1**：定义 `customCheckAppRunning` 豁免 watchdog PID（仍杀 stray），或把 watchdog 拷成 $INSTDIR 外、不同镜像名运行；真机确认 watchdog 不被杀、install-result.json 真写入。
2. **M1**：透传补 `--force-run`（+`--updated`）；真机确认静默装完自动重启。
3. **M2**：customUnInstall 运行时+标记清理加 `${ifNot} ${isUpdated}` 守卫；回写设计稿消除 §7.8 vs B-gate ⑥ 矛盾；真机确认升级不重解压未变更运行时。
4. **M3**：supervisor.stop() kill 后 await onExit（带超时）；验证关机后无残留子进程、快照前句柄已释放。
5. **M4**：watchdog spawn 前重哈希比对 sentinel.packageSha512+bytes，不符 abort；补承重用例。
6. **补真实 NSIS 集成测试**：至少一条真机/真实模板用例覆盖 B1/M1/M2，消除假安装器缝盲区（否则同类回归仍全绿）。

**第二优先（发布前验证与卫生）：**
7. 当前盘态独占重跑 `dist`（隔离环境），重取全部产物断言；在此之前产物层记「未验证」。
8. 隔离 VM 跑真机 M 清单（含 A⑦ sandbox-spike 发布机环境复核、B1/M1/M2 修复验证）。
9. 提交前：.gitignore 增 `.workbuddy/`（m1）；三个 native .exe 还原 HEAD。
10. m2：改正 service.ts:140 假注释、§6.3.4 登记双删局限；决策者拍板第三锚点。
11. m3：发布 CLI 上传+远端回读就位（或写明人工规程并订正 §8.2/文件头）。

> m4–m11 中 m8–m11（快照哈希源/acquire 闸门/审批竞态/字节上限）建议随本轮一并修（均为数据安全相关）；m4–m7 低影响调度/带宽缺口可发布后闭合。此处不夹带其它优化建议。

---

### 附：我自己跑出的取数（非引用实施方）

- `git status --porcelain`：29 M + 39 ?? + 1 D = 69；staged 0；HEAD 1756670。
- `pnpm typecheck`：RC=0（packages/ui + apps/desktop Done）。
- `pnpm lint`：RC=0，0 errors / 20 warnings（全存量 unused-vars，含 3 条 out/ 副本）。
- `pnpm test`（仓库根、默认并发、空闲机）run1：`245 passed | 2 skipped (247)` 文件 / `2137 passed | 3 skipped (2140)` 用例 / 0 failed / 118.07s；run2 同数字 / 0 failed / 119.72s。两次一致。
- sandbox-spike：run1/run2 均 `✓ (8 tests)` 实跑通过；实施方所述 ACL 红项未复现。
- 3 个 skip：document-parse-python.test.ts:45 `it.skipIf(!hasPython)`、ontology-e2e.test.ts:34 `describe.skipIf(!hasGate)`（环境门、与更新无关）。
- `git check-ignore .workbuddy/`：NOT_IGNORED。
- NSIS 模板（我自己读）：installSection.nsh:33/52/82/94-97；allowOnlyOneInstallerInstance.nsh:66/75/94/99/106-127；uninstaller.nsh:156-157；installUtil.nsh:206/224；NsisTarget.js:579；build/installer.nsh:20-24/62-72（纯 ASCII）。