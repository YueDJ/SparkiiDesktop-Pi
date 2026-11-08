# Sparkii Desktop 自动升级 —— 缺陷修复计划（送架构师评审稿 · R2 修订）

> 日期：2026-11-08 ｜ 依据：`2026-11-07-independent-audit.md`（结论**不通过**：1 Blocker + 4 Major + 11 Minor）
> 尺子：`2026-11-06-auto-update-design.md`（v3+§0.7+定案 A）、`2026-11-06-update-interfaces.md` §6。
> 状态：**计划稿，未动任何产品代码**。流程＝本计划 → 架构师评审 → 向决策者汇报 → 拍板后才实施。
> 硬边界（沿用审核期约束）：不写私钥/真实 IP/token 入仓；不动真实 `%LOCALAPPDATA%\SparkiiDesktop\data` 与真实安装目录；真机验证一律隔离 VM；不 git commit/push（除非单独放行）；不伪造测试输出；不削弱既有门禁。
>
> **R2 修订说明**：R1 稿经两位架构师评审（A＝不通过、B＝有条件通过）。本稿逐条对盘核实并改正了评审指出的事实错误，核心变更：
> - **B1 改推方案 B（独立镜像小 exe）为主**：R1 推荐的方案 A 经对盘**根本不成立**——遗漏第二个确定 kill 点（旧卸载器 `un.checkAppRunning`），且 PID 豁免通道无法送达旧卸载器，更与 `un.atomicRMDir` 的文件占用直接冲突。方案 B 才是设计 §7.7:591 对齐解；R1 把 B 贬为兜底并夸大其体积成本（「百 MB 翻倍」），本稿更正。
> - **M1** 引文 `installSection.nsh:126`（不存在）→ `common.nsh:125-126`。
> - **M3** 删除两条静态可证伪的风险注（「fork 子进程镜像在 `data\pi-agent\bin`」「持 SQLite WAL」）；补 `onExit` 句柄同一性守卫；澄清 3s 兜底作用于 `quitApp` 而非 `stopAll`。
> - **M4** 哨兵**无 bytes 字段**（installer.ts:186-204），仅比对 `packageSha512`；「可达成等价」降级为「收窄窗口＋登记残余竞态」。
> - **m4** 复用闸门的**加性**抖动（service.ts:801，±9s/base60），保「排期≥闸门阈值」不变量；订正 bootstrap:424/:529 错注释。
> - **m3** 文档订正本轮做（不被待拍决策门控）；**m9** 复检提到 `offEvent` 注册之前；**m11** 术语 `backups`→`snapshots`、澄清与「哨兵在场⇒不清 pending」不变量的交互。
> - **决策定稿（§10）**：B1 载体＝Node SEA、m6＝改代码对齐 7 天、m2/m3 本轮只登记/订正文档（实现另拍）、M2 载体＝`RUNTIME_VERSION` 常量、m11 上限＝1.5× 包体、m5/m7 发布后。

---

## 0. 范围与分层

修复对象＝审核报告 §4 全部缺陷。按「是否阻断生产安装握手 / 是否数据安全 / 是否低影响」分层：

| 层 | 缺陷 | 性质 | 处置 |
|---|---|---|---|
| **T0 阻断** | B1 | 静默安装 watchdog 被 NSIS 杀（**两个** kill 点）＋文件占用撞 atomicRMDir，结果协议死 | 必修，最先，真机验证 |
| **T1 生产安装** | M1 / M2 / M3 / M4 | 不自动重启 / 升级重解压 / 子进程未等退出 / 最后一公里 TOCTOU | 必修，真机验证 |
| **T2 数据安全** | m8 / m9 / m10 / m11 | 快照哈希源 / acquire 闸门 / 审批竞态 / 无字节上限 | 本轮一并修 |
| **T3 卫生与安全文档** | m1 / m2 / m3 | .workbuddy / 防回滚双删注释 / 发布 CLI 无远端 | 本轮修（m2/m3 决策已定 §10：本轮只订正文档/登记局限，实现另拍） |
| **T4 低影响** | m4 / m5 / m6 / m7 | 启动散布 / 周期幅度 / 7轮vs7天 / If-None-Match | 本轮修 m4（正确性）＋m6（已定改代码对齐 7 天）；m5/m7 列发布后 |
| 交付卫生 | 3 native .exe | 构建副产物 | 提交前还原 HEAD |

