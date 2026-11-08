# 阶段 0 · 现状复核与任务 0 实测结果

> 日期：2026-11-06 · 执行：主 Agent（G0，串行、独占）
> 环境：Windows 10.0.26200 / Node v22.22.2 / pnpm 9.15.9 / electron-builder 26.15.3 / Electron 44.0.0
> 权威设计稿：`docs/superpowers/specs/2026-11-06-auto-update-design.md`（v3）
> 约束：**未执行任何真实 NSIS `/S` 重装、未运行 `customUnInstall`、未清空 `pending/`、未改动 `%LOCALAPPDATA%\SparkiiDesktop\data`、未自动 commit**。
> 复现脚本目录：`docs/superpowers/specs/2026-11-06-task0-scripts/`

---

## 1. 现状复核差异清单（重读 §2 全部文件）

逐项重读 `apps/desktop/electron-builder.yml`、`apps/desktop/package.json`、`scripts/create-release-manifest.mjs`、`build/installer.nsh`、`packages/config/src/{integrity,loader}.ts`、`electron/main/{index,ipc,settings,runtime,document-parse-quit,paths,keyring}.ts`、`electron/preload/{api-types,api}.ts`、`packages/approval/src/{audit,gate}.ts`、`packages/agent-host/src/pi-runtime-pool.ts`、`packages/ui/src/patterns/StatusBar.tsx`、`src/{branding.ts,shell/SettingsView.tsx}`、`test/{preload-api,release-config,ipc}.test.ts`、`docs/{release-windows,deploy}.md`、`docs/superpowers/plans/2026-10-23-windows-internal-release.md`、`README.md`、`README.en.md`、`PRODUCT.md`、`TODO.md`。

**结论：v3 事实基线整体成立**，但发现 **6 处需要订正/补充的事实**（下表 D-1…D-6）。按开工提示词 §0 规则，这些属于「设计稿本身有错」，已先修订设计稿（新增 §0.7 记录理由）再进入编码。

| # | v3 结论 | 实测事实 | 处置 |
| --- | --- | --- | --- |
| **D-1** | §2「`rt.pool` 全仓无 `stop()/dispose()`」；§7.7 步骤 3「**需新写代码** `rt.pool.stop()`」；§10「**新增** `pool.stop()`」 | `PiRuntimePool.stopAll()` **已存在**（`packages/agent-host/src/pi-runtime-pool.ts:249-256`），会逐个 `supervisor.stop()`、清空 slots/pending 并 `emitSnapshot()`；只是**没有任何退出路径调用它**，且 `stopAll()` 后 `acquire()` 仍可重建 slot（无 `stopped` 闸门） | 修订设计稿：不再「新增 `stop()`」，改为「复用既有 `stopAll()` + 补 stopped 闸门拒绝新任务，并在关机协议里调用」。避免重复造一个同名方法造成两套语义 |
| **D-2** | §7.7「从 `HKCU\...\Uninstall\{appId}` 的 `InstallLocation` 读出并以 `/D=<path>` 传入」 | 只读注册表实测：**`InstallLocation` 为空字符串**；`UninstallString = "D:\software\SparkiiPi\Uninstall Sparkii.exe" /currentuser`（**用户改过安装目录**，不是默认 `%LOCALAPPDATA%\Programs\Sparkii`） | 修订设计稿：增加「`InstallLocation` 为空时从 `UninstallString` 的带引号 exe 路径取父目录」回退；解析失败则 **fail closed 不传 `/D` 并拒绝自管安装**。见 `manual-windows-check.ps1` 第 1 节（只读） |
| **D-3** | §0.2「`out/*.blockmap` 是否在现有产物中存在**需构建后确认**」 | **已确认存在**：`apps/desktop/out/Sparkii-0.1.0-win-x64.exe.blockmap`；gzip 压缩、schema `version: "2"`、`files: 1`、内含 64KB 分块 `checksums` 数组 | 事实基线补齐；本期仍按 D6 **不启用差分** |
| **D-4** | §5.5「设为 `false` 后**写入的是 `verifyUpdateCodeSignature: false`**」 | 实测 `resources/app-update.yml` 只有 `provider / url / updaterCacheDirName` 三行，**没有该键**。源码 `winPackager.js:27` `isForceCodeSigningVerification = win.verifyUpdateCodeSignature !== false`，`PublishManager.js:202-208` 只在为 true 时计算并写 `publisherName`；为 false 时**不写 `publisherName`**，`NsisUpdater.verifySignature()` 因 `publisherName == null` 直接返回 null 从而跳过验签 | 修订设计稿 §5.5 的措辞：`win.verifyUpdateCodeSignature: false` 是**构建配置开关**，其产物效果是 `app-update.yml` **不含 `publisherName`**（不是写入同名键）。产物断言改为「配置文件含该开关 + `app-update.yml` 不含 `publisherName`」 |
| **D-5** | §5.2「任务 0 定案要求」把「`file://` 是否被 `setFeedURL` 接受」当作简单是非 | 实测：`setFeedURL({provider:'generic', url:'file:///…/'})` **不抛错**、provider 也正确派生 `file:///…/latest.yml`；但**默认 `ElectronHttpExecutor` 把请求交给 `electron.net.request`，Chromium net 栈只支持 http/https**，`file:` 必然失败。**只有注入自定义 `httpExecutor`（§5.2 步骤 4 本来就是硬性要求）处理 `file:` 才可用** | 修订设计稿 §5.2 A：明确「A 成立的前置是自定义 `httpExecutor` 在 `request()` 层本地读取 `file:` 元数据」，这不改变「元数据只来自本地派生文件」的不变量 |
| **D-6** | §11 第 1 项「覆盖 feed 后 `app-update.yml` 的 `verifyUpdateCodeSignature: false` / `updaterCacheDirName` 是否仍生效」为开放问题 | 实测：**仍生效**。`setFeedURL()` 只让 `clientPromise` 非空（绕过 **feed provider**），但 `AppUpdater.js:493` 的 `getOrCreateDownloadHelper()` 与 `NsisUpdater.js:87` 的 `verifySignature()` 仍独立读 `configOnDisk.value`。探针用真实 `app-update.yml` 验证 `configOnDisk` 可读且含 `updaterCacheDirName: sparkii-updater` | 闭合该开放问题；§11 补实测结论 |

