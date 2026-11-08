# Sparkii Desktop 自动升级机制设计（审核后定稿 v3）

> 状态：**设计定稿 v3 · 架构审核通过 · 任务 0 实测已完成、§5.2 定案 A、已动工**；三轮只读审核 + 一次独立复核的结论项已全部闭合；阶段 0 复核修订见 §0.7，实测结论见 `2026-11-06-task0-results.md` 与 §11.10
> 日期：2026-11-06（15:13 两份只读审核后重写 v1；第三轮复核后闭合为 v2；第四轮复核闭合 v2 新增矛盾为 v3）
> 范围：Windows 桌面客户端 L2 自动升级 + 静态更新源发布
> **本文取代 14:13–15:13 的全部讨论稿与 v1 定稿**；决策演变见 §0.3，三轮审核结论见 §0.2 / §0.5

---

## 0. 决策摘要与审核修订

### 0.1 已确认决策

| # | 结论 |
| --- | --- |
| D1 | 本期目标 **L2**：发现新版 → 点「下载」→ 点「安装」→ 静默安装 → 重启 → 新版 |
| D2 | 一台公有云服务器、一个 IP、无域名；客户可访问 |
| D3 | 更新源**静态文件托管**，挂在现有 RAG 服务同一 IP 的 **80 端口**下 |
| D4 | **无代码签名证书且不采购**；先做「未签名包静默安装实测」 |
| D5 | 采用 **electron-updater**（>= 6.3.0），但本期**只**用 `checkForUpdates` / `downloadUpdate`；**安装执行自管**（detached watchdog + NSIS `/S`），**不调用 `quitAndInstall()`**，原因见 §7.7 |
| D6 | 401MB 优化先实测差分下载量再定；**本期不启用差分**（`disableDifferentialDownload = true`，`release.json` 不带差分 URL），不阻塞本期 |
| D7 | 允许自动检查，但要有统一闸门 + 24h 周期 + 抖动 + 静默退避 |
| D8 | **不要 beta 通道**；灰度 / 强制更新放 P2 |
| D9 | **发布私钥由用户本人保管**，单人发布，去掉双人复核 |
| D10 | 更新源地址**可配置 + 构建注入默认值**，**支持 HTTP** |
| D11 | 与现有 RAG 服务共用服务器；客户端只读静态目录，不调业务 API |
| D12 | 下载 / 安装**两个独立用户动作**；取消安装不丢包 |
| D13 | **「已下载·可安装」状态不落盘**，由启动时扫描 `pending/` + 验伴生清单推导 |
| D14 | 本地已下载 0.2、服务器已有 0.3 时给**二选一提示** |
| D15 | RAG 服务对外端口 80，Web 服务器类型待查（不阻塞开工） |
| D16 | 进度条为状态栏**轻量控件**，不弹窗、不打断工作 |
| D17 | 单机 per-user 安装，免 UAC；SmartScreen 等 Windows 行为一律先实测 |
| D18 | **构建配置唯一载体为 `electron-builder.config.mjs`**；`SPARKII_UPDATE_URL` 注入的是运行时默认地址，不是 `publish.url`（§5.4） |

### 0.2 前两轮审核结论与关键修订（2026-11-06 15:13）

两份只读审核（架构一致性 / 安全与发布链路）**均判「不通过」**。已按 Blocker 逐条重构，最重要的四处：

1. **撤回「HTTP 下靠 Ed25519 清单签名即可保证安全」这一结论（全稿最危险的一句）。**
   旧稿认为「验签覆盖元数据，攻击者做不到伪造新版本或替换安装包」。事实是：electron-updater 用**自己的 HTTP 客户端**拉 `latest.yml`，与我们用 `fetch` 拉取并验签的字节是两次独立请求。HTTP 中间人可给验签端返回合法签名清单、给 updater 返回含攻击者 `sha512` 的恶意 `latest.yml`；叠加 `verifyUpdateCodeSignature: false`，`downloadUpdate()` / `quitAndInstall()` 会直接安装恶意包 → 完整代码执行。
   **修复**：`verifier.ts` 独占**清单与策略数据**的网络入口，客户端**本地派生** `latest.yml` 喂给 updater，updater 不再对外请求元数据；安装包仍由 `downloadUpdate()` 按已验签 URL 下载，且必须受 §5.2 的 `httpExecutor` 约束，下载后逐次复核 sha512 / bytes（§5.2 / §6.2）。

2. **「自管 `pending/` 目录」与「electron-updater 托管下载缓存」互斥。**
   旧稿一边让 updater `downloadUpdate()`，一边让 `local-artifacts.ts` 扫 `data/updates/pending/` 推导状态——两者不是同一个目录。
   **修复**：下载完成事件里把包从 updater 缓存**迁移**到 `pending/<version>/`，同时落下已验签的伴生清单（§7.6）。由此引出 M-new-3：迁移后 `quitAndInstall()` 失效，见 §0.5。

3. **发布顺序存在「两个指针」竞态。**
   旧稿先切 `release.json` 再切 `latest.yml`，正常发版就会短暂产出「新策略清单 + 旧版本清单」的混搭，无需攻击者即可绕过 `sequence`。
   **修复**：**单一逻辑指针**（`channel.json` + `.sig` 两个物理文件，非原子窗口由 fail closed 覆盖，见 §8.2），整套文件先传版本目录，最后只切这一组指针文件（§8.2）。

4. **安装事务与进程生命周期不可靠。**
   旧稿写「先 `spawn` 安装器、再 `app.quit()`」会撞上应用自身 exe 文件占用；`before-quit` 里有钩子无条件 `preventDefault()`；代码里 **Pi 进程池没有停止钩子**、三个 SQLite store 无人 `close()`；备份只列 3 个文件、漏了 WAL / `keyring/` / `errors.db`；拿不到安装器退出码、无半安装恢复。
   **修复**：显式关机协议 + 整目录一致性快照 + 安装结果回传 + 旧版恢复介质（§7.7 / §7.8）。

其余已修正：`verifyUpdateCodeSignature: false` 的官方语义与 CVE 引用（§5.5）、防降级状态明文可篡改且「损坏即回退默认」（§6.3）、清单无 `expiresAt` 导致回滚/旧清单可无限重放（§6.2 / §6.5）、`minSupportedVersion` 未硬拦截 updater 直跳（§7.6）、审批门 pending 提案退出即静默丢失（§7.7）、host 白名单对 updater 请求不可执行（§5.2）、`releaseNotes` 双来源（§7.5）、磁盘旧包清理（§7.9）、单实例锁时机（§7.7）、`publish.url` 的 YAML 不支持环境变量插值（§5.4）。