---

## 1. T0 / T1 逐项修复

### B1 — watchdog 被 NSIS 杀＋文件占用撞 atomicRMDir（Blocker）

**根因（已对盘确认，两个 kill 点＋一个文件锁）**：

watchdog 现以 `$INSTDIR\Sparkii.exe`＋`ELECTRON_RUN_AS_NODE` 运行（installer.ts:991 env、:996 `spawnFn(process.execPath)`），阻塞等安装器退出并单一写 `install-result.json`（update-watchdog.mjs:220-228）。NSIS 在升级链路上有**两处**会杀「正在运行的应用」：

1. **第一 kill 点（新安装器）**：oneClick 静默也跑 `CHECK_APP_RUNNING`（installSection.nsh:33）→ `_CHECK_APP_RUNNING`（allowOnlyOneInstallerInstance.nsh:105-164）按镜像名/路径匹配并 KILL（:113 FIND、:120 MessageBox `/SD IDOK`、:127 KILL）。`--updated` 救不了（:115-118 仍走到 `doStopProcess`）。
2. **第二 kill 点（旧卸载器）**：`uninstallOldVersion`（installSection.nsh:52，**先于** :82 customInstall）以 `/S` 跑旧卸载器（installUtil.nsh:224/230 `ExecWait '"…old-uninstaller.exe" /S /KEEP_APP_DATA $0 _?=$installationDir'`）；旧卸载器 `un.onInit` 在静默下 `call un.checkAppRunning`（uninstaller.nsh:18-19）→ 同一个 `CHECK_APP_RUNNING` ⇒ **照样杀 watchdog**。
3. **文件锁冲突**：即便豁免了 kill，watchdog 仍持有 `$INSTDIR\Sparkii.exe` 镜像句柄；旧卸载器升级分支 `un.atomicRMDir`（uninstaller.nsh:164-182）对每个文件 `Rename` 到 `$PLUGINSDIR\old-install`，遇占用 `IfErrors`⇒`Abort`（:176-179）⇒ **升级失败**。设计 §7.7:596 明文承认「应用 exe 仍在运行会撞 Windows 文件占用」。

**为什么 R1 的方案 A（`customCheckAppRunning` 豁免 watchdog PID）根本不成立**：
- **PID 通道送不到第二 kill 点**：installUtil.nsh:224/230 的 `ExecWait` 命令行是**硬编码**的，`$0` 只追加 `--updated`/`--keep-shortcuts`/`--delete-app-data`（:198/:203/:206），**不转发**新安装器收到的 `/WATCHDOG_PID=`。故首次「从当前坏版本升级到修复版」时，旧卸载器（坏版本编译）拿不到 watchdog PID，方案 A 在第二 kill 点失效。
- **文件锁无解**：方案 A 让 watchdog 继续以 `Sparkii.exe` 镜像存活，必然撞 `un.atomicRMDir` 的 Rename（根因 3）。豁免 kill 不等于豁免文件占用。
- 结论：方案 A 不是完整解，**降级为「已否决」**，不再作为兜底。

**修法（方案 B，设计对齐，推荐）——watchdog 跑在独立镜像名、`$INSTDIR` 之外的载体上**：
- 依据：设计 §7.7:591 明文允许 watchdog 是「独立进程，**Node 脚本或随包附带的小 exe**」。把 watchdog 载体改为**镜像名 ≠ Sparkii.exe** 且**运行时路径在 `$INSTDIR` 之外**的小 exe，则：
  - 第一/第二 kill 点都不命中：PowerShell 分支按 `Path.StartsWith('$INSTDIR')`（allowOnlyOneInstallerInstance.nsh:66）、tasklist 分支按 `IMAGENAME eq Sparkii.exe`（:75）——独立镜像名＋`$INSTDIR` 外路径**两条都避开**。
  - 不锁 `$INSTDIR\Sparkii.exe` ⇒ `un.atomicRMDir` 的 Rename 成功 ⇒ 升级不 Abort。