其余 v3 结论逐项复核一致（摘要）：`electron-builder.yml` 的 `appId/artifactName/nsis oneClick+perMachine:false+deleteAppDataOnUninstall:false` 属实；`dist` 脚本为 `electron-builder --win nsis --publish never` 属实；`release-manifest.json` schemaVersion 1 且 `unsigned: true` 硬编码、`sha256File` **未导出** 属实；`installer.nsh` 的 `customUnInstall` 清 runtime **与 `data\pi-agent\bin`** 属实；`loader.ts:67-75` fail-closed 且 `main/index.ts:62` 未传 `publicKey` 属实；运行时尚未调用 `app.getVersion()` 属实；`settings.ts` 无 `update` 字段、`ipc.ts:1977-1983` 的 `saveSettings` 为 merge 语义属实；`main/index.ts` 无单实例锁 + 两个 `before-quit`（`reviewer.dispose()` 与 `document-parse-quit.ts` 无条件 `preventDefault()`）属实；三个 SQLite store 的 `close()` 存在但无人调用属实；`gate.ts` 有 `listPending()` 与 timeout 門控的 `expire(id)`（**没有强制过期全部 pending 的方法**，B 关需补）；`test/preload-api.test.ts` 对方法名做精确断言属实；`docs/release-windows.md` / `docs/deploy.md` / 2026-10-23 plan 仍写「首版不做自动更新 / 不引入新网络服务」属实；`README.md:154` / `README.en.md:155` / `PRODUCT.md:9` 的 NSIS+MSIX 描述与实现不符属实。

---

## 2. 任务 0 实测（§9 / §11 共 9 项）

### T0-1 · `publish: generic` + `--publish never` + `--config <.mjs>` 产物断言

**命令**（cwd `apps/desktop`；配置为 `task0-scripts/electron-builder.task0.config.mjs`，内容等价于设计稿 §5.4 待落地的生产配置）：

```bash
./node_modules/.bin/electron-builder --win nsis --publish never \
  --config "../../docs/superpowers/specs/2026-11-06-task0-scripts/electron-builder.task0.config.mjs"
```

- 第一次尝试 `BUILD_EXIT=1`：环境的批量删除保护拒绝 electron-builder 清理含 520 个文件的既有 `out/win-unpacked`（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）。**未绕过该保护、未删除任何文件**，改为把 `out/win-unpacked` 与 `out/win-unpacked.tmp` **重命名**为 `*.pre-task0`（保留为备份，不删除），让 builder 面对全新目标目录。
- 第二次尝试 **`BUILD_EXIT=0`**，日志关键行：`loaded configuration file=…electron-builder.task0.config.mjs` → `packaging platform=win32 arch=x64 electron=44.0.0` → `building target=nsis file=out\Sparkii-0.1.0-win-x64.exe`。