**三处代码事实订正**：`create-release-manifest.mjs` 的 `sha256File` **未导出**，不能直接复用（参考其实现另写）；`out/*.blockmap` 是否在现有产物中存在**需构建后确认**，不能当作既定事实；`installer.nsh` 的 `customUnInstall` 会删 `data\pi-agent\bin\*`，因此「绝不删除 `data\`」应精确为「仅清理 runtime 与 `data\pi-agent\bin`」。

### 0.3 决策与审核演变

| 时间 | 变化 |
| --- | --- |
| 14:13 | 初稿：静态更新源 + 自研决策层；定为 L1 提醒 |
| 14:33 | 采纳 `electron-updater`（撤回自研版本发现） |
| 14:41 | 地址可配 + HTTP；与现有 RAG 服务共用 IP |
| 14:49 | 范围改为 **L2 全自动**；修正「无证书是硬门槛」的过度判断 |
| 14:58 | 下载 / 安装拆两步，中间态可跨重启恢复 |
| 15:08 | 中间态**改为由磁盘事实推导**；0.2 / 0.3 二选一 |
| 15:13 | 两份只读审核判不通过 → **重写为 v1 定稿** |
| 复核后 | 第三轮独立复核判「**有条件通过**」→ 闭合 B-new-1 / M-new-1..4 / Minor → **v2 定稿** |
| 再复核 | 第四轮独立复核判「**有条件通过**」（v2 新增 1 条 `sequence` 冲突）→ 闭合 N1–N9 → **v3 定稿，审核通过** |

### 0.4 四条不可违背的安全不变量

1. **验签字节 == 策略依据 == updater 的元数据输入**。元数据只能来自客户端本地派生（服务器**不上传** `latest.yml`）；安装包 URL 来自已验签清单，下载字节必须复核 sha512 / bytes。**上述等式任一处解耦即 fail closed**；下载通道须经 §5.2 的 `httpExecutor` 约束，若实测不可注入则走该节明文记录并经批准的降级取舍（不适用此 fail closed 判定，因为完整性由 sha512 终检保证）。
2. **任何下载 / 安装动作之前必须重新验签**（含签名、新鲜度、防降级、nonce），且门禁在 **IPC 层**，不能只挡 UI。
3. **升级链路绝不破坏 `data\`**：安装前完成一致性快照，安装结果必须可判定、失败必须可恢复。
4. **安装包的执行路径只认 `pending/<version>/` 下通过校验的那一个文件**；安装器参数（含目标目录）由 Main 进程根据已验签清单与本机安装位置计算，不接受 Renderer 或外部输入。

### 0.5 第三轮复核（final-review）闭合清单

复核结论：**有条件通过**（动工前须闭合 4 项文档级矛盾/未闭环项，并以「任务 0」实测结论为准）。以下逐条闭合：

| 编号 | 复核意见 | 闭合方式 |
| --- | --- | --- |
| **B-new-1** | §5.2 备选方案仍写「updater 拉远端 `latest.yml`」，与 §6.1「服务器不上传 `latest.yml`」硬矛盾，备选路径不可执行 | 备选改为**本机 loopback 临时 feed**（元数据仍本地派生）；再加兜底 **B 方案**（`downloader.ts` 自研下载，完全绕开 updater 的元数据/下载通道）。全稿**删除所有可执行的「updater 拉远端清单」路径**（§5.3 仅保留一条 ❌ 撤回记录），见 §5.2 |
| **M-new-1** | §0.2 / §4 / §7.1 / §9 对「唯一网络入口」措辞互相冲突 | 统一表述为「**清单与策略数据的唯一网络入口**」；安装包下载由 `downloadUpdate()` 按已验签绝对 URL 执行，见 §0.2 / §0.4 / §4 / §5.2 / §7.1 / §9 |
| **M-new-2** | `electron-builder.config.mjs`（§5.4）与 `electron-builder.yml`（§10）双配置载体冲突 | **唯一载体 = `electron-builder.config.mjs`**；`dist` 加 `--config`，删除 `electron-builder.yml`；构建注入点分离到 `build:main` 的 esbuild `define`，`publish.url` 退化为构建期占位常量，见 §5.4 / §10 |
| **M-new-3** | 包迁移到 `pending/` 后，`quitAndInstall()` 仍按 updater 缓存路径找包，安装执行不可达 | **本期不调用 `quitAndInstall()`**，改由 detached watchdog 在确认主进程完全退出后 `spawn` NSIS `/S`，路径自管；同步 D5 / §4 / §5.1 / §7.1 / §7.7 / §9 / §11 |
| **M-new-4** | 安装包走 HTTP 下载，不受 host / 重定向约束，§5.2 只说「须接管 httpExecutor」而无取舍 | 主方案**硬性注入自定义 `httpExecutor`**；若任务 0 实测 API 不可注入，则**显式接受并记录残余风险**（完整性由 sha512 终检保证，残余为 SSRF / 超大响应 / 重定向），并给出运行时缓解，见 §5.2 / §6.4 |
| Minor · 1 | §7.2「与安全无关的三样」措辞错误 | 改为「仍需持久化的三样」，并注明其中两样直接关系安全，见 §7.2 |
| Minor · 2 | `channel.json` 缺明确 schema | 补 §6.1.1 完整 schema 与字段约束 |
| Minor · 3 | `nonce` 是硬性字段但客户端没有校验规则 | §6.3 明确「`(sequence → nonce)` 绑定校验」；新鲜度仍由 `expiresAt` 承担 |
| Minor · 4 | `customInstall` / `customUnInstall` 粒度与影响面清单不一致 | §7.8 与 §10 同步列出两者的改动点 |
| Minor · 5 | 静态托管下「原子切换」措辞不成立 | §8.2 改为「逻辑单一指针 + fail closed 覆盖两文件非原子窗口」 |
| Minor · 6 | §7.9 客户端审计哈希链与 §8.3 服务端发布透明日志混为一谈 | §7.9 / §8.3 明确两者不同并分别分期（B 关 / P2） |

### 0.6 第四轮独立复核闭合记录（v2 → v3）

第四轮只读复核结论：**有条件通过**——v2 对上述 11 项「均已真闭合」，但整篇重写**新引入 1 条同级别的文档级矛盾**，另记 8 条表述级不一致。第五轮独立复核判 **v3「通过」**（无阻塞项），并指出若干待清理文字，均已在本次闭合。逐条闭合：

| 编号 | 复核意见 | 闭合方式 |
| --- | --- | --- |
| **N1（阻塞）** | §6.1.1 写「`sequence` 只在此指针中出现一次」，与 §6.2 / §6.3 / §8.2 中 `release.json` 携带 `sequence` 冲突；且 `pending/` 伴生清单需要该字段做离线校验 | §6.1.1 改为「`channel.json` 是唯一权威/唯一递增来源，`release.json` 携带**等值镜像**且必须严格相等」，并说明镜像的离线用途；§8.2 发布步骤同步 |
| N2 | §0.4 不变量 1「或走降级取舍」与「任一处解耦即 fail closed」自相矛盾 | 明确 fail closed 只约束句首等式，下载通道降级另按 §5.2 处理 |
| N3 | §7.3 `installUpdate` 门禁未列 `nonce`，与不变量 2 / §9 验收②不同步 | 门禁补 `nonce` 绑定与 `expiresAt` |
| N4 | D5「已确认」与「任务 0 后可能整体推翻 D5」并存 | 保留：任务 0 显式管理该分支，§11 开放问题 6 已写明定案后修订 D5 与 §10；不属隐藏矛盾 |
| N5 | §0.5 称「删除任何路径」，§5.3 仍保留 ❌ 撤回记录 | §0.5 改为「删除所有**可执行**路径（§5.3 仅保留撤回记录）」 |
| N6 | §0.2「只切一个指针文件」与 §8.2「两个物理文件」张力 | §0.2 / §6.1 / §8.2 统一为「单一逻辑指针 = 两个物理文件」 |
| N7 | blockmap 差分是否本期范围，多处口径不一 | 全稿统一「**本期不启用差分**、恒定 `disableDifferentialDownload = true`、清单无差分 URL、updater 不请求 blockmap；发布 CLI 仍上传 blockmap 仅作任务 0 评估与 P2 准备」，见 D6 / §5.1 / §5.2 / §6.1 / §7.6 / §8.2 / §9 / §11 |
| N8 | §11 第 8 项仍写「决定 B 关验收④能否承诺旧版仍可启动」，与 §7.7 / §9 已定稿的验收标准状态不一 | §11 改为「仅判断能否**额外**承诺，不降低既定验收」 |
| N9 | §7.7 第 7 步叙述顺序把 `app.quit()` 写在 `spawn` 之后，与「watchdog 等主进程消失才 spawn」倒置 | 拆成 4 个有序子步骤：启 watchdog → `app.quit()` → watchdog 确认主进程消失后 `spawn` → watchdog 回写结果；并把 `install-result.json` 定为 **watchdog 单一写入**，`customInstall` 不写（同步 §7.8 / §10 / §11） |

> 闭合后仍保留的前提：**任务 0 实测结论优先于本文任何实现假设**。若实测推翻 §5.2 主方案或 `/S` 免 UAC，须回到本文定案后再开工，不得在代码里临时绕开。

### 0.7 阶段 0 现状复核修订记录（2026-11-06，动工前）

任务 0 实测与 §2 逐文件复核完成后，按「设计稿本身有错 → 先修订设计稿并记录理由，再改代码」的规则闭合以下 6 项。**本节只记录修订理由；§0.2 / §0.5 / §0.6 的审核与决策记录原样保留**。完整实测命令、stdout 摘要、退出码与产物路径见 `docs/superpowers/specs/2026-11-06-task0-results.md`。

| 编号 | 原结论 | 修订 | 理由 / 证据 |
| --- | --- | --- | --- |
| **P0-1** | §2「`rt.pool` 全仓无 `stop()/dispose()`」；§7.7 步骤 3 与 §10「需新写代码 / 新增 `pool.stop()`」 | 改为「**复用既有 `PiRuntimePool.stopAll()`**，补 `stopped` 闸门拒绝新任务，并在关机协议中调用」 | `packages/agent-host/src/pi-runtime-pool.ts:249-256` 已有 `stopAll()`（逐个 `supervisor.stop()`、清空 slots/pending、`emitSnapshot()`），只是**无任何退出路径调用**，且调用后 `acquire()` 仍可重建 slot。再新造一个 `stop()` 会形成两套语义 |
| **P0-2** | §7.7「从 HKCU `InstallLocation` 读出并以 `/D=<path>` 传入」 | 增加回退：`InstallLocation` 为空时从 `UninstallString` 的带引号 exe 路径取父目录；仍解析失败则 **fail closed，不传 `/D` 并拒绝自管安装** | 只读注册表实测：本机 `InstallLocation` 为**空**，`UninstallString = "D:\software\SparkiiPi\Uninstall Sparkii.exe" /currentuser`（用户改过安装目录）。不回退会装到默认目录、产生两份安装 |
| **P0-3** | §0.2「`out/*.blockmap` 是否存在需构建后确认」 | 事实补齐：**已确认存在**，gzip、schema `version:"2"`、`files:1`、64KB 分块 `checksums` | 直接读取 `apps/desktop/out/Sparkii-0.1.0-win-x64.exe.blockmap`。**不改变 D6：本期仍不启用差分** |
| **P0-4** | §5.5「设为 `false` 后写入的是 `verifyUpdateCodeSignature: false`」 | 改为：`win.verifyUpdateCodeSignature: false` 是**构建配置开关**，其产物效果是 `app-update.yml` **不含 `publisherName`**（不会写入同名键）；`NsisUpdater.verifySignature()` 因 `publisherName == null` 返回 null 而跳过验签 | 实测 `resources/app-update.yml` 只有 `provider / url / updaterCacheDirName` 三行；`winPackager.js:27` `isForceCodeSigningVerification = … !== false`，`PublishManager.js:202-208` 仅在 true 时计算 `publisherName`。产物断言相应改为「配置含该开关 + `app-update.yml` 不含 `publisherName`」 |
| **P0-5** | §5.2 把「`file://` 是否被接受」当作简单是非 | 明确：**`setFeedURL` 接受 `file://` 且 provider 派生 URL 正确，但默认 `ElectronHttpExecutor` 走 `electron.net.request`（仅 http/https）必然失败**；A 成立的前置是**自定义 `httpExecutor` 在 `request()` 层本地读取 `file:` 元数据** | 探针实测默认 executor 报 `electron.net.request cannot use protocol file:`，注入自定义 executor 后 `checkForUpdates()` 成功返回版本。§5.2 步骤 4 本就强制注入，故不削弱「元数据只来自本地派生文件」的不变量 |
| **P0-6** | §11 第 1 项「覆盖 feed 后 `app-update.yml` 开关是否仍生效」为开放问题 | 闭合：**仍生效** | `setFeedURL()` 只令 `clientPromise` 非空（绕过 feed provider）；`AppUpdater.js:493` `getOrCreateDownloadHelper()` 与 `NsisUpdater.js:87` `verifySignature()` 仍独立读 `configOnDisk.value`。探针用真实 `app-update.yml` 验证 `configOnDisk` 可读且含 `updaterCacheDirName` |

---

## 1. 目标与范围

### 1.1 完整用户流程

```text
启动 ─ 本地扫描 pending/（立即、零网络）─┐
                                        ├─ 合并计算 → UI 状态
网络检查（按 §7.10 闸门调度）───────────┘
   │
   ├─ 有新版 → 状态栏 pill → 点「下载」→ 状态栏小进度条（不打扰）
   │            → 下载完成 → 「已下载完，可以安装」
   │
   ├─ 点「安装」→ 有活跃进程？→ 是：确认弹窗（取消 = 回到可安装，包保留）
   │                          → 否 / 已确认：关机协议 → 静默安装 → 重启自检 → 新版
   │
   └─ 本地 0.2 + 服务器 0.3 → 二选一：「装本地 0.2」/「跳过 0.2 直接升级 0.3」
```

- 下载与安装**都必须用户显式触发**，`autoDownload = false` 恒为真，不是偷偷更新。
- 取消安装、关机重开、手动删包：都不写状态，启动时重新扫描 `pending/` 推导。

### 1.2 非目标（本期不做）

macOS / Linux 通道、MSIX / AppInstaller、beta 通道、灰度、强制更新、应用内发布后台、用户数据上云、遥测与设备指纹、未实测就假定 Windows 行为。

---

## 2. 现状事实基线

| 项 | 事实 |
| --- | --- |
| 打包 | `apps/desktop/electron-builder.yml`：`appId: com.sparkii.desktop`，`artifactName: Sparkii-${version}-win-${arch}.${ext}`，`asar: true`，NSIS `oneClick: true` / `perMachine: false` / `deleteAppDataOnUninstall: false` |
| 发布脚本 | `apps/desktop/package.json` 的 `dist`：`electron-builder --win nsis --publish never` → `scripts/create-release-manifest.mjs` |
| 清单 | `release-manifest.json` schemaVersion 1：`version / platform / commit / builtAt / unsigned / artifact / bytes / sha256`；`unsigned: true` 硬编码 |
| 安装脚本 | `build/installer.nsh`：`customInstall` 解压 Portable Git 与 document-parse 到 `%LOCALAPPDATA%\SparkiiDesktop\runtime\`；`customUnInstall` 只清 runtime **与 `data\pi-agent\bin`** |
| 签名基础 | `packages/config/src/integrity.ts`：Ed25519 `generateKeyPair / signFiles / verifyFiles`；`loader.ts:67-75` fail-closed。但 `main/index.ts:62` 未传 `publicKey`，生产实际放行未签名 profile——此缺口不得在升级链路重演 |
| 代码签名 | 无。`docs/release-windows.md` 预期 `NotSigned` |
| 版本读取 | 唯一来源 `apps/desktop/package.json`；运行时从未调用 `app.getVersion()` |
| 网络 | 原生 `fetch` + `AbortController` 注入模式（`provider-probe.ts` 等） |
| 设置 | `main/settings.ts` 自建 `settings.json`；已有 `rag.baseUrl` 等，**没有更新服务器地址**；`ipc.ts` 的 save 为 merge 语义 |
| IPC | 三段式：`preload/api-types.ts` → `preload/api.ts`（`sparkii:<method>`）→ `main/ipc.ts`；事件 `sparkii:event:<channel>`。`test/preload-api.test.ts` 对方法名做精确断言 |
| 主进程 | `main/index.ts` 的 `app.whenReady()` 装配；**无单实例锁**；两个 `before-quit` 钩子，其中 `document-parse-quit.ts` 无条件 `preventDefault()` 后二次 `app.quit()` |
| 生命周期缺口 | `rt.pool` **已有 `stopAll()`**（`pi-runtime-pool.ts:249`）但**无任何退出路径调用它**，且调用后仍可 `acquire()` 重建 slot（见 §0.7 P0-1）；`audit` / `chatSessions` / `errors` 三个 store 的 `close()` 无人调用；`ApprovalGate.proposals` 是内存 Map，退出即丢 |
| 安全边界 | Renderer `contextIsolation + sandbox`，`index.ts:84-100` 导航守卫拒绝外部页面 |
| 存储 | `%LOCALAPPDATA%\SparkiiDesktop\data`：`audit.db`(WAL) / `sessions.db` / `errors.db` / `settings.json` / `keyring/` / `logs/` / `tasks/` / `pi-agent/` |
| 审计 | `packages/approval/src/audit.ts`：SQLite WAL，`append / query / exportJsonl`，缺列自动 `ALTER ... ADD COLUMN`（不处理删列/改类型） |
| UI | `src/shell/SettingsView.tsx` 关于 pane；`packages/ui/src/patterns/StatusBar.tsx`；Modal / Drawer / Toast 齐备 |
| 服务端 | 仓库内**零**服务端代码；CI 只跑 `pnpm test` |
| 契约冲突 | `docs/release-windows.md`、`docs/deploy.md`、2026-10-23 内部发布计划仍写「首版不做自动更新 / 不引入新网络服务」，动工前须同步 |

---

## 3. 关键约束

| # | 约束 | 影响 |
| --- | --- | --- |
| C1 | 安装包约 **401MB** | 需要进度、断点续传、磁盘预检、哈希校验；差分优化先实测后定 |
| C2 | 无 Authenticode 证书 | `verifyUpdateCodeSignature: false`（安装时不验证任何签名）；OS 层无信任锚，**必须**靠 §5.2 的单一已验签字节入口兜住 |
| C3 | 私有化 / 无遥测 | 检查请求零身份信息、可一键全关、可指向内网或本地目录 |
| C4 | Renderer 沙箱 + 导航守卫 | 网络 / 文件 / 进程只在 Main；更新说明结构化渲染，禁止加载远程 HTML |
| C5 | `data\` 不可破坏 | 安装前整目录一致性快照；升级不清理用户数据 |
| C6 | `perMachine: false` | NSIS `/S` 免 UAC，但**应用仍在运行时会撞文件占用**，必须先完全退出 |
| C7 | 无单实例锁 / 双 `before-quit` 钩子 / Pi 池无停止钩子 | 必须新增显式关机协议（§7.7） |
| C8 | 静态文件托管无事务能力 | 指针切换不依赖服务端原子写；两文件窗口靠客户端 fail closed 覆盖（§8.2） |

> **前置变更**：本设计推翻了已批准的「首版不做自动更新」契约。动工前需更新 `docs/release-windows.md`、`docs/deploy.md`、对应 plan、`branding.ts`、`SettingsView.tsx` 与 `test/release-config.test.ts` 断言。

---

## 4. 总体架构

```text
┌─ 发布侧（研发机 / CI）────────────────────────────────────────────┐
│  构建产物 → 生成 release.json（含 sha512/expiresAt/sequence）      │
│          → 离线 Ed25519 私钥签名 → 上传版本目录 → 切单一逻辑指针    │
└──────────────────────────┬───────────────────────────────────────┘
                           │ 上传（一次性）
┌──────────────────────────▼───────────────────────────────────────┐
│  更新源 · RAG 服务 <IP>:80 下的 /sparkii-updates/ 静态目录         │
│  channel.json + .sig        ← 唯一指针（不上传 latest.yml）         │
│  releases/<version>/release.json + .sig + 安装包 (+ blockmap)      │
└──────────────────────────┬───────────────────────────────────────┘
        │                                    │
        │ 清单/策略数据（仅 verifier 请求）   │ 安装包（updater 按已验签绝对 URL 下载，
        │                                    │ 受自定义 httpExecutor 约束，终检 sha512）
┌───────▼────────────────────────────────────▼─────────────────────┐
│  客户端 Main 进程                                                 │
│  verifier（取指针→清单→验签→新鲜度/防降级/nonce）                  │
│    → 本地派生 latest.yml → updater.setFeedURL(本地 feed)            │
│    → checkForUpdates / downloadUpdate                              │
│    → installer.ts：detached watchdog → NSIS /S → 重启自检          │
│    → local-artifacts 扫描 pending/ 推导「可安装」                   │
│    → IPC + 事件 → Renderer（状态栏 / 关于页 / Modal）               │
│  落盘：settings.json · update-state.json · pending/ · audit.db     │
└─────────────────────────────────────────────────────────────────┘
```

**分层原则**：`verifier` 独占**清单与策略数据的网络入口**与信任判定；`electron-updater` 只做 semver 比较、下载与校验，**不承担安装执行**（§7.7）；策略（调度、二选一、提醒节流、审计）、UI 与安装执行自研。

---

## 5. 技术路线

### 5.1 electron-updater 是什么

运行时 npm 库，与 `electron-builder` 同厂但分工不同：builder 在 CI 生成更新元数据，updater 在用户机器消费它。Windows 实现类是 `NsisUpdater`。常用 API：`setFeedURL` / `checkForUpdates()`（只拉清单比 semver，不下载）/ `downloadUpdate()`（进度、差分、sha512 校验）/ `quitAndInstall()`（退出并静默运行 NSIS）。**本期不使用 `quitAndInstall()`**——包迁移到 `pending/` 后其缓存路径失效，见 §7.7。

`publish: { provider: 'generic', url }` 配置会让 electron-builder 生成 `latest.yml` 与 `.blockmap`；**`--publish never` 只禁止上传、不禁止生成**，现有 `dist` 脚本无需去掉该参数（此结论已核实）。注意：构建产出的 `out/latest.yml` **不上传服务器**——服务端唯一权威清单是 `release.json`，客户端按 §5.2 自行派生 `latest.yml`；保留 `publish` 配置只为拿到 `app-update.yml` 元数据（本期必需）与 `.blockmap`（**仅任务 0 实测与 P2 准备，本期不启用差分**）。

### 5.2 网络层接管（任务 0 实测后 **定案 A**，2026-11-06）

**问题**：generic provider 用自己的 HTTP 客户端拉 `latest.yml`、`.blockmap` 与安装包，默认跟随重定向、无 host 白名单；它不认识我们的 `.sig`。若让它直连服务器取元数据，「验签的字节」与「updater 使用的字节」就是两次独立请求，HTTP 下可被投毒。

> **定案（任务 0）**：**采用主方案 A —— 本地 `file://` 派生 feed + 自定义 `httpExecutor`**。
> A′ 与 B 的**实现描述已删除**，仅保留下方「决策记录」。
> 完整实测命令、stdout 摘要、退出码、产物路径与 9 项结论见 `docs/superpowers/specs/2026-11-06-task0-results.md`；本协议的实现契约见 `docs/superpowers/specs/2026-11-06-update-interfaces.md`。

#### 5.2.1 定案方案 A（唯一可执行路径）

1. `verifier.ts` 是**清单与策略数据的唯一**对外 HTTP 模块：取 `channel.json` + `.sig` → 验签 → 取 `releases/<v>/release.json` + `.sig` → 验签 → 校验指针中的清单 sha256、新鲜度、sequence、nonce → 得到**已验签的原始字节**。
2. 客户端从这份已验签清单**本地派生** `latest.yml`，写到 `data/updates/feed/`。派生文件中的 artifact 路径必须写成**绝对远程 URL**（`<baseUrl>/releases/<v>/<artifact.name>`，取自已验签清单并校验 host 与 `baseUrl` 一致），否则 generic provider 会把它拼到本地 feed 目录下去找 401MB 包。**实测成立**：`newUrlFromBase()` = `new URL(path, base)`，绝对 URL 覆盖 base；探针在 `file://` 与 loopback 两种 feed 下都解析出预期的绝对远程 URL（T0-3）。
3. `updater.setFeedURL({ provider: 'generic', url: 'file://<data/updates/feed>/' })`：元数据读取**只读本地**；安装包下载仍由 `downloadUpdate()` 按第 2 步的绝对 URL 执行（**需要 Range 断点续传；本期不启用差分**），下载完成后必须复核 sha512 与 bytes 才能进入 `pending/`。
   - **实测补充（§0.7 P0-5）**：`setFeedURL` 接受 `file://` 且 provider 正确派生 `file:///…/latest.yml`，但**默认 `ElectronHttpExecutor` 把请求交给 `electron.net.request`（仅支持 http/https），`file:` 必然失败**。因此 A 的成立前置是：自定义 `httpExecutor` 在 `request()` 层识别 `file:` 并**直接 `readFileSync` 本地派生文件**（零网络请求），其余情形一律 fail closed。这不改变「验签字节 == 策略依据 == updater 元数据输入」的不变量。
4. **`httpExecutor` 注入（M-new-4 闭合，实测可注入）**：给 `AppUpdater` 注入自定义 executor，**必须在 `setFeedURL()` 之前赋值**（`setFeedURL` 在调用时把 executor 捕获进 `createProviderRuntimeOptions()`，探针 `client.executor === injected` 为 true）。executor 需同时实现：
   - `request(options)`：仅处理本地 `file:` 频道文件；任何其它 scheme 一律拒绝。
   - `download(url, destination, options)`：包体下载。**强制** scheme 与 host/port 等于 `settings.update.baseUrl`、`maxRedirects = 0`（不跟随任何重定向）、拒绝 `https → http` 降级、单次连接 8s 超时、响应体字节数超过 `artifact.bytes` 立即 abort、自行复核 sha512 与 bytes、上报 `onProgress`、响应 `cancellationToken`。`disableDifferentialDownload = true` 恒定（**本期不启用差分**），updater 不会调用 `downloadToBuffer()` 或请求 `.blockmap`。
   - 锁定 **`electron-updater@6.3.0`**（>= 6.3.0，含 CVE-2024-39698 修复）。因实测可注入，**不启用 §5.2 旧稿的「已知取舍」降级**；§6.4 中该残余风险条目按「已由自定义 executor 阻断」记录。
5. host 白名单、8s 超时、响应体先验后解析，作用于 `verifier.ts` 的 fetch，真实有效。
6. 禁止用 `UpdateInfo.releaseNotes` / `info.version` 直接渲染 UI；展示数据一律取自已验签的 `release.json`。
7. **实测补充（§0.7 P0-6）**：`setFeedURL()` 只让 `clientPromise` 非空、绕过 **feed provider**；`getOrCreateDownloadHelper()` 与 `NsisUpdater.verifySignature()` 仍独立读 `app-update.yml`，因此 `updaterCacheDirName` 与「无 `publisherName` ⇒ 跳过验签」**仍生效**。

#### 5.2.2 决策记录（被否决路径，仅记录，不再含实现描述）

| 路径 | 任务 0 实测 | 定案 |
| --- | --- | --- |
| **A**（本地 `file://` feed + 自定义 executor） | `setFeedURL` 接受 `file://`；注入后 `checkForUpdates()` 成功返回 `0.2.0`；绝对 artifact URL 覆写成立；`httpExecutor` 可注入且被 provider 采用；`app-update.yml` 缓存/验签配置仍生效 | ✅ **定案采用** |
| **A′**（loopback 临时静态服务） | 实测**同样可行**（`checkForUpdates()` 成功、绝对 URL 覆写成立） | ❌ **否决**：需额外引入随机端口 + token 路径 + 服务起停 + 非 loopback 拒绝；且 §5.2.1 步骤 4 要求 host/port 等于 `settings.update.baseUrl`，loopback feed 的 `127.0.0.1:<随机端口>` 必须开豁免分支，扩大攻击面与复杂度。A 的元数据请求没有 host，host 白名单可只作用于包体下载。保留为 P2 备选 |
| **B**（自研下载、完全绕开 updater 的元数据/下载通道） | A 已实测可行，无需触发 | ❌ **否决**：无理由放弃 electron-updater 的 semver 比较、`downloadUpdate()` 下载管线与 `UpdateInfo` 二次比对；自研 Range/断点/进度/缓存工作量与风险更高，且会连锁触发 D5 / §10 依赖修订。保留为 A 后续被推翻时的兜底记录 |

> 官方 quick-start 建议「Do NOT call `setFeedURL`」，本设计因地址可配必须偏离；以实测为准。**全稿不存在「updater 拉远端 `latest.yml`」这条路径。**服务器自始至终不上传 `latest.yml`（B-new-1）。

### 5.3 已撤回的判断（保留记录，避免重犯）

| 曾说过 | 复核结果 |
| --- | --- |
| `--publish never` 与 `latest.yml` 冲突 | ❌ 事实错误，`never` 只禁上传 |
| 无代码签名证书 = L2 硬门槛 | ❌ 说重了；per-user NSIS 免 UAC，功能可跑通 |
| 自研 50 行比 electron-updater 省事 | ❌ 低估工作量，且策略层两者都一样要写 |
| HTTP 下靠 Ed25519 清单签名即可安全 | ❌ **错误**，见 §0.2 第 1 条；必须单一已验签字节入口 |
| `allowInsecureHttp` 需要显式开关 | ❌ 已取消，HTTP 默认允许，设置页仅一行提示 |
| 已下载状态要落盘 | ❌ 改为由磁盘事实推导 |
| 迁移到 `pending/` 后仍可 `quitAndInstall()` | ❌ 缓存路径失效；本期改自管 watchdog + `/S`（§7.7） |
| 备选方案可让 updater 拉远端 `latest.yml` 再逐字段比对 | ❌ 与「服务器不上传 `latest.yml`」矛盾，已删除该路径（§5.2） |

### 5.4 配置（唯一载体 + 注入点分离）

**唯一构建配置载体是 `electron-builder.config.mjs`**；把现有 `electron-builder.yml` 的全部内容迁入其中，然后**删除 `electron-builder.yml`**，`dist` 脚本改为：

```text
electron-builder --win nsis --publish never --config electron-builder.config.mjs
```

```js
// electron-builder.config.mjs
export default {
  appId: 'com.sparkii.desktop',
  productName: 'Sparkii',
  artifactName: 'Sparkii-${version}-win-${arch}.${ext}',
  asar: true,
  // …从 electron-builder.yml 原样迁入的 extraResources / nsis / files 等
  publish: {
    provider: 'generic',
    // 【构建期占位常量】仅为让 builder 生成 latest.yml / .blockmap / app-update.yml。
    // 该 URL 永不用于运行时网络请求：运行时 setFeedURL 指向本地派生 feed，
    // 真正的服务器地址由 verifier 从 settings.update.baseUrl 读取。
    url: 'http://localhost/sparkii-updates/',
  },
  win: { verifyUpdateCodeSignature: false },
};
```

**运行时默认地址在另一处注入**：`build:main` 的 esbuild `define` 注入 `__SPARKII_UPDATE_URL__ = process.env.SPARKII_UPDATE_URL ?? ''`，由 `update/config.ts` 读为 `settings.update.baseUrl` 的默认值；未注入则默认空（= 关闭自动检查，设置页可手填 IP）。这样把「builder 的构建期元数据 URL」与「客户端的更新源地址」彻底解耦，不再有双载体歧义（M-new-2 闭合）。

**发布公钥同属编译期注入**（2026-11-06 集成补齐，与上面的地址注入并列的第二条 define 通道）：`build:main` 读 `SPARKII_RELEASE_KEYS_FILE`（`scripts/release-keys.mjs` 产出的 `public-key.json` 绝对路径）并把其**原文**内联为 `__SPARKII_RELEASE_PUBLIC_KEYS__`，由 `update/config.ts` 的 `parseReleasePublicKeys()` 解析成 `RELEASE_PUBLIC_KEYS`。三种口径必须记住：
- 未设置该变量 ⇒ 公钥表为空 ⇒ **任何清单都验不过**（fail closed，等价于自动更新关闭），绝不会退化成「放行未签名」；
- 表内任一条目不可信（`kid` 形态、PEM 为空、日期不可解析）⇒ **整批丢弃**，不接受「半套公钥表」；
- `SPARKII_RELEASE_KEYS_FILE` 指向空文件 ⇒ 构建直接抛错，不产出一个静默不可更新的包。
私钥仍由用户本人离线保管、绝不进仓库；公钥表本身不含机密，可以随包分发。

- `dist` 后加产物断言：`out/latest.yml` 与 `resources/app-update.yml` 存在、`publish.url` 为占位常量、且**产物清单中不含真实服务器 IP**；构建配置含 `win.verifyUpdateCodeSignature: false`，且 `resources/app-update.yml` **不含 `publisherName`**（§0.7 P0-4 / §5.5 实测订正）。
- `autoDownload = false` 恒为真（**必须写单测**），`autoInstallOnAppQuit = false`。
- 公钥作为编译期常量内置；若改用 PEM 资源需加入 `extraResources`。
- `build:main` 是单入口 esbuild bundle，新模块必须被 `main/index.ts` import。

### 5.5 `verifyUpdateCodeSignature: false` 的准确含义

默认 `true` 时，electron-builder 在构建期把解析出的 `publisherName` 写入 `app-update.yml`，更新期 electron-updater 用 `Get-AuthenticodeSignature` 比对下载包签名者，不匹配即拒装。设为 `false` 时（`win.verifyUpdateCodeSignature: false` 在 **`electron-builder.config.mjs`** 中），`WinPackager.isForceCodeSigningVerification` 为 false，`PublishManager` **不计算也不写入 `publisherName`**；`NsisUpdater.verifySignature()` 读到 `publisherName == null` 即返回 null，于是**安装更新时不验证任何签名**（只影响 electron-updater 运行时校验，不影响首次手动安装）。

> **§0.7 P0-4 实测订正**：`app-update.yml` 里**没有** `verifyUpdateCodeSignature` 这个键——旧稿「写入的是 `verifyUpdateCodeSignature: false`」是错的。实测产物只有 `provider / url / updaterCacheDirName` 三行。产物断言据此为：**构建配置含 `win.verifyUpdateCodeSignature: false`，且 `resources/app-update.yml` 不含 `publisherName`**。

本期改由自管 watchdog 执行安装，该开关保留在构建配置中属于「保留官方元数据一致性」，但**本设计的安全性不依赖它**——信任完全来自 §6.3 的内容签名。

本期无 Authenticode 证书只能如此，前提是 §5.2 的单一已验签字节入口成立。相关公开漏洞为 CVE-2024-39698（校验开启时仍可被 `cmd.exe` 环境变量展开绕过，前提正是 HTTP MITM，修复于 electron-updater 6.3.0-alpha.6），需锁定 `electron-updater >= 6.3.0`。旧稿称「已有公开 CVE 正是此配置」不准确，已订正。采购证书后必须删除该开关并写进发布 checklist。

---

## 6. 更新协议

### 6.1 服务器目录（单一指针）

```text
/sparkii-updates/
├── channel.json                  # 唯一逻辑指针（配套 .sig）：目标版本目录 + 清单 sha256 + sequence
├── channel.json.sig              # 指针签名
└── releases/
    └── 0.3.0/
        ├── release.json          # 唯一权威清单（含全部策略字段）
        ├── release.json.sig
        ├── Sparkii-0.3.0-win-x64.exe
        ├── Sparkii-0.3.0-win-x64.exe.blockmap   # 可选，仅任务 0 实测 / P2 差分用
        └── release-manifest.json # 沿用现有 schema 1，人工交付 / 构建审计
```

**不再上传 `latest.yml`，也不单独签它**——`latest.yml` 由客户端从已验签清单本地派生。这样只有一份权威清单、一次信任判定、一个逻辑指针，消除「两份清单各自合法但混搭」的竞态。

#### 6.1.1 `channel.json` schema（v3 补齐并订正）

```json
{
  "schemaVersion": 1,
  "product": "Sparkii",
  "channel": "stable",
  "platform": "win-x64",
  "sequence": 18,
  "targetVersion": "0.3.0",
  "manifestPath": "releases/0.3.0/release.json",
  "manifestSha256": "<hex, release.json 原始字节>",
  "signaturePath": "releases/0.3.0/release.json.sig",
  "publishedAt": "2026-11-06T05:20:00.000Z"
}
```

约束：
- `sequence` 的**唯一权威来源是 `channel.json`**（全局单调计数器，递增只发生在发布侧组装指针时）。`release.json` 必须携带**等值镜像字段** `sequence`，两者**严格相等**否则 fail closed。镜像的作用是让 `pending/` 内的伴生清单在离线状态下仍能提供 `sequence` 供 §6.5 / §7.3 校验，**不构成第二处计数定义**；§8.2 的指针 sequence 递增只作用于指针，清单写同值。
- `manifestPath` / `signaturePath` 必须匹配 `^releases/[0-9A-Za-z.+-]+/[A-Za-z0-9._-]+$`，禁止 `..`、绝对路径、query、fragment；拼到 `baseUrl` 后 host 必须仍等于 `baseUrl` 的 host。
- `manifestSha256` 是对**实收 `release.json` 原始字节**的校验，先验哈希再验签，防止「合法签名 + 被换过的清单字节」。
- `channel` 本期固定 `stable`，客户端不接受其他值。
- 指针签名覆盖 `channel.json` 的原始字节（含 `kid`，见 §6.3）。

### 6.2 `release.json` schema

```json
{
  "schemaVersion": 2,
  "product": "Sparkii",
  "channel": "stable",
  "platform": "win-x64",
  "sequence": 18,
  "nonce": "…",
  "publishedAt": "2026-11-06T05:20:00.000Z",
  "expiresAt": "2026-11-09T05:20:00.000Z",
  "version": "0.3.0",
  "minSupportedVersion": "0.1.0",
  "rollback": false,
  "allowDowngrade": false,
  "mandatory": false,
  "mandatoryAfter": null,
  "rollout": { "percentage": 100, "salt": "rel-2026-11" },
  "releaseNotes": { "summary": "…", "highlights": ["…"] },
  "artifact": {
    "name": "Sparkii-0.3.0-win-x64.exe",
    "bytes": 401196487,
    "sha512": "<base64, 与派生的 latest.yml.sha512 同源>",
    "url": "releases/0.3.0/Sparkii-0.3.0-win-x64.exe"
  },
  "requires": { "minOSBuild": "10.0.19045", "minFreeDiskBytes": 1200000000 }
}
```

要点：
- **`expiresAt`（建议 72h）与 `nonce` 是硬性字段**，用于阻断历史合法清单 / 回滚清单的无限重放。
- `sequence` 必须与 `channel.json.sequence` 相等（§6.1.1），只能增不能减。
- `sha512` 采用 electron-updater 要求的 base64 格式，与派生的 `latest.yml` 同源，不再维护双哈希。
- `artifact.url` 是**相对路径**；客户端拼接前校验其形态，拼出的绝对 URL 的 host/port/scheme 必须与 `baseUrl` 一致，且成为 §5.2 下载的唯一允许目标。
- `channel` 是**服务端常量**（本期固定 `stable`，D8 不要 beta 通道），客户端不提供切换配置。
- `allowDowngrade` 默认 `false`；回滚清单必须带 `reason`、更短的 `expiresAt`、独立紧急密钥签名，且**要求用户逐次显式二次确认**。
- `minSupportedVersion` 用于桥接版本与直跳拦截（§7.6）。

### 6.3 信任链

1. 发布侧对 `channel.json` 与 `release.json` 的**原始字节**分别做 Ed25519 签名（`base64`），签名头含 `kid`；**`kid` 必须计入签名输入**：`sign(kid || 0x00 || sha256(fileBytes))`。不做键排序归一化，避免解析差异。
2. 客户端内置公钥列表，按 `kid` 选钥；每把密钥带 `notBefore / notAfter`。
3. 客户端验签顺序（任一失败 **fail closed**：当作「无更新」+ 写 `update.verify-failed`，绝不退化成放行未签名）：
   1. 指针形态校验（§6.1.1 路径正则、host 一致）；
   2. 指针签名；
   3. 实收 `release.json` 字节的 sha256 == `manifestSha256`；
   4. 清单签名；
   5. `release.sequence == channel.sequence` 且 `channel.publishedAt` 与 `release.publishedAt` 一致；
   6. `now <= expiresAt`、`publishedAt` 在合理窗口；
   7. `sequence > lastSeenSequence`；`sequence == lastSeenSequence` 时 **`nonce` 必须与本地记录的 `(sequence → nonce)` 绑定值相同**，不同即拒绝（Minor · 3 闭合：挡住「同 sequence 换清单」的重放）；nonce 本身不要求全局唯一或客户端生成；
   8. `version >= app.getVersion()`（除非 `allowDowngrade` + 二次确认）→ `minSupportedVersion` → `requires` 预检。
4. **`lastSeenSequence` 与 `(sequence → nonce)` 绑定记录必须防篡改**：用 `keyring/`（DPAPI）中的密钥做 HMAC，并冗余记录已安装版本下限。`update-state.json` 缺失、解析失败或 HMAC 校验失败时 **fail closed**：拒绝一切自动更新，关于页显示「更新状态异常，需手动恢复」，**不得回退到默认状态**。
   - **固有局限（m2 登记，2026-11-08）**：下限由两个锚点共同保护——`update-state.json` 与 DPAPI 镜像。二者**被同一用户同时抹掉**时，本机无法区分「真首装」与「双删」，会按首装放行（**不是**显式报错）。这是 mirror 机制的固有边界；要抗删需要第三个机器级锚点（如服务端 per-install 序号下限），列为独立安全加固议题，本轮不实现、也不假装已闭合。实际利用仍需有效签名 + 未过期 `expiresAt`（§6.3 第 3/6 条）且同用户可删两处，边界低。
5. 包体在下载完成后、进入 `pending/` 前、点「安装」前各校验一次 sha512 与 `bytes`。
6. 不设「跳过验签」「信任此服务器」开关，不做 `rejectUnauthorized: false`。

### 6.4 为什么 HTTP 可用，以及它的边界（改写旧稿）

HTTP 本身不提供任何信任，信任完全来自 §6.3 的内容签名与 §5.2 的单一字节入口。前提成立时，攻击者**做不到**伪造新版本或替换安装包（需要私钥）。**安装包下载层的中间人也不需要被「信任」**：URL 与 sha512 均来自已验签清单，替换字节只会导致终检失败并写审计，无法造成代码执行（§5.2 已知取舍）。

但攻击者**可以**：
- 阻断或延迟响应 → 冻结更新（由 `expiresAt` + 关于页「上次成功检查时间」暴露）；
- 重放任意**历史合法**清单与配套包 → 试图降级（由 `sequence` HMAC + `nonce` 绑定 + `expiresAt` + `version >= 当前版本` 共同阻断）；
- 重放最高位的合法回滚清单（由短 `expiresAt` + 用户二次确认阻断）；
- 在**下载通道**上做重定向 / 超大响应 / 内网探测（SSRF 类）：由自定义 `httpExecutor` 阻断；若实测不可注入，按 §5.2「已知取舍」由字节上限与超时兜住，并把该项记为 P2 加固项。

因此旧稿「HTTP 下攻击者能做到的只剩让你收不到更新」是**低估威胁**，已订正。`sequence` 只能防「比已见过更旧」，不能防「重放最高位合法清单」——新鲜度校验与 nonce 绑定是必须的。

设置页在 `baseUrl` 为 `http://` 时显示一行中性提示「当前为 HTTP，更新完整性由数字签名保证」，不阻断。将来做 L2 全面铺开时建议至少配自签证书或内网 CA。

### 6.5 交叉校验与防重放

- 客户端派生 `latest.yml` 时所有字段**只来自已验签的 `release.json`**，不引入任何外部输入；派生后立即回读一遍，逐字段与清单比对。
- 定案 A 下同样跑这条二次保险：在 `update-available` / `checkForUpdates()` 返回的 `UpdateInfo` 里把 `version / path / sha512 / size` 与已验签清单逐字段比对，任一不等即 fail closed 并写 `update.verify-failed`。**这是二次保险，不是信任来源**（旧稿曾把它当主防线，已订正）。实现落点：`updater-adapter.ts` 的 `crossCheckUpdateInfo()`，由 `service.ts` 的 `checkedUpdater()` 在 `checkForUpdates()` 前后各调一次。
  - 记录（非可执行分支）：被否决的 A′（loopback feed）与 B（自研下载通道）曾在此处有各自的校验口径——A′ 与本条相同，B 没有 `UpdateInfo` 可比、全部校验落在 `downloader.ts` 的终检。两条路径的实现描述已按 §5.2.2 删除，此处仅保留历史口径，避免被误读为仍有备选实现。
- `local-artifacts.ts` 扫描 `pending/` 时同样校验：清单签名、`sha512`、`bytes`、`sequence > lastSeenSequence`（或同 sequence 且 nonce 匹配）、`version >= app.getVersion()`、`expiresAt` 未过。不满足即删坏包 + 写 `update.verify-failed`，**不显示「可安装」**。
- 不接受「管理员往目录里裸放包」：离线侧载需走 `sparkii import-update` 命令，走同一套校验并写审计。

### 6.6 可配置地址与无遥测

- `settings.update.baseUrl` 是一等可配置项，构建期由 `SPARKII_UPDATE_URL` 经 `build:main` 的 esbuild `define` 注入默认值（§5.4），运行时由 `verifier.ts` 使用；**`setFeedURL()` 只负责把 updater 指向本地派生 feed，不承载服务器地址**。留空 = 关闭自动检查。HTTP / HTTPS 都支持。
- `baseUrl` 变更写审计并要求二次确认；host 白名单以当前配置为准，但**不自动放宽到任意公网地址**（限制为既定 IP / 内网段或至少记录变更并提示）。
- 只有 `GET channel.json` / `release.json` / `.sig` / 安装包，无 query、无自定义 header、无设备 ID、无 UA 注入。`installId` 仅用于本地抖动与灰度分桶，**永不出网**；重置写审计并说明会影响分桶。
- 设置页提供「查看本地检查记录 / 重置 installId / 关闭自动检查」三个入口。

---

## 7. 客户端设计

### 7.1 模块划分（`apps/desktop/electron/main/update/`）

```
├── types.ts             # UpdateConfig / UpdateState / UpdatePhase / 展示模型
├── config.ts            # settings.update 解析、归一化、默认值（含 __SPARKII_UPDATE_URL__）、校验
├── verifier.ts          # 清单与策略数据的唯一网络入口：取指针/清单 → 验签 → 新鲜度/防降级 → 派生 latest.yml
├── updater-adapter.ts   # 封装 NsisUpdater；feed 指向本地；自定义 httpExecutor；UpdateInfo 二次比对
├── decision.ts          # 二选一、跳过/稍后、minSupportedVersion 硬闸门
├── downloader.ts        # downloadUpdate 进度/断点续传/磁盘预检/字节上限；完成后迁移到 pending/
├── local-artifacts.ts   # 扫描 pending/ + 验伴生清单 → 推导「可安装」
├── installer.ts         # 关机协议、备份、哨兵、detached watchdog + NSIS /S、重启自检
├── state-store.ts       # 调度与防降级数据（原子写，HMAC 保护 sequence 与 nonce 绑定）
├── audit.ts             # 复用 AuditStore 写 update.* 事件
├── scheduler.ts         # 统一闸门 shouldCheck() + 抖动 + 退避
└── service.ts           # 门面：注册 IPC（含验签门禁）、推送事件、单实例锁
```

### 7.2 状态机（状态由磁盘事实推导）

```text
启动 ──> 本地扫描 pending/（零网络、立即、不受闸门约束）──┐
                                                        ├─ 合并计算 → UI 状态
网络检查（按 §7.10 闸门）────────────────────────────────┘

available ──点「下载」──> downloading ──校验通过──> 包进入 pending/
                                                        │
                                          点「安装」    │（无状态文件，随时可推导）
                                              ▼        │
                                  [有活跃进程？] ─是→ 确认 ──取消──> 回到「可安装」
                                              │ 否/确定
                                              ▼
                                     installing → restarting → completed
```

| 状态 | UI 表现 | 可执行动作 |
| --- | --- | --- |
| `available` | 状态栏 pill「有新版」 | 下载 / 稍后 / 跳过此版本 |
| `downloading` | 状态栏小进度条 + 百分比 + 已下载/总量 + 保存位置；不弹窗 | 取消下载（清理 `.part`） |
| `readyToInstall` | 状态栏「已下载完，可以安装」 | **安装** / 删除已下载包 |
| `installing` | 确认弹窗（仅有活跃进程）+ 短暂「安装中」 | — |
| `restarting` | 应用退出，watchdog 拉起安装器 | — |
| `completed` / `rolledBack` | 重启自检结果；失败给明确提示 | 重试 / 回旧版 |

`UpdatePhase` 每次启动重新计算，不持久化下载/安装阶段。**仍需持久化的三样**（Minor · 1 闭合：v1 误称「与安全无关」）：
1. `update-state.json` 的调度数据与防降级状态（HMAC 保护，**直接关系安全**）；
2. `pending/` 内与包同目录的伴生签名清单（**直接关系安全**，是 derived state 的信任来源）；
3. 安装事务的临时哨兵 `pending-update.json`（含快照哈希清单，属恢复数据）。

### 7.3 IPC 与验签门禁

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| invoke | `getAppVersion` / `getUpdateState` | 版本、阶段、进度、上次检查 |
| invoke | `checkForUpdate` | 手动触发（`force`） |
| invoke | `downloadUpdate` | **IPC 层先验签门禁**：重新验清单签名/新鲜度/sequence/nonce/minSupportedVersion，通过才调用 updater |
| invoke | `cancelDownload` | 清理 `.part`，回 `available` |
| invoke | `installUpdate` | **IPC 层再验一次**：重新打开包文件句柄验 sha512 + 伴生清单签名 + sequence / nonce 绑定 + `expiresAt`，持有句柄直到交给安装器 |
| invoke | `clearDownloaded` | 删除已下载包 |
| invoke | `deferUpdate` / `skipUpdate` | 稍后 / 跳过此版本 |
| invoke | `getUpdateSettings` / `saveUpdateSettings` | 地址、开关；变更写审计 + 二次确认 |
| event | `sparkii:event:update-state` / `update-progress` | 阶段变化 / 下载进度（节流 ≥200ms） |

新增方法必须同步 `preload/api-types.ts`、`preload/api.ts`、`main/ipc.ts`、`test/preload-api.test.ts`。所有 IPC 只传结构化数据，**不传 URL 让 Renderer 加载**。

### 7.4 设置项（`AppSettings.update`）

```ts
update?: {
  baseUrl?: string;              // 默认由 __SPARKII_UPDATE_URL__ 注入；留空 = 关闭自动检查
  autoCheck?: boolean;           // 默认 true
  checkIntervalHours?: number;   // 默认 24，0 = 仅手动
  checkOnStartup?: boolean;
  startupDelaySeconds?: number;  // 默认 90 + 抖动
  checkOnNetworkResume?: boolean;
  checkOnSystemResume?: boolean;
  remindIntervalHours?: number;  // 默认 24
  requestTimeoutMs?: number;     // 默认 8000
  autoDownload?: false;          // 恒 false，写死 + 单测
};
```

不设 `allowInsecureHttp`、不设 `channel`（无 beta 通道）。走现有 `loadSettings / saveSettings`，**保留 merge 语义**，不得复用 `rag.baseUrl`。

### 7.5 UI 与交互

| 位置 | 内容 |
| --- | --- |
| 设置 → 关于 | 当前版本、更新源地址、上次检查时间、自动检查开关、隐私说明、「检查更新」；当前阶段与已下载包信息（版本号、大小、保存位置） |
| 状态栏 | 一行低打扰 pill：`有新版 0.3.0` → `下载中 34%` → `已下载完，可以安装`。**不做居中模态、不加遮罩、不抢焦点**；点击展开小面板 |
| 下载进度 | 状态栏细进度条 + 百分比 + 已下载/总量；小面板显示保存位置并可「打开所在文件夹」 |
| 下载完成 | pill 变为「已下载完，可以安装」+ 一次性轻量提示，不强制处理 |
| 更新 Modal | 版本号、发布说明、包体积——**一律取自已验签的 `release.json`**，禁用 `UpdateInfo.releaseNotes` |
| 本地 0.2 + 服务器 0.3 | 并列两栏 + 两个按钮「安装已下载的 0.2」「跳过 0.2，直接升级 0.3」，不替用户决定；pill 显示「有 2 个可选版本」 |
| 点「安装」· 无活跃进程 | 直接开始，不额外弹窗 |
| 点「安装」· 有活跃进程 | 居中确认：「安装会关闭正在运行的智能体，可能丢失未完成的工作，是否继续？」并列出将被放弃的待审批项数量。取消 = 回到「可安装」，包保留 |
| 重启后 | 成功不打扰；失败给明确提示 + 重试/回滚入口 |

更新提示是**通知**不是错误，不进 `ErrorCenter` / `errors.db`。

### 7.6 下载与 `pending/` 迁移

- 用户点「下载」才触发 `downloadUpdate()`。下载前 `decision.ts` 做**硬闸门**：从已验签清单读 `minSupportedVersion`，`semver.lt(app.getVersion(), minSupportedVersion)` 直接拒绝并提示「需先安装桥接版本 X」，**绝不调用 updater 下载**。
- `Range` 断点续传、`.part` 临时文件、预检 `bytes × 2 + 余量` 磁盘空间、进度节流 ≥200ms，`download-progress` 累计字节超上限立即 abort（§5.2 已知取舍）。
- 下载完成后：验 sha512 与 `bytes` → 把包从 electron-updater 的缓存**迁移**到 `data/updates/pending/<version>/`，同目录落下**已验签的 `release.json` + `.sig`** 作为伴生清单 → 清理 updater 缓存。**绝不放 `%TEMP%`**。
- 若服务器在等待安装期间发布了 0.3：选 0.3 时先把 0.2 包改名保留，等 0.3 校验通过再删；0.3 失败则恢复 0.2 可安装状态。`minSupportedVersion` 不允许直跳时该按钮置灰并说明原因。
- `.blockmap` 差分：**本期恒定 `disableDifferentialDownload = true`、`release.json` 不生成差分 URL**，因此 updater 不会发起 `.blockmap` 请求；发布 CLI 仍上传 blockmap 供任务 0 实测与 P2 评估（见 D6 / §8.2）。将来启用时，差分组装完成后**必须复核最终文件 sha512** 与已验签清单一致，且 Range 请求受 §5.2 `httpExecutor` 约束。

### 7.7 安装事务与关机协议（v3 重写）

**单实例锁**：在 `app.whenReady()` **之前**调用 `requestSingleInstanceLock()`，失败直接 `app.exit(0)`（不走 `before-quit`）；`second-instance` 只聚焦已有窗口。

**为什么不用 `quitAndInstall()`（M-new-3 闭合）**：electron-updater 的 `quitAndInstall()` 从**自己的下载缓存**定位安装包，而 §7.6 已把包迁移到 `pending/<version>/` 并清了缓存；调用它会找不到包、或指向已被删的旧路径，且我们还需要自管备份、哨兵、退出码与恢复介质。因此本期**安装执行完全自管**，electron-updater 只承担版本比较与下载。

**显式关机协议**（严格顺序，缺一不可）：

1. 设置 `isUpdating = true`，关闭新任务入口；`before-quit` 钩子识别该标志，更新退出时**不** `preventDefault()`，避免与二次 `app.quit()` 竞争。
2. 审批门：调 `gate.listPending()`，逐条写 `update.install-abort` 审计并 `transition(p, 'expired')`（或持久化到 `sessions.db` 供新版恢复）。**未清空前不得进入安装**；确认弹窗列出将被放弃的待审批项数量。
3. 停进程（§0.7 P0-1 修订）：调用**既有** `rt.pool.stopAll()`（等待所有 Agent 会话结束），并在 `PiRuntimePool` 上补 `stopped` 闸门使后续 `acquire()` 一律拒绝新任务 → `documentParseSupervisor.beginQuit()` → `reviewer.dispose()`。**不再新造 `pool.stop()` 方法**。
4. 关库：`audit.close()` / `chatSessions.close()` / `errors.close()`，让 WAL 自动 checkpoint。
5. **一致性快照**：对**整个 `data\`** 做快照（§7.8），逐文件记录 SHA256 写入哨兵。
6. 写哨兵 `data/updates/pending-update.json`：`phase` / 旧版本 / 目标版本 / `expiresAt` / 备份路径 / 包 sha512 / 包绝对路径 / 安装目录 / 时间。
7. **先退出、后安装（严格时序，N9 闭合）**：
   1. 启动 detached watchdog（**独立镜像名的可执行载体**，Node SEA；运行时部署在 `$INSTDIR` 之外），传入主进程 PID 与 `pending-update.json` 路径；此阶段它**只等待，不做任何安装动作**。载体硬约束（B1）：镜像名 ≠ `Sparkii.exe` 且进程路径不在 `$INSTDIR` 之下——NSIS 的两个 `CHECK_APP_RUNNING`（新安装器 `installSection.nsh`、旧卸载器 `un.onInit`）按镜像名/路径匹配并 KILL，且旧卸载器 `un.atomicRMDir` 会因 `$INSTDIR\Sparkii.exe` 被占用而 Abort。载体在 spawn 前从 `<resources>/scripts/` 复制到 `<dataDir>/updates/watchdog/`；复制目标若无法避开安装目录 ⇒ fail closed。
   2. 主进程调 `app.quit()`；若 3s 内未退出则 `app.exit(0)` 兜底。
   3. watchdog 检测到主进程**完全消失**（`WaitForSingleObject` / 轮询 PID；超时 60s 则写 `install-result.json` 为 `failed` 并放弃）后，**才**按哨兵中的路径 `spawn` NSIS 安装器 `/S`。
      安装器参数透传 `--updated --force-run /S /D=<dir>`：`--force-run` 让 oneClick 静默安装真正重启（`installSection.nsh` 的静默重启条件只认 `isForceRun`），`--updated` 经 `StartApp` 传入重启后的 app；`/D=` 必须最后且不加引号。
      ⚠ **进程边界（M1 的 Blocker 修复）**：Node 默认会给含空格的参数加双引号，NSIS 的 `/D` 解析要求「最后、无引号」——带引号时 `$INSTDIR` 不生效。watchdog 必须用 `windowsVerbatimArguments: true` 直连安装器（**不得**用 `shell: true` / `cmd /c`：`A&B` 这类合法路径会被 shell 截断）。真实 `$INSTDIR` 由 `watchdog-command-line.test.ts` 用 makensis 探针断言。
      spawn 前对安装包**重算 sha512** 并与哨兵 `packageSha512` 比对，不符即拒绝（收窄「验签 → 执行」之间的换包窗口；按路径 spawn 无法继承句柄，残余竞态登记在案）。
   4. watchdog 等待安装器退出，拿到 `exitCode` 后**单一写入** `data/updates/install-result.json`。

**删除 v1 的「`quitAndInstall()` 或」与旧稿「先 spawn 后 app.quit()」**——应用 exe 仍在运行会撞 Windows 文件占用。

**安装目录一致性（新增风险，任务 0 实测修订 §0.7 P0-2）**：NSIS oneClick per-user 默认装到 `%LOCALAPPDATA%\Programs\Sparkii`；自管 `spawn /S` 不传 `/D` 时沿用默认。若用户当初改过安装目录（本机实测即如此，装到 `D:\software\SparkiiPi`），须解析安装目录并以 `/D=<path>` 传入（`/D` 必须是最后一个参数且不加引号）。解析顺序：① 读 `HKCU\...\Uninstall\{appId}` 的 `InstallLocation`；② **为空时**（本机实测 `InstallLocation` 就是空）从 `UninstallString` 的带引号 exe 路径取父目录；③ 仍失败则 **fail closed：不传 `/D`、拒绝进入自管安装并提示人工处理**。**装错目录会出现两份安装 / 快捷方式仍指向旧版**，列为 B 关验收项；真实 `/S` / `/D` 行为仍列「需人工确认」，复现模板见 `2026-11-06-task0-scripts/manual-windows-check.ps1`。

**结果回传与恢复**：

- **单一写入方 = watchdog**：它拿到安装器退出码后写 `data/updates/install-result.json`（`exitCode`、版本、时间、包 sha512）。`customInstall` **不写**该文件，避免双写竞态；安装器内部失败通过非零退出码体现，由 watchdog 记录。
- 重启自检：读哨兵 + `install-result` + `app.getVersion()`；成功写 `update.completed` 并清理；失败明确提示 + 提供恢复入口。
- NSIS oneClick 是**原地覆盖、非原子换目录**，中途失败/断电会留下新旧混合文件。因此必须**保留旧版安装包或安装目录备份**用于恢复，提供「重跑旧包 `/S`」入口；哨兵带 `phase` 与 `expiresAt`，超时/残留时幂等清理，避免每次启动都提示。
- **验收不再承诺「旧版本仍可启动」**，改为「至少有可执行恢复路径且 `data\` 完整」，除非任务 0 实测通过。

**活跃进程判定范围**：Pi 进程池、文档解析 supervisor、等待人工审批的写操作、正在进行的导出任务。任一存在都触发确认弹窗。

### 7.8 备份与数据兼容

- 快照范围：**整个 `data\`**，含 `audit.db` / `-wal` / `-shm`、`sessions.db`、`errors.db`、`settings.json`、`keyring/`（DPAPI 密钥）、`logs/`、`tasks/`、`pi-agent/`。用 `VACUUM INTO` 或 `wal_checkpoint(TRUNCATE)` 后整目录复制；**必须先关库再备份**（旧稿顺序反了）。
- `installer.nsh` 改动分两项（Minor · 4 闭合；M2 订正见下，与 §10 一致）：
  - `customInstall`：加**运行时内容版本**标记（独立 `RUNTIME_VERSION` 常量，仅运行时内容变更时递增；**不用 app 版本**——app 版本每版都变，拿它当粒度等价于永远重解压），内容未变则跳过大体积解压；**不写 `install-result.json`**（由 watchdog 单一写入，见 §7.7）。
  - `customUnInstall`：清理范围**不变**（仍只清 runtime 与 `data\pi-agent\bin` + 运行时版本标记），但整体加 `${ifNot} ${isUpdated}` 守卫——升级链路上旧卸载器由 `installUtil.nsh` 以 `--updated` 运行，且在 `customInstall` **之前**执行；无守卫会把标记与运行时先删掉 ⇒ 每次升级重解压（M2 根因）。完整卸载（`isUpdated=false`）行为不变。
  - 两者都**不得**扩大到其余 `data\`。
  - **前向性**：旧卸载器是旧版本编译的，本修复只覆盖「从修复版往后」的升级；**从当前坏版本升到修复版的那一次**仍会重解压一遍（一次性，可接受）。
- `audit.db` 现有「缺列自动 `ADD COLUMN`」不处理删列/改类型/数据回填；`sessions.db` 历史上发生过 `DROP COLUMN`。补一份 `data/` schema 版本表与迁移脚本清单，明确版本边界。
- `minSupportedVersion` 与桥接版本挡住跨版本直连。

### 7.9 审计

事件（去重）：`update.available` / `download-start` / `download-complete` / `verify-failed` / `check-failed` / `install-start` / `install-cancelled` / `install-abort` / `completed` / `failed` / `rolledBack` / `cleanup`，复用 `AuditStore`（WAL、JSONL 导出）。

- 「已是最新版本」不写审计；其余 `update.*` 按「类型 + 天」限流，防止 MITM 持续喂垃圾清单刷库。
- `update.verify-failed` 同时镜像到 `errors` 只读展示。**独立的客户端哈希链追加日志**（`prevHash + eventHash`，避免被同用户进程抹除）**排在 B 关实现**；A 关只写 `AuditStore`。注意这与 §8.3 的**服务端发布透明日志**（P2）是两件不同的事，不要混为一谈（Minor · 6 闭合）。
- `audit.db` 设大小上限与轮转。
- **磁盘保留策略**：成功自检后删除 `pending/` 下除当前版本外所有包与伴生清单、删除超过 N 个 `snapshots/`（不是 `backups/`，对齐实现术语）、清理 updater 缓存与 `.part`；`data/updates/` 设总容量上限 = **1.5× 包体**，按 `pending/` + `snapshots/` 实测字节计算。上限只作用于**非保护累积**（失败安装残留、orphan `.part`、超出保留的旧快照）；**当前版本包、哨兵引用的快照、最新一份快照绝不驱逐**；哨兵在场时 `pending/` 整体跳过。清理写 `update.cleanup` 审计。**回滚未完成前不得删旧包与对应备份**。失败 / 过期现场只按字节上限清理（不按数量清旧包），避免把人工回滚介质当超量删掉。

### 7.10 自动检查策略

**本地扫描与网络检查解耦**：扫描 `pending/` 纯本地零网络，启动时立即执行、不受闸门约束（否则用户要等 90 秒才看到「可安装」）；网络检查按下述闸门调度，两者结果合并成 UI 状态。

**四类触发源**：启动后 90s + 抖动（受最小间隔约束，不等于每次开机都打请求）；`setTimeout` 递归 24h 周期；网络恢复 / `powerMonitor` resume / unlock-screen 补检（需距上次 >1h）；关于页手动强制检查。

**启动首检的散布（m4 订正）**：闸门窗口是 `startupDelaySeconds + (jitterDelay(installId,60)-60)`，后者 ∈ [-9,+9]s 且是**加性**偏移。因此首检排期 = `startupDelaySeconds + 9s + 1s 余量 + max(0, 同源加性抖动)`，永远 ≥ 闸门最迟放行时刻（否则约半数现场首检白跑 `STARTUP_DELAY` 再退到 15min 心跳），同时保留 per-install 分散。**不再**使用「delay×1.15 与乘性 spread 取 max」的写法（delay≤100 时它恒等于上界，散布丢失）。

**统一闸门 `shouldCheck()`**：`autoCheck` 关 / `snoozedUntil` / 活跃任务推迟 15min / `now < nextCheckAt` / 网络离线，按序判定。`nextCheckAt = lastSuccessAt + 周期 × (1 ± 15%)`，抖动由 `hash(installId + dayBucket)` 派生，同机稳定、跨机分散。

**失败退避**：200/304 正常排期；超时/DNS/5xx 静默 `30s → 5min → 30min → 2h → 24h`；验签失败/sequence 回退写审计 + 安全日志并退避到 24h；**累计不可用 ≥ 7 天**（从第一次真实不可用起计时，任一成功/闸门抑制清零）降级为「仅手动」。判据是**时长**不是轮次（m6：六档退避累计只有约 1.6–2.7 天，按轮次会过早降级）。

**提醒节流**（与检查节流分离）：跳过此版本 / 稍后提醒 / 同一版本 24h 内不重复；命中也只出状态栏 pill，不弹模态。

**请求形态**：`GET channel.json` + `.sig` → `GET release.json` + `.sig`，`If-None-Match`、8s 超时、先验签后解析；零身份信息。

---

## 8. 发布侧

### 8.1 部署形态

在现有 RAG 服务的 Web 静态目录下挂 `/sparkii-updates/`（对外 `<IP>:80`），**不改动 RAG 业务代码**；RAG 网页可顺手加「软件下载」页。客户端只读静态文件，**永远不调 RAG 业务 API**——RAG 升级/换端口/临时挂掉都不影响更新检查；将来做网页发布后台只是「谁写这些文件」的变化，协议不变。

Web 服务器类型待查也能开工：发布产物落到本地目录后，由操作者**人工上传**到服务器某目录，Web 服务器把该目录暴露成 `/sparkii-updates/` 即可（Nginx `location` / IIS 虚拟目录 / 程序自带 static 目录）。⚠ m3：设计原稿写「发布脚本通过 SSH 把文件传到服务器」，**当前 CLI 未实现 SSH 上传与远端回读**（见 §8.2 实施状态）。

### 8.2 发布 CLI（单一逻辑指针 = 两个物理文件，v3 措辞订正）

```
1. 校验：安装包存在、release-manifest.json 的哈希与实物一致、worktree 干净、版本号合规
2. 递增 channel.json 的 sequence（**唯一递增处**），并组装 release.json（version / sequence 写同值镜像 / nonce / publishedAt / expiresAt / artifact.sha512 / …）
3. 用离线 Ed25519 私钥签 channel.json 与 release.json（kid 计入签名输入）
4. 上传整套文件到带版本号的 /releases/<version>/（安装包 → 可选 blockmap（任务 0 / P2）→ release.json + .sig → release-manifest.json）
5. 远端回读校验：所有文件（含 .sig、可选 blockmap）的哈希与签名
6. 【唯一逻辑指针切换】先上传 channel.json.sig，再上传 channel.json；两者都就绪后做一次回读校验
7. 输出发布记录（谁、何时、commit、sequence、签名指纹），落本地发布日志
```

- **切指针前**所有文件已就位且校验通过；切之后客户端才可能看到新版本。不存在「新策略清单 + 旧版本清单」窗口。
- **实施状态（m3，2026-11-08 订正，如实描述）**：步骤 1–3、7 **已由 `apps/desktop/scripts/publish-release.mjs` 实现**（校验、组装 + 签名、本地按序落盘 + 本地发布记录）；步骤 4–6 的**远端上传与回读校验目前未实现**——脚本只写 `--out-dir` 本地目录，随后由操作者按 `docs/operations/update-service.md` 的人工规程上传并回读确认。客户端 fail closed 覆盖上传失败/缺失，但「上传是否成功」当前依赖人工确认；SSH 上传 + 远端哈希/签名回读列为后续实现项（`publish-release.mjs` 文件头同步注明）。
- **不声称原子性**（Minor · 5 闭合）：静态文件托管下 `channel.json` 与 `.sig` 是两个独立文件，上传之间存在毫秒级不匹配窗口。安全性由客户端 **fail closed** 覆盖——任一文件缺失、签名不匹配、清单哈希不一致，一律当作「无更新」并按 §7.10 静默退避，不会放行未验签内容。若将来需要强原子，改为「单文件 `channel.json` 内嵌签名字段」（P2）。
- 客户端取指针后校验指针里的清单 sha256，不一致即 fail closed。
- 单人发布（D9），去掉旧稿的「双人复核」；但发布日志 + 签名指纹 + sequence 必须留痕。

### 8.3 密钥管理与泄露预案

- 用 `packages/config` 的 `generateKeyPair` 生成 Ed25519 密钥对；**私钥由用户本人离线保管，绝不进仓库**（`.gitignore` 忽略 `*.key` 与 `*.private.pem` / `.sparkii-release-keys/` —— 后者是 `scripts/release-keys.mjs` 的真实落盘形态，默认写到 `%USERPROFILE%\.sparkii-release-keys\`，但 `--out-dir` 可以把文件放进仓库，所以两种形态都必须被忽略），公钥编译期内置客户端（注入方式见 §5.4）。
- `kid` 计入签名输入；每把密钥带 `notBefore / notAfter`；密钥轮换时新公钥随一次「用旧密钥签名」的更新下发，旧钥保留过渡期。
- **私钥泄露必须是带外预案**：立即下线更新源 → 人工通知所有客户「不要点升级」→ 发布全量重装的新版本（内置新公钥）→ 必要时签发撤销清单。HTTP 下带内撤销清单**可能被中间人屏蔽**，不能只靠它。
- **双层密钥（离线根公钥 + 日常签名密钥）与服务端单调哈希链发布透明日志列入 P2**，本期单人小团队不引入，但作为后续加固方向记录。这与 §7.9 的**客户端审计哈希链**（B 关）不是同一组件（Minor · 6 闭合）。

### 8.4 服务器运维

静态目录只读、禁止目录列表；`.json` / `.sig` / `.exe` 的 `Cache-Control` 与 `ETag` 策略（**不缓存 `channel.json`**，避免指针切换延迟）；访问日志留存与「同一客户端短时间大量取旧清单」异常告警；紧急撤回通道（管理员如何通知「不要点升级」、如何下线某版本）。

---

## 9. 分期与验收

| 阶段 | 范围 | 关键验收 |
| --- | --- | --- |
| **任务 0：实测先行**（半天，第一个做） | **§5.2 的 A / A′ / B 三选一定案**（本地 feed 是否被接受、绝对 artifact URL 能否覆盖 feed baseUrl、`AppUpdater.httpExecutor` 可注入性）；未签名 NSIS `/S` + 安装目录一致性；`app-update.yml` 开关是否保留；detached watchdog 等待主进程退出后拉起安装器、退出码回传；MOTW / SmartScreen / UAC；`publish: generic` + `--publish never` + `--config` 产物断言；`.blockmap` 差分可行性（**仅评估，本期不启用**） | **已完成（2026-11-06）**：结论表见 `2026-11-06-task0-results.md`，§5.2 已**定案 A** 并删除另两条实现描述，§0.7 记录 6 项设计稿订正；`/S` / MOTW / SmartScreen / 安装目录真机行为标「需人工确认」并产出 `manual-windows-check.ps1`，未判通过 |
| **A 关：发现与下载** | 静态源 + verifier **清单/策略数据单一网络入口** + 本地派生 `latest.yml` + 发布 CLI 单一指针 + 验签/新鲜度/防降级 HMAC/nonce 绑定 + 统一闸门 + 状态栏进度条 + `downloadUpdate` 迁移到 `pending/` + 二选一交互 | ① 0.1.0 能发现新版并提示；② **篡改 `release.json`、`.sig`、包体、指针或同 sequence 换 nonce 时一律拒绝且写审计**；③ 重放历史合法清单（`expiresAt` 已过或 sequence 回退）被拒；④ 点「下载」进度条不打断工作，完成显示「可安装」；⑤ **关机重开扫描本地即显示可安装，不重新下载、不依赖状态文件**〔2026-11-06 集成收口订正，第 3 轮终审 A⑤ 之争：此处「不依赖」只覆盖**合法包的存在性与版本判定**（由已验签伴生清单派生）；第Ⅶ步的序号下限与 nonce 绑定仍取自 `update-state.json`，且按 §6.3 第 4 条，状态文件在「DPAPI 镜像显示曾用过、现已缺失」时本次运行一律拒绝自动更新。故本条的成立前提是状态文件正常在场，实现与验收都不得反过来放宽 §6.3.4〕；⑥ 0.2/0.3 二选一两条路径都能走通；⑦ `pnpm test` 全绿 |
| **B 关：安装与重启** | 关机协议、单实例锁、审批门显式过期、整 `data\` 快照、哨兵 + watchdog + `install-result`、旧版恢复介质、`installer.nsh` 两项改动、保留策略、客户端审计哈希链 | ① 点「安装」有活跃进程时弹确认，取消回「可安装」且包完好；② 免 UAC 装完并自动重启，打开即新版，**安装目录与旧版一致**；③ 重启后审计/会话/设置/密钥完整、版本号正确；④ **安装失败 / 中途断电后至少有可执行恢复路径且 `data\` 完整**；⑤ Pi 池无残留子进程、SQLite 句柄全部关闭；⑥ 升级不重解压未变更运行时 |
| **P2** | 差分 / 运行时拆分（按实测数据）、强制更新、RAG 网页发布后台、双层根密钥、服务端发布透明日志、单文件内嵌签名的强原子指针、自研下载通道消除 httpExecutor 残余风险、代码签名接入 | 差分下载量达标；SmartScreen 不再告警 |

---

## 10. 影响面清单

| 类别 | 文件 / 位置 |
| --- | --- |
| 新建 | `electron-updater@6.3.0`（>= 6.3.0；**定案 A，已引入，为本期正式依赖**）、`electron/main/update/*`（§7.1）、`scripts/publish-release.mjs`、`scripts/sign-release.mjs`、**`electron-builder.config.mjs`（唯一构建配置载体，迁入 yml 全部内容）**、watchdog 脚本/exe、更新源目录模板、`docs/operations/update-service.md` |
| **删除** | **`apps/desktop/electron-builder.yml`**（内容已迁入 `.mjs`，避免双载体） |
| 修改 · 客户端 | `main/index.ts`（`app.getVersion()`、单实例锁在 `whenReady` 前、挂载 UpdateService、`isUpdating` 标志、协调两个 `before-quit`）、`packages/agent-host/src/pi-runtime-pool.ts`（**复用 `stopAll()` + 新增 `stopped` 闸门拒绝新任务**，见 §0.7 P0-1）、`document-parse-quit.ts`（识别 `isUpdating`）、`gate.ts`（pending 显式过期 + 审计）、三个 SQLite store 的 `close()` 调用、`settings.ts`、`ipc.ts`、`preload/api.ts`、`preload/api-types.ts`、`SettingsView.tsx`、`StatusBar.tsx`、`branding.ts` |
| 修改 · 打包 | **`apps/desktop/package.json`**：`dist` 加 `--config electron-builder.config.mjs`、`build:main` 的 esbuild `define` 注入 `__SPARKII_UPDATE_URL__`、产物断言；**`electron-builder.config.mjs` 的 `extraResources` 追加 `scripts/update-watchdog.mjs`**（否则 §7.7 的安装执行链在生产包里拿不到 watchdog，只会 fail closed）；`build/installer.nsh`：**`customInstall`** 加运行时版本标记 + 跳过未变更解压（**不写 `install-result.json`**，由 watchdog 单一写入）、**`customUnInstall`** 仅删该标记、不动其余 `data\`；`scripts/create-release-manifest.mjs`（`unsigned` 硬编码；`sha256File` 未导出，另写实现） |
| 修改 · 测试 | `test/preload-api.test.ts`（方法名精确断言）、`test/release-config.test.ts`（改为断言 `.mjs` 配置与占位 URL）、`test/create-release-manifest.test.ts`、新建 update 模块单测（复用 `test/ipc.test.ts` 假 `ipcMain` Map、`provider-probe.test.ts` 假 `Response`）、**验签门禁单测**、**`autoDownload === false` 单测**、**关机协议与断电注入集成测试**、e2e 升级用例（**本次未做**，见 `implementation-review.md` §1.6 U-5） |
| 修改 · 文档 | `docs/release-windows.md`、`docs/deploy.md`、`README.md:154`（NSIS+MSIX 描述与实现不符）、`PRODUCT.md`、`README.en.md`、2026-10-23 plan 的「不做自动更新」条款；`TODO.md` 与 `branding.ts` 经 grep 核实**无冲突表述，故未改动**（不是遗漏） |
| 新建 · 集成补齐（2026-11-06 收口时新增，原计划未列出） | `electron/main/update-bootstrap.ts`（DPAPI HMAC 密钥 / §7.7 幂等关机控制器 / before-quit 守卫 / §7.10 调度）、`electron/main/shutdown.ts`、`electron/main/update/snapshot.ts`、`scripts/build-main.mjs`、`scripts/release-keys.mjs`、`scripts/verify-release.mjs`、`src/shell/SettingsUpdatePane.tsx`；主 Agent 独占测试 `test/update-bootstrap.test.ts`、`test/update-config-keys.test.ts`、`test/update-download-resume.test.ts`、`test/update-status-ui.test.tsx`、`test/update-service-settings.test.ts`、`test/update-signature-parity.test.ts`；审核记录 `docs/superpowers/specs/2026-11-06-implementation-review.md` |
| 修改 · 客户端（集成补齐） | `src/App.tsx` + `packages/ui/src/patterns/Shell.tsx`（状态栏更新 pill 真正接线，见契约 §10 I-13）、`update/state-store.ts`（`regenerateInstallId()`，§6.6 重置入口）、`.gitignore`（`*.private.pem` / `.sparkii-release-keys/`，堵住 `--out-dir` 把私钥写进仓库的路径） |

---

## 11. 需实测清单与开放问题

> **状态（2026-11-06 阶段 0 收口）**：以下 9 项中可自动化的已真跑，结论见 `docs/superpowers/specs/2026-11-06-task0-results.md`；§5.2 已依实测**定案 A**，A′ / B 实现描述已删除。涉及真实 GUI / 真实安装的项一律标「**需人工确认**」，**未判为通过**。§11.10 为实测结论汇总。

**Windows / 版本行为一律不凭猜测写死，以下并入任务 0**：

1. **§5.2 路径定案（最高优先级）**：`setFeedURL` 是否接受 `file://` / 本地目录；`latest.yml` 中绝对 artifact URL 能否覆盖 feed baseUrl；`AppUpdater.httpExecutor` 在锁定的 6.x 中是否可注入；覆盖 feed 后 `app-update.yml` 的 `verifyUpdateCodeSignature: false` / `updaterCacheDirName` 是否仍生效。据此在 A / A′ / B 中定案。→ **已闭合，定案 A（§5.2.1）**；四项实测全部有结论（T0-2 / T0-3 / T0-4 / T0-7）。
2. MOTW / `Zone.Identifier`：electron-updater 用 Node `fs` 写文件通常**不经过** `IInternetSecurityManager`，下载后的 exe 未必带该流——需实测，不能假设。
3. SmartScreen / 「未知发布者」：Main 进程 / watchdog `spawn`（`CreateProcess`）vs 资源管理器双击（`ShellExecuteEx`）的差别；各版本 / 组策略表现。
4. 文件占用与 oneClick 静默安装：应用 exe 仍在运行时 `/S` 是等待、失败还是杀进程；**watchdog 等待主进程 PID 消失后 `spawn`** 是否可靠；`before-quit` 的 `preventDefault()` 在 `isUpdating` 下是否正确放行。
5. **安装目录一致性**：不传 `/D` 时 `/S` 是否覆盖到原目录；从 `HKCU\...\Uninstall\{appId}` 读 `InstallLocation` 并以 `/D=` 传入时 NSIS 参数顺序是否正确；错目录是否产生两份安装。
6. 安装器退出码能否由 watchdog 可靠回传（应用已退出、父进程消失）；`customInstall` 不参与写入，写入方唯一性见 §7.7。
7. `.blockmap` 差分走 HTTP（**仅评估，本期恒定关闭**）：Range 支持、篡改后是否复核最终 sha512、404 是否自动回退全量；结论只用于 P2 决策。
8. NSIS 原地覆盖的半安装恢复：B 关验收④已定为「至少有可执行恢复路径且 `data\` 完整」；本项实测只用于判断能否**额外**承诺「旧版仍可启动」，不降低既定验收标准。
9. `publish: generic` + `--publish never` + `--config` 在本仓库 `dist` 后是否稳定产出 `latest.yml`（结论已核实，仍加产物断言固化）。

**开放问题**：

1. 版本号策略：9 个 workspace 包都是 `0.1.0`，发版时是联动升版本还是只以 `apps/desktop/package.json` 为准？
2. 完全离线客户是否需要「从本地目录导入更新」入口（`sparkii import-update`）？
3. 更新源是否需要鉴权？若需要，token 存 `Keyring`，但会打破纯静态托管假设。
4. 关于页是否展示 commit / 构建时间（现有 `release-manifest.json` 已有，低成本）。
5. `data/` schema 版本表与迁移脚本清单由谁维护、桥接版本如何发布。
6. 若任务 0 定案为兜底 B 方案（自研下载），是否仍保留 electron-updater 依赖？建议不保留，并相应修订 D5 与 §10。→ **不适用**：定案为 A，`electron-updater@6.3.0` 为本期正式依赖，D5 / §10 依赖说明无需修订。

### 11.10 任务 0 实测结论汇总（2026-11-06）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| T0-1 | ✅ `publish: generic` + `--publish never` + `--config .mjs` 稳定产出 `out/latest.yml` 与 `resources/app-update.yml`；`publish.url` 为占位常量、元数据无 IPv4 字面量 | 真跑 electron-builder 26.15.3，`BUILD_EXIT=0`，产物内容已逐项读取 |
| T0-2 | ✅ `setFeedURL` **接受** `file://`；默认 executor 不支持 `file:`（走 `electron.net.request`），注入自定义 executor 后 `checkForUpdates()` 成功 | `probe-updater.cjs` |
| T0-3 | ✅ 派生 `latest.yml` 的绝对 artifact URL 覆盖 feed baseUrl（`file://` 与 loopback 两种 feed 均成立） | `probe-updater.cjs` + `GenericProvider.resolveFiles()` / `newUrlFromBase()` 源码 |
| T0-4 | ✅ `httpExecutor` 可注入（**须先注入、后 `setFeedURL`**），`client.executor === injected`；需同时实现 `request()` / `download()` | 锁定 `electron-updater@6.3.0` 探针 |
| T0-5 | ✅ watchdog「等 PID 消失 → spawn → 回写 exitCode」7 条断言全绿，含成功 / 失败 / 超时三场景，单一写入方 | `probe-watchdog.mjs`，`pass: true`；假安装器、临时目录，无真实安装 |
| T0-6 | ⚠️ **需人工确认**：`/S` 免 UAC、安装目录 `/D` 一致性、MOTW / SmartScreen | 只读注册表已做（`InstallLocation` 为空）；`manual-windows-check.ps1` 为隔离环境复现模板，**主 Agent 未执行** |
| T0-7 | ✅ 覆盖 feed 后 `app-update.yml` 的 `updaterCacheDirName` / 验签相关配置**仍生效**；`verifyUpdateCodeSignature` 产物语义订正见 §0.7 P0-4 | `probe-updater.cjs` + `AppUpdater.js:493` / `NsisUpdater.js:87` |
| T0-8 | ⚠️ **需人工确认**：MOTW、SmartScreen、应用占用下 `/S`、半安装恢复的额外承诺；`before-quit` 放行由 B 关单测覆盖 | 见 `2026-11-06-task0-results.md` §4 |
| T0-9 | ✅ `.blockmap` 存在且结构可做差分；**本期按 D6 不启用**，实测差分下载量 / Range / 404 回退未验证，列 P2 | 读取 `out/*.blockmap`（gzip、version 2、64KB checksums） |

**未自动验证项一律不判通过**，清单见 `2026-11-06-task0-results.md` §4（M-1…M-9）。