- **载体选型（已定：(a) Node SEA，见 §10）**，体积成本更正（R1「百 MB 翻倍」夸大；R2 初稿的体积排序也错，本条一并更正）：
  - **(a) Node SEA（✔ 选定，保留 .mjs）**：用 Node 单可执行应用把现有 `update-watchdog.mjs` 逻辑**注入一份 node.exe 二进制副本**打成独立 exe（**不含 Chromium/Electron**）。SEA 成品是把 payload 嵌进 node 二进制 ⇒ 体积 **≥ 内嵌的 node.exe**，与 (b) **同量级**（数十至近百 MB），**不会**比 (b) 小；胜在不带散落的 .mjs/依赖、仍是已测脚本。
  - **(b) 改名 node.exe＋.mjs（最简）**：随包附带一份 node.exe（改名 `sparkii-watchdog.exe`），spawn 时 `node.exe update-watchdog.mjs …`。体积≈node 运行时（数十至近百 MB）。
  - **(c) 原生小 launcher（唯一个位数 MB 选项）**：Go/Rust 静态 exe（个位数 MB）原生重写 watchdog 逻辑。体积最小，但需重写＋重测 .mjs 等价逻辑，改动面最大。
  - 三者都**不是**「整份 Electron 二进制改名」——那才是 R1 误估的百 MB 翻倍来源。(a)(b) 同为 node 运行时量级、(c) 才小；选型是「node 运行时量级 vs 原生重写」的取舍，**不是体积大小排序**。