**产物**（真实读取）：

| 路径 | 结果 |
| --- | --- |
| `apps/desktop/out/latest.yml` | ✅ 存在，含 `version / files[0].url / sha512 / size / path / releaseDate` |
| `apps/desktop/out/win-unpacked/resources/app-update.yml` | ✅ 存在，内容 `provider: generic` / `url: http://localhost/sparkii-updates/` / `updaterCacheDirName: sparkii-desktop-updater` |
| `publish.url` | ✅ 为**占位常量** `http://localhost/sparkii-updates/`，不是真实 IP |
| 产物元数据 IPv4 字面量扫描 | ✅ `grep -E "([0-9]{1,3}\.){3}[0-9]{1,3}"` 在 `latest.yml` 与 `app-update.yml` 中**无命中** |
| `app-update.yml` 的 `publisherName` | ✅ **不存在**（见 D-4） |
| 打包元数据 `.blockmap` | ✅ 生成（见 T0-9） |

**结论**：✅ **成立**。`--publish never` 只禁止上传、不禁止生成；`--config .mjs` 被正确加载；`publish: generic` 让 `latest.yml` 与 `app-update.yml` 稳定产出。注意：这两份文件都是**构建期产物**，服务器**不上传** `latest.yml`（§6.1），客户端按 §5.2 自行派生。

### T0-2 · `setFeedURL` 是否接受 `file://` / 本地目录（不下载真包）

**命令**：`node docs/superpowers/specs/2026-11-06-task0-scripts/probe-updater.cjs`
（探针通过 `Module._load` 注入 `electron` stub，在真实安装的 **electron-updater 6.3.0** 上跑 `checkForUpdates()`；`downloadUpdate()` **从未调用**；假 origin 上的「安装包」是 12 字节文本，从未被下载。）

| 场景 | `setFeedURL` 抛错 | `checkForUpdates()` | 证据 |
| --- | --- | --- | --- |
| `file:///…/feed/`，**默认 executor** | ❌ 不抛错 | ❌ 失败：`electron.net.request cannot use protocol file: (http/https only)` | provider 派生 URL = `file:///…/feed/latest.yml`；`net.request` 收到 `{protocol:'file:',hostname:'',path:'/C:/…/feed/latest.yml?noCache=…'}` |
| `file:///…/feed/`，**注入自定义 executor** | ❌ 不抛错 | ✅ 成功，返回 `version 0.2.0` | executor 的 `request()` 直接 `readFileSync` 本地派生文件；`metadataRequests = ["file:/C:/…/feed/latest.yml?noCache=…"]` |
| `http://127.0.0.1:<port>/<token>/`（A′ 对照） | ❌ 不抛错 | ✅ 成功，返回 `version 0.2.0` | `metadataRequests` 为 loopback URL |

**结论**：`setFeedURL` **接受** `file://`（URL 与 provider 派生都正确），但**默认 executor 不支持**。由于 §5.2 步骤 4 **硬性要求注入自定义 `httpExecutor`**，A 方案在「自定义 executor 本地读 `file:`」这一实现下完全可行。见 D-5。

### T0-3 · 派生 `latest.yml` 中绝对 artifact URL 能否覆盖 feed baseUrl

同一探针。派生 `latest.yml` 的 `files[0].url` 写成 `http://127.0.0.1:<fakePort>/fake/Sparkii-0.2.0-win-x64.exe`（**与 feed 不同 host:port**）。

| feed baseUrl | `provider.resolveFiles(info)` 得到的 artifact URL | 绝对 URL 覆写 |
| --- | --- | --- |
| `file:///…/feed/` | `http://127.0.0.1:<fakePort>/fake/Sparkii-0.2.0-win-x64.exe` | ✅ `true` |
| `http://127.0.0.1:<port>/<token>/` | 同上 | ✅ `true` |

源码依据：`electron-updater/out/util.js` 的 `newUrlFromBase()` = `new URL(pathname, baseUrl)`，绝对 pathname 直接覆盖 base；`providers/Provider.js` 的 `resolveFiles()` 对每个 `fileInfo.url` 调用它。

**结论**：✅ **成立**。A / A′ 都可把 401MB 包指向已验签清单里的绝对远程 URL，不会被拼到本地 feed 目录。