- **部署约束（必须写明，真机验）**：载体 exe 在 spawn 时**必须位于 `$INSTDIR` 之外**（如部署到 `runtime\` 或 `data\updates\`，二者均不在安装目录树下），否则 PowerShell 的 `Path.StartsWith('$INSTDIR')` 仍会命中。随包 resources 里的副本需在升级时拷出到 `$INSTDIR` 外再 spawn。
- **spawn 改动**：installer.ts:996 由 `spawnFn(process.execPath, [watchdog.mjs, …])` 改为 `spawnFn(<独立 exe 绝对路径>, […])`；SEA/原生载体不再需要 `ELECTRON_RUN_AS_NODE`（:991），改名 node.exe 载体则按 node 正常调用。哨兵已含 `watchdogPath`（installer.ts:199）描述载体。
- **签名**：载体 exe 应随 app 同证书签名，避免 SmartScreen/MOTW 拦截（真机验）。

**契约同步**：interfaces §6 行 351 钉死 `-- /S /D=<dir>`（这是传给 **NSIS 安装器**的参数，不变）；方案 B 改的是 **watchdog 载体与 spawn 方式**，不再需要 R1 方案 A 的 `/WATCHDOG_PID=`。哨兵 `watchdogPath` 语义订正为独立 exe。
**验证**：真机静默升级（含**首次从坏版本升级**），确认 watchdog 全程存活、两个 kill 点都不命中、`un.atomicRMDir` 不 Abort、`install-result.json` 真写入、stray `Sparkii.exe` 仍被清。补真实 NSIS 集成用例（见 §5）。
**回退**：方案 B 载体构建/签名真机不成立 ⇒ 在 (a)/(b)/(c) 间换载体；仍不成立 ⇒ 回到设计稿修订 watchdog 模式（如独立服务/计划任务载体），**不得静默降级**回方案 A（已证不成立）。

### M1 — 无 `--force-run` ⇒ 静默装完不自动重启（Major）

**根因**：installer.ts:983-985 透传仅 `/S /D=`；installSection.nsh:94-97 静默重启需 `isForceRun`；NsisTarget.js:579 `isForceRun` 仅由 `--force-run` 置位。
**最小修法**：installer.ts 透传改为 `--updated --force-run /S /D=<dir>`（`/D=` 保持最后、不加引号）。
- `--force-run`：让静默安装真正重启 app（installSection.nsh:94-97）。
- `--updated`：置 `isUpdated`，使重启的 app 拿到 `--updated` 启动参数——**真实来源是 `common.nsh:125-126` 的 `StartApp` 宏**（`${if} ${isUpdated} → StrCpy $startAppArgs "--updated"`），R1 误引 `installSection.nsh:126`（该行不存在），本稿更正。
**契约同步**：interfaces §6 行 351。
**验证**：真机静默升级后 app 自动重启、版本已变、重启进程带 `--updated`。
**风险**：`--force-run`/`--updated` 与 `/D=` 的解析顺序需真机确认（NsisTarget.js:579 flag parser；`/D=` 必须最后）。

### M2 — 升级每次重解压运行时（Major，含设计稿内部矛盾）

**根因（两层，均已对盘）**：
1. **顺序/删除**：installSection.nsh:52 `uninstallOldVersion` 先于 :82 `customInstall`；旧卸载器带 `--updated`（installUtil.nsh:206/224）；uninstaller.nsh:156-157 无条件插入 customUnInstall；build/installer.nsh:62-72 无条件 `RMDir /r` 运行时(:63-64)+`Delete` 标记(:68) ⇒ customInstall 读不到标记 ⇒ 重解压。
2. **标记粒度**：build/installer.nsh:24 `StrCmp $8 "${VERSION}"`，而 `${VERSION}`＝app 版本（:9-11 注释自证；NsisTarget.js:168 `VERSION:appInfo.version`）。**跨版本升级时标记必然 ≠ 新 app 版本 ⇒ 即便标记存活也重解压**。设计 §7.8:613 要求「**内容未变**则跳过」，用 app 版本当标记粒度无法达成。

**最小修法**：
- 层1：customUnInstall 的运行时＋标记清理加 `${ifNot} ${isUpdated}` 守卫（升级时旧卸载器收到 `--updated` ⇒ 跳过清理；完整卸载 `isUpdated=false` ⇒ 仍清理）。**清理范围不变**（仍只 runtime＋`data\pi-agent\bin`），只改触发时机。
- 层2：标记改存**运行时内容版本**（独立 `RUNTIME_VERSION` 常量或内容 hash，仅运行时内容变更时递增），customInstall 比对它而非 app `${VERSION}`。
- **回写设计稿**：§7.8:613（customInstall 内容未变跳过）与 :614（customUnInstall 删标记）在升级链路上自相矛盾（旧卸载器删标记⇒新 customInstall 找不到⇒重解压）。明确：标记粒度＝运行时内容版本；customUnInstall 加 `isUpdated` 守卫；:614「不改其数据清理语义」澄清为**清理范围不变、仅升级时跳过**。
**前向性注意（必须写明）**：旧卸载器是**旧版本**编译的，本修复只影响「从修复版往后」的升级；**从当前坏版本升级到修复版的那一次仍会重解压一遍**（一次性，可接受）。
**决策（已定，§10）**：运行时内容版本的载体采**独立 `RUNTIME_VERSION` 常量**（仅内容变更时递增），不用 hash；「运行时是否每 app 版本重打包」留作实施前一次确认——若运行时确实每版都变，层2 直接简化为不跳解压。
**验证**：真机「运行时内容不变、仅 app 版本升级」⇒ 不重解压；「运行时内容变」⇒ 重解压；完整卸载 ⇒ 清理。

### M3 — `supervisor.stop()` 不等待子进程退出（Major）

**根因（已对盘，订正 R1 两处事实错误）**：pi-runtime-supervisor.ts:211-216 `stop()` 只 `kill()`＋`close()`＋置空，不 await `onExit`；transports.ts:25/50 `kill` 即发即忘；pool `stopAll()` 立即 resolve ⇒ 快照/退出时 pi 子进程可能仍持**文件句柄／未 flush 的会话 JSONL**（agent-host 用 JSONL，见 pi-sdk-runtime.ts:61/98；**无 SQLite**——R1「持 SQLite WAL」错误，主进程的 `audit.db/sessions.db/errors.db` WAL 由关机序列**步骤4 关库**单独 checkpoint，设计 §7.7:587，与 pi 子进程无关）。违反 §7.7 步骤3（stopAll 等待会话结束）＋B 关「无残留子进程」。
**最小修法**：
- `stop()` 在 `kill()` 后 await 一个「`onExit` 或超时」的 Promise（超时兜底强杀并记录），再置空引用。pool `stopAll()` 天然随之等待。
- **`onExit` 句柄同一性守卫（防御性加固，非现网活体竞态）**：supervisor.ts:202-207 的 `onExit` 回调**无条件**清 `this.client/this.handle`。**当前接线不可达**误清路径——pool.ts:115 每槽 `new PiRuntimeSupervisor`、:116 只 `start()` 一次，release 的 dead 分支(:229-236) 与 `stopAll`(:257-266) 都只 stop 后丢弃、acquire 一律新建，全仓无对既有 supervisor 复调 `start()`。故本守卫针对的是「同一实例被 start→stop→start 复用」这一公开 API 假设，属防御性；改为仅当 `this.handle === handle` 时才清即可。**M3 的活体修复是 `stop()` await 退出，本条不是**——不得称现网 bug。
**验证**：单元（注入假 handle，断言 stop 等到 exit；对**同一实例**注入 start→stop→start 断言旧 exit 不清新句柄——仅验防御性守卫，非现网路径）；真机升级关机后无残留 pi 子进程、快照前句柄已释放。
**风险/澄清**：
- 超时阈值需定，与关机序列协调。**澄清**：设计 §7.7:592 的「3s 内未退出则 `app.exit(0)` 兜底」作用于**主进程 `app.quit()`/`quitApp`**，**不是** `pool.stopAll()`；`stop()` 的超时应排在 `quitApp` 之前的关机序列内，二者不可混为一谈。
- **删除 R1 错误风险注**「fork 子进程镜像在 `data\pi-agent\bin`，NSIS 清不到」：对盘证伪——两种 transport 都用 `process.execPath`（transports.ts:9 `utilityProcess.fork`、:33 `fork`），子进程镜像实为 `$INSTDIR\Sparkii.exe`，entry 只是 `utility-entry.js` 脚本（runtime.ts:160）；`data\pi-agent\bin` 仅 fd/rg 工具。故 NSIS KILL_PROCESS **会**命中 pi 子进程；M3 的真正理由是**优雅关机＋快照前释放句柄**，不是「NSIS 清不到」。

### M4 — 安装最后一公里 TOCTOU（Major）

**根因**：installer.ts:879 `verifyArtifactBytes` 读完即关句柄（downloader.ts:76），watchdog 按路径执行、仅 `existsSync`（update-watchdog.mjs:166）、不重哈希 ⇒ 验签后到执行间本机可换包。违反 §7.3:525「持有句柄直到交给安装器」意图＋§0.4 不变量4。
**最小修法**：watchdog 在 spawn 前（update-watchdog.mjs:201 前）对 `installerPath` 重算 **sha512**，比对哨兵 `packageSha512`（installer.ts:192），不符即 abort 写 `ok:false`。
- **更正 R1**：哨兵 `SentinelRecord`（installer.ts:186-204）**只有 `packageSha512`，无 bytes 字段**——故仅比对 sha512（sha512 相等即字节相等，无需另设 bytes）。R1「比对 packageSha512/bytes」中的 bytes 不存在。
**验证**：补承重用例——spawn 前把包换字节 ⇒ watchdog 拒绝、不 spawn、写 failed（改坏「不重哈希」即红）。
**备注（降级 R1 措辞）**：跨主进程退出 literally 持句柄不可能；watchdog 侧重哈希**收窄** TOCTOU 窗口（从「下载验签→主进程退出后执行」的大窗口，缩到「watchdog 重哈希→spawn」的小窗口），但**重哈希与 spawn 之间仍有残余竞态**（NSIS 按路径 spawn 无法继承句柄）。故定性为「**收窄窗口＋登记残余竞态**」，**不称「可达成等价」**。与 B1 同改 update-watchdog.mjs，合并实施。

---

## 2. T2 数据安全 Minor（本轮一并修）

- **m8 快照哈希源**：snapshot.ts:225 改哈希**拷贝后的 dst**（而非 :223 的源 `f.absPath`），bytes/mtime 取 dst 实测；或 walk 前冻结写者。补「拷贝与哈希之间源被改」用例。
- **m9 acquire 闸门 TOCTOU**：pi-runtime-pool.ts `await start()`(:116) 之后、**`offEvent` 注册(:125) 与 `push`(:126) 之前**复检 `this.stopped`；若已停则 stop 新 supervisor 并 throw，不再注册/入池。补竞态用例（await 期间池被 stop）。
- **m10 审批重提交竞态**：gate.ts `submit()`(:30) 加 quitting/closed 闸门；或 shutdown 在 stopPool 之后再 abort 一次（shutdown.ts:46 abortPendingApprovals 现先于 :47 stopPool）。保持 §7.7 顺序不变的前提下堵窗口。补窗口内 submit 用例。
- **m11 无字节上限**：installer.ts prune 由「仅数量」改为「累计 `pending/`＋`snapshots/` 字节，超上限驱逐最旧**非保护**项」（设计 §7.9:626）。
  - **术语更正**：代码用 `snapshots/`（prune report `snapshotsRemoved/snapshotsKept`，installer.ts:1218），设计 §7.9:626 写 `backups/`——本稿统一用 `snapshots/`，并回写设计对齐术语。
  - **与「哨兵在场」不变量的交互（必须写明）**：installer.ts:1237「`sentinelPresent || !currentVersion` ⇒ pending 一律不清」（fail-closed，§7.9「回滚未完成前不得删旧包与对应备份」；power-cut.test.ts:341 承重）。字节上限驱逐**必须沿用同一保护**：当前版本包、待回滚 snapshot、哨兵在场项**绝不驱逐**；上限只作用于**非保护累积**（失败安装残留、orphan `.part`、超 N 的旧 snapshot）。哨兵在场时 pending 仍整体跳过。
  - **上限值（已定，§10 默认）**：采设计建议的 **1.5× 包体**；沿用「哨兵在场⇒pending 不驱逐」保护、不绕过。
  - 失败安装累积也触发清理；清理写 `update.cleanup` 审计。补上限用例（含「哨兵在场不驱逐」承重断言）。

## 3. T3 卫生与安全文档 Minor

- **m1**：.gitignore 增 `.workbuddy/`；提交前还原 3 个 native .exe 到 HEAD（构建副产物）。
- **m2**：改正 service.ts:140 假注释（双删并非「显式报错」）；在设计 §6.3.4 登记「防回滚不 survive 双锚点删除」的固有局限。**已定（§10）**：本轮只登记局限、不新造第三锚点；抗删第三锚点（机器级标记/服务端 per-install 下限）作为独立安全加固议题另拍。
- **m3**：**文档订正本轮做（不被待拍门控）**——发布 CLI 现无 SSH 上传/远端回读，先订正设计 §8.2 步骤4-6 与 publish 文件头，使其如实描述当前状态（人工上传或待实现）。**已定（§10）**：本轮文档化人工规程（订正 §8.2/文件头如实描述），SSH＋回读实现留待后续；首次发布前人工上传规程必须就位。R1 把文档订正也挂在待拍下，本稿拆开：订正本轮做，实现另拍。

## 4. T4 低影响 Minor

- **m4 启动散布（本轮修，正确性相关）**：
  - **现状对盘**：update-bootstrap.ts:530-532 `gateUpperMs=(startupDelaySeconds+15)*1000`、`spreadMs=jitterDelay(seed, startupDelaySeconds)*1000`、`schedule(Math.max(gateUpperMs, spreadMs))`。`jitterDelay`（scheduler.ts:45-49）＝`base*(0.85..1.15)`（**乘性**）。默认 `startupDelaySeconds=90` 时 `spreadMs∈[76.5,103.5]s` 恒 < `gateUpperMs=105s` ⇒ `Math.max` **恒 105s**，per-install 散布丢失（凡 delay≤100 皆如此）。
  - **闸门真实窗口**：service.ts:801 `jitterSeconds = jitterDelay(installId,60)-60 ∈ [-9,+9]`（**加性**，base60），闸门启动窗口＝`startupDelaySeconds + jitterSeconds` ⇒ 闸门上界＝`startupDelaySeconds + 9`。
  - **修法**：复用闸门的**加性**抖动派生 per-install 散布，排在「闸门上界＋余量」之上且**永远 ≥ 闸门阈值**（保 R1·Major-2 不变量：首检不得早于闸门，否则约半数现场白跑 `STARTUP_DELAY` 再退到 15min 心跳）。即把乘性 `spreadMs` 改为 base 之上的**加性**正散布，不再用恒被支配的 `Math.max`。
  - **订正错注释**：bootstrap:424「闸门上界＝startupDelaySeconds×1.15」错（实为 `+9` 加性）；:529「散布仍保留：在 [delay+15, delay×1.15] 里取」错（delay=90 时该区间 [105,103.5] 为空，散布并未保留）。
- **m6 7轮vs7天（已定：改代码对齐「7 天」）**：bootstrap:411 `MAX_CONSECUTIVE_UNAVAILABLE=7` 是「**7 轮**」（:410 注释），退避档 :418 六档累计≈1.6 天；设计 §7.10:636 要求「连续 **7 天**不可用降级」。**已拍板改代码**：判据从「连续 7 轮」改为「累计不可用时长≥7 天」，实施时落代码＋对齐注释。
- **m5 周期幅度** / **m7 If-None-Match**：低影响，列**发布后**闭合（不阻塞）；若架构师认为应本轮，一并。

---

## 5. 实施顺序与耦合（理由可证伪）

1. **批1＝B1+M1+M2+M4**：四者共同改 installer.ts（spawn 载体/透传参数）、build/installer.nsh、update-watchdog.mjs、契约 §6 ⇒ 合并实施避免互相冲突与重复真机跑。顺序：B1 载体**已定 Node SEA**（§10）→ 部署独立 exe 到 `$INSTDIR` 外＋改 spawn(B1) → 改透传 `--updated --force-run`(M1) 与 installer.nsh `isUpdated` 守卫/内容版本标记(M2) → watchdog spawn 前重哈希(M4)。
2. **批2＝M3**：独立（supervisor/pool），可与批1 并行开发，但真机验证合并到同一次隔离 VM。
3. **批3＝T2(m8-m11)**：独立代码修复，随批1/2 之后。
4. **批4＝T3/T4＋文档回写＋.gitignore/exe 还原**（m3 文档订正、m4/m6 本轮改代码；决策见 §10）。
5. **测试补强（贯穿）**：新增**真实 NSIS 集成验证**消除假安装器盲区（update-watchdog.mjs:196 `asScript` 分支是 R1 盲区根源）——至少覆盖「watchdog 不被**两个** kill 点杀且写结果(B1)」「`un.atomicRMDir` 不 Abort(B1)」「静默装完自动重启(M1)」「运行时未变不重解压(M2)」。真机项进隔离 VM 清单（§6）；能在 CI 用真实模板静态断言的部分（宏守卫、参数顺序、载体镜像名/路径）加恒实跑用例。
6. **收尾取数**：typecheck/lint/全量 test 连跑两次数字一致（全量只在仓库根跑）；产物层独占重跑 dist 重取断言（隔离环境，因会就地重编 3 exe）。

## 6. 真机验证清单（隔离 VM，修复后必跑）

- B1：watchdog 全程存活、**两个** kill 点都不命中、`un.atomicRMDir` 不 Abort、`install-result.json` 写入、stray `Sparkii.exe` 被清；**含首次从坏版本升级**；载体 exe 在 `$INSTDIR` 外、签名通过 SmartScreen/MOTW。
- M1：静默装完自动重启、版本已变、重启进程带 `--updated`。
- M2：运行时未变不重解压 / 变了重解压 / 完整卸载清理；首次从坏版升级的一次性重解压确认。
- M3：关机后无残留 pi 子进程、快照前句柄释放；旧 handle 迟到 exit 不误清新 handle。
- M4：换包字节 ⇒ watchdog 重哈希拒绝。
- 原 M 清单：/S 无 UAC、MOTW/SmartScreen、安装目录锚定（InstallLocation 空现场）、watchdog PID-wait、断电恢复、data\ 快照还原、A⑦ sandbox-spike 发布机环境。

## 7. 契约 / 设计文档同步清单

- interfaces §6 行 351：M1 透传 `--updated --force-run`（`/D=` 仍最后）；B1 改 watchdog 载体与 spawn（哨兵 `watchdogPath` 语义＝独立 exe），**不再需要** `/WATCHDOG_PID=`。
- 设计 §7.7：B1 落地后订正 watchdog 载体描述（独立镜像名＋`$INSTDIR` 外，§7.7:591 已允许）；§7.8:613/614：M2 标记粒度＝运行时内容版本、customUnInstall `isUpdated` 守卫、澄清「清理范围不变仅升级跳过」。
- 设计 §6.3.4：m2 双删局限登记。
- 设计 §8.2 / publish 文件头：m3 远端上传/回读口径（**本轮订正如实描述**）。
- 设计 §7.9:626：m11 术语 `backups`→`snapshots` 对齐、上限值（已定 1.5× 包体，§10）。
- 设计 §7.10：m6 口径（若改「7天」无需回写；若保留「7轮」则回写）；m4 加性抖动与 bootstrap:424/:529 注释订正。

## 8. 明确不做 / 范围外

- 不实现 m2 第三锚点、不实现 m3 远端上传（§10 已定：本轮只登记/订正文档，实现另拍）；m6 已定本轮改代码对齐 7 天。
- 不启用差分、不动信任链/验签逻辑（B 维已确认健全，无需改）。
- 不 git commit/push（除非单独放行）；不动真实 data\ 与真实安装目录。
- m5/m7 默认发布后（除非架构师/决策者要求本轮）。
- **不采用 B1 方案 A**（已对盘证伪：第二 kill 点 PID 通道不可达＋文件锁冲突）。

## 9. 预置回退表

| 现场 | 回退 |
|---|---|
| B1 载体 (a) SEA 构建/签名不成立 | 换 (b) 改名 node.exe 或 (c) 原生 launcher；仍不成立 ⇒ 修订设计 watchdog 模式（独立服务/计划任务），**不退回已证伪的方案 A**、不静默降级 |
| B1 载体 exe 误落 `$INSTDIR` 内被路径匹配杀 | 部署到 `runtime\`/`data\updates\`（`$INSTDIR` 外）再 spawn；真机断言路径不在安装目录树 |
| M2 运行时版本载体 | 已定采 `RUNTIME_VERSION` 常量；若实施发现运行时每 app 版都变，则层2 简化为不跳解压，仍先落层1（`isUpdated` 守卫） |
| M3 超时阈值拖垮退出 | 排在 `quitApp` 前的关机序列内，超时强杀并审计；3s `app.exit(0)` 是主进程独立兜底，不无限等 |
| dist 重编再删 3 exe | 隔离环境跑、跑前 git 快照这 3 个文件，失败即还原 |
| 真机项无法在本机复现 | 记「未验证」进 M 清单，不冒充通过 |

## 10. 决策状态（2026-11-08 决策者拍板后）

| # | 决策 | 结果 | 状态 |
|---|---|---|---|
| 1 | **B1 watchdog 载体** | **(a) Node SEA**（保留 .mjs、node 运行时量级、同证书签名）；载体仍必须部署到 `$INSTDIR` 外、改名 ≠ Sparkii.exe | ✅ 已定 |
| 2 | **m6 口径** | **改代码对齐「7 天」**（判据改为累计不可用时长≥7 天，而非 7 轮）；实现时做 | ✅ 已定 |
| 3 | **m2 抗删第三锚点** | **本轮只登记固有局限**（订正假注释＋设计 §6.3.4 写明双锚点可被同机删两处失效），不新造机制 | ✅ 已定 |
| 4 | **m3 发布上传** | **本轮只文档化人工规程**（订正设计 §8.2/发布脚本头如实描述），SSH＋回读留待后续 | ✅ 已定 |
| 5 | M2 运行时内容版本载体 | 采**独立 `RUNTIME_VERSION` 常量**（内容变更才递增）；未再单列，默认走此，需改再议 | 默认 |
| 6 | m11 磁盘上限值 | 采设计建议 **1.5× 包体**；沿用「哨兵在场⇒pending 不驱逐」保护不绕过 | 默认 |
| 7 | m5/m7 时机 | 默认**发布后**闭合（不阻断本轮） | 默认 |

> 决策 5/6/7 低风险，已取安全默认值；若决策者要改动，仅影响对应小项，不动 B1/M1-M4 主线。