### T0-4 · 锁定的 `electron-updater >= 6.3.0` 中 `AppUpdater.httpExecutor` 是否可注入

锁定版本：**`electron-updater@6.3.0`**（`pnpm --filter @sparkii/desktop add electron-updater@6.3.0`，含 CVE-2024-39698 修复）。

- `AppUpdater.js:166` `this.httpExecutor = new ElectronHttpExecutor(...)`；当传入自定义 `app` adapter 时为 `null`。`AppUpdater.d.ts` 将其声明为公开可写属性。
- `AppUpdater.js:346-353` `createProviderRuntimeOptions()` 返回 `{ executor: this.httpExecutor, ... }`，`GenericProvider` 构造函数把它存为 `this.executor`。
- 探针实测：`updater.httpExecutor = exec;` **在 `setFeedURL()` 之前**赋值 → `client.executor === exec` 为 **`true`**（file feed 与 loopback feed 两组均如此）。
- ⚠️ **约束**：`setFeedURL()` 在调用时捕获 executor，因此**必须先注入、后 `setFeedURL`**；`downloadUpdate()` 走 `this.httpExecutor.download(url, destination, options)`（`AppUpdater.js:584` / `NsisUpdater.js`），自定义 executor 需同时实现 `request()` 与 `download()`；`disableDifferentialDownload = true` 时不会调用 `downloadToBuffer()`。

**结论**：✅ **可注入**，§5.2 步骤 4 的 host/重定向/超时/字节上限约束可以真正落地，无需走「已知取舍」降级。

### T0-5 · watchdog「等待主进程 PID 消失 → spawn → 回写 exitCode」（假安装器）

**命令**：`node docs/superpowers/specs/2026-11-06-task0-scripts/probe-watchdog.mjs` → **EXIT=0**，`"pass": true`。

| 场景 | 结果 |
| --- | --- |
| S1 成功（父进程 800ms 后退出，假安装器 exit 0） | `install-result.json = {ok:true, exitCode:0, writer:'watchdog', parentGoneAt:…}`；假安装器 marker `parentGone:true` 且 `startedAt` 晚于父进程死亡 → **先退出后安装**成立 |
| S2 安装器失败（exit 3） | `install-result.json = {ok:false, exitCode:3}` → 退出码可靠回传 |
| S3 超时（父进程存活 1200ms，watchdog 超时 300ms） | `install-result.json = {ok:false, exitCode:null, reason:'main-process-timeout', waitedMs:309}`；**假安装器未被 spawn** |
| 单一写入方 | 三组 `install-result.json` 的 `writer` 均为 `'watchdog'`，`customInstall` 不参与 |

7 条断言全部为 `true`。**隔离手段**：全部在系统临时目录 + 假安装器 Node 脚本；**未执行 NSIS `/S`、未触发 UAC、未改动真实 `data\`**。

### T0-6 · `/S` 免 UAC、安装目录一致性、MOTW / SmartScreen

**状态：⚠️ 需人工确认，未自动验证，禁止判为通过。** 这些涉及真实 GUI / 真实安装，在开发机上执行会覆盖 `D:\software\SparkiiPi` 的现有安装或改动真实 `data\`，违反开工提示词 §2。

- 已做**只读**注册表查询（PowerShell）：`DisplayName: Sparkii 0.1.0`、`DisplayVersion: 0.1.0`、`InstallLocation: `(空)、`UninstallString: "D:\software\SparkiiPi\Uninstall Sparkii.exe" /currentuser`。→ 引出 D-2 修订。
- 产出可复现脚本 `manual-windows-check.ps1`：**第 1 节只读**（可在本机跑）；**第 2–4 节为注释模板**，供人工在隔离 VM / 备用测试用户上执行，含 `/S /D=<temp>`（`/D` 必须最后、不加引号）、临时 `SPARKII_DATA_DIR`、安装目录一致性检查、`Zone.Identifier` / SmartScreen / 未知发布者观察、以及「绝不指向真实 data 目录」的显式警告。
- **待人工确认清单见 §4**。

### T0-7 · `app-update.yml` 开关在覆盖 feed 后是否仍生效（§11 第 1 项后半）

探针写入真实形态的 `app-update.yml`（`provider / url / updaterCacheDirName / verifyUpdateCodeSignature:false`），`setFeedURL()` 之后读取 `configOnDisk.value`：

```json
"diskConfig": {"provider":"generic","url":"http://localhost/sparkii-updates/",
               "updaterCacheDirName":"sparkii-updater","verifyUpdateCodeSignature":false}
```

源码断言：`getOrCreateDownloadHelperReadsCacheDirName: true`、`verifySignatureReadsPublisherName: true`、`providerFeedBypassed: true`。

**结论**：✅ **仍生效**（但只影响「下载缓存目录」与「publisherName 验签」，不影响 feed provider）。闭合 §11 开放项 1 的后半。见 D-6。

### T0-8 · 安装包下载通道 / 差分相关（含 §11 第 2、3、4、6、8 项）

- MOTW（§11-2）、SmartScreen / ShellExecuteEx vs CreateProcess（§11-3）、应用 exe 占用下 `/S` 行为（§11-4）、NSIS 原地覆盖半安装能否「旧版仍可启动」（§11-8）：**均需真实 GUI / 真实安装，标注「需人工确认」，未自动验证，未伪造结论**。
- watchdog 退出码回传（§11-6）：已在 T0-5 用假安装器闭环。
- `before-quit` 的 `preventDefault()` 在 `isUpdating` 下放行：属 B 关代码逻辑，由 B 关单测覆盖（不在任务 0 用真实进程验证）。

### T0-9 · `.blockmap` 差分可行性（仅评估，本期不启用）

读取 `out/Sparkii-0.1.0-win-x64.exe.blockmap`（gzip）：`version: "2"`、`files: 1`、`files[0].name: "file"`、`offset: 0`、`checksums[]`（base64、64KB 粒度）。

**可行性结论**：结构满足 electron-updater 的 `GenericDifferentialDownloader` 输入，理论上可做 Range 差分；实测差分下载量、Range 支持、篡改后最终 sha512 复核、404 回退全量均**未验证**（需要真实服务器与两版安装包）。按 **D6 / §11-7 本期恒定 `disableDifferentialDownload = true`**，`release.json` 不带差分 URL，updater 不请求 `.blockmap`；发布 CLI 仍上传 blockmap 仅供任务 0 评估与 P2 准备。**不阻塞本期，不纳入验收通过项。**

---

## 3. §5.2 定案（任务 0 的核心产物）

### 定案：**方案 A —— 本地 `file://` 派生 feed + 自定义 `httpExecutor`**

| 项 | 结论 |
| --- | --- |
| 定案路径 | **A** |
| 实现形态 | `verifier.ts` 独占清单/策略数据的网络入口 → 从已验签 `release.json` **本地派生** `latest.yml` 写入 `data/updates/feed/` → `updater.setFeedURL({provider:'generic', url: file://<feedDir>/})` → **自定义 `httpExecutor` 在 `request()` 层直接读该本地文件**（不发起任何网络请求）→ `downloadUpdate()` 按清单里的**绝对远程 URL** 下载，`download()` 层强制 host/port/scheme、`maxRedirects=0`、禁 https→http 降级、8s 连接超时、字节上限，并自行终检 sha512 / bytes |
| 关键前置 | 自定义 `httpExecutor` **必须在 `setFeedURL()` 之前注入**；必须同时实现 `request()`（本地 `file:`）与 `download()`（远端包体）；`disableDifferentialDownload = true` 恒成立 |
| 证据 | T0-2（`file://` 被接受 + 注入后 `checkForUpdates()` 成功）、T0-3（绝对 URL 覆写成立）、T0-4（executor 可注入且被 provider 采用）、T0-7（`app-update.yml` 缓存/验签配置仍生效） |

### 被否决路径（仅保留决策记录，实现描述已从设计稿 §5.2 删除）

| 路径 | 否决理由 |
| --- | --- |
| **A′（loopback 临时静态服务）** | 实测**同样可行**（T0-2 / T0-3 均通过），但需额外引入：随机端口 + token 路径 + 服务生命周期（起/停）+ 非 loopback 连接拒绝；更麻烦的是 §5.2 步骤 4 要求「host/port 必须等于 `settings.update.baseUrl`」，而 loopback feed 的 host 是 `127.0.0.1:<随机端口>`，必须为该约束**开一个豁免分支**，扩大攻击面与代码复杂度。A 方案的元数据请求根本没有 host，host 白名单可**只**作用于包体下载，约束更干净。故否决，保留为 P2 备选 |
| **B（自研下载、完全绕开 updater 的元数据/下载通道）** | A 已实测可行，无理由放弃 electron-updater 已提供的 semver 比较、`downloadUpdate()` 下载管线与 `UpdateInfo` 二次比对；且 B 需自研 Range/断点/进度/缓存全套，工作量与安全风险都更高，并会触发「修订 D5 与 §10 依赖说明」的连锁改动。故否决，保留为 A 后续被推翻时的兜底记录 |

**因定案为 A（非兜底 B）**：D5 与 §10 的依赖说明**无需修订**，`electron-updater@6.3.0` 为本期正式依赖；D6「本期不启用差分」保持不变。

---

## 4. 待人工确认清单（**不得判为通过**）

| # | 项目 | 需要的环境 | 复现脚本 |
| --- | --- | --- | --- |
| M-1 | 未签名 NSIS `/S` 是否真免 UAC（per-user、`perMachine:false`） | 隔离 VM / 备用测试用户 | `manual-windows-check.ps1` §2 |
| M-2 | 安装目录一致性：不传 `/D` 时是否覆盖原目录；`/D=<InstallLocation>` 参数顺序与引号规则；错目录是否产生两份安装 / 快捷方式指向旧版 | 隔离 VM + 改过安装目录的样本 | `manual-windows-check.ps1` §1 / §2 / §3；注意本机 `InstallLocation` 为空，需按 D-2 回退 |
| M-3 | MOTW `Zone.Identifier` 是否随 electron-updater 用 Node `fs` 写文件时产生 | 隔离 VM，用 HTTP 下载一份真包 | `manual-windows-check.ps1` §4 |
| M-4 | SmartScreen /「未知发布者」在双击（ShellExecuteEx）vs `spawn`（CreateProcess）下的差异、组策略影响 | 隔离 VM | `manual-windows-check.ps1` §4 |
| M-5 | 应用 exe 仍运行时 `/S` 是等待 / 失败 / 杀进程；watchdog 等待 PID 消失后 spawn 在真机是否可靠 | 隔离 VM，装一份测试版 | `manual-windows-check.ps1` §2 + `probe-watchdog.mjs`（逻辑层已验证） |
| M-6 | NSIS 原地覆盖中途失败/断电后「旧版仍可启动」能否**额外**承诺（不降低既定验收「至少有可执行恢复路径且 `data\` 完整」） | 隔离 VM + 断电注入 | B 关断电注入单测 + 人工真机演练 |
| M-7 | 差分下载量 / Range / 404 回退全量（**P2，仅评估**） | 真实静态服务器 + 两版包 | 未产出（本期不启用差分） |
| M-8 | `customInstall` 运行时版本标记 + 「跳过未变更解压」在真实 401MB 运行时上的效果（B 关验收⑥） | 隔离 VM，连续升级两次 | `manual-windows-check.ps1` §2 扩展 |
| M-9 | 真实服务器 IP、端口与 Web 服务器类型（D15；本期不写进仓库） | 用户环境 | `docs/operations/update-service.md`（G1 产出） |

---

## 5. 复现脚本与产物清单

| 文件 | 用途 | 是否执行 |
| --- | --- | --- |
| `2026-11-06-task0-scripts/probe-updater.cjs` | T0-2/3/4/7：真实 electron-updater 6.3.0，无真包下载 | ✅ 已跑，输出 JSON |
| `2026-11-06-task0-scripts/probe-watchdog.mjs` | T0-5：watchdog 时序与退出码 | ✅ 已跑，`pass: true` |
| `2026-11-06-task0-scripts/watchdog.mjs` | 被探针调用的独立 watchdog 实现（阶段 0 版） | ✅ 已跑 |
| `2026-11-06-task0-scripts/fake-installer.mjs` | 假安装器，仅写 marker 后按指定码退出 | ✅ 已跑 |
| `2026-11-06-task0-scripts/electron-builder.task0.config.mjs` | T0-1 专用测量配置（**非生产配置**，不等于 `electron-builder.config.mjs`） | ✅ 已跑，BUILD_EXIT=0 |
| `2026-11-06-task0-scripts/manual-windows-check.ps1` | M-1…M-5/M-8 的人工复现模板 | ❌ 主 Agent **未执行**第 2–5 节（只做了等价的只读注册表查询） |

**构建副产物说明**：为避开环境批量删除保护，`apps/desktop/out/win-unpacked` 与 `win-unpacked.tmp` 被**重命名**为 `win-unpacked.pre-task0` / `win-unpacked.tmp.pre-task0` 保留（**未删除**）；`out/Sparkii-0.1.0-win-x64.exe` 被本次正常构建覆盖为新版构建产物（`latest.yml` 记录 size `306599715`）。这些均为构建产物目录，不涉及用户数据或现有安装。
