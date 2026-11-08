# Windows 内部试用版发布说明

## 适用范围

当前发布渠道仅面向受控的内部试用用户。本期发布形态 = **Windows x64 未签名 per-user NSIS 安装包 + L2 自动升级**（发现新版 → 下载 → 安装 → 重启）。MSIX / AppX 仍不在范围内：`apps/desktop/electron-builder.config.mjs` 的 `win.target` 只有 `['nsis']`，不配置也不产出 `.appx`。

本期**不采购代码签名证书**，因此构建配置里设了 `win.verifyUpdateCodeSignature: false`（设计稿 §5.5 / §0.7 P0-4）。它的准确含义是：该开关为构建期开关，产物效果是 `resources/app-update.yml` **不含 `publisherName`**（不会写入同名键），`NsisUpdater.verifySignature()` 因此跳过 Authenticode 验签——即**安装更新时不验证任何签名**（不影响首次手动安装）。**升级链路的信任不来自 Authenticode，而来自更新清单的 Ed25519 内容签名 + 包体 sha512 终检**（设计稿 §6.3 / §5.2 定案 A：`verifier.ts` 是清单与策略数据的唯一网络入口，`latest.yml` 由客户端从已验签清单本地派生，服务器不上传 `latest.yml`）。采购证书后必须删除该开关并写进发布 checklist。

安装包本身仍是未签名的，Windows SmartScreen 可能显示“未知发布者”。安装包不得作为公开下载版本发布。

> 权威文档：设计 `docs/superpowers/specs/2026-11-06-auto-update-design.md`（v3，含 §0.7 实测修订）；接口契约 `docs/superpowers/specs/2026-11-06-update-interfaces.md`；**更新源的服务端运维规范以 `docs/operations/update-service.md` 为唯一权威**，本文只引用、不另立一份规范。

## 构建环境

- Windows x64；
- Node.js 22 或更高版本（watchdog 用 Node SEA 构建，注入的 blob 只支持 CommonJS）；
- pnpm 9 或更高版本；
- 原生模块需要重新编译时，安装 Visual Studio C++ Build Tools。

运行时归档固定放在 `apps/desktop/runtime/`，构建前会校验 Portable Git、文档解析和搜索工具的固定 SHA256。

### 安装 watchdog（B1 载体）与签名

`dist` 会先跑 `pnpm build:watchdog`（`scripts/build-watchdog-sea.mjs`），把 `scripts/update-watchdog.mjs` 打成独立可执行文件 `apps/desktop/build/watchdog/sparkii-update-watchdog.exe`（Node SEA，未签名产物约 80+ MiB，不入库），再由 `electron-builder.config.mjs` 的 `extraResources` 以 `resources/scripts/sparkii-update-watchdog.exe` 随包发布。运行时主进程把它**复制到 `<dataDir>\updates\watchdog\`（`$INSTDIR` 之外）**再 spawn——这是避开 NSIS 两个 `CHECK_APP_RUNNING` kill 点与旧卸载器文件锁的硬条件，不要改回「`$INSTDIR\Sparkii.exe` + `ELECTRON_RUN_AS_NODE`」的旧形态。

postject 注入会破坏 node.exe 自带的 Authenticode 签名（构建时会提示 `The signature seems corrupted!`）。发布构建**必须**用与 app 相同的证书重签该 exe，否则 SmartScreen/MOTW 行为不可预期。设置以下环境变量后构建脚本会自动签名：

| 环境变量 | 含义 |
| --- | --- |
| `SPARKII_SIGNTOOL` | `signtool.exe` 路径（Windows SDK） |
| `SPARKII_SIGN_CERT` | 证书文件（.pfx）路径 |
| `SPARKII_SIGN_CERT_PASSWORD` | 证书密码（可选） |
| `SPARKII_SIGN_TIMESTAMP_URL` | 时间戳服务，默认 `http://timestamp.digicert.com` |

未设置时构建脚本会打印**醒目警告**并继续（内部试用可接受；正式发布必须在隔离 VM 验收清单里勾「watchdog 已签名」）。

## 构建

在仓库根目录运行：

```powershell
$env:CI = 'true'
pnpm install --frozen-lockfile
pnpm --dir apps/desktop dist
```

构建机应优先使用根 `package.json` 声明的 pnpm 9.15.0。若机器上的 pnpm 主版本更高，`CI=true` 可让非交互环境完成依赖目录一致性检查，避免构建被 TTY 提示中断。

构建完成后，`apps/desktop/out/` 应包含：

- `Sparkii-<version>-win-x64.exe`；
- `release-manifest.json`；
- `SHA256SUMS.txt`。

旧的 `Sparkii Setup *.exe` 和 `.appx` 文件不属于当前发布格式，不应继续分发。

升级链路相关的产物（`out/latest.yml`、`resources/app-update.yml`）见下文「发布与更新源」。

## 发布与更新源

本节只给本期发布链路的操作事实与开关。**服务端侧（静态托管形态、缓存策略、发布 SOP、sequence 管理、密钥管理、紧急撤回、泄露预案）以 `docs/operations/update-service.md` 为准，更新源目录结构以 `apps/desktop/scripts/update-source-template/README.md` 为准**，本文不复制规范，避免出现第二份互相矛盾的口径。

### 构建注入

`apps/desktop/scripts/build-main.mjs`（`build:main`）用 esbuild 的 `define` 注入两个编译期常量，值由发布/构建者在本机环境变量给出，**都不写进仓库**：

| 环境变量 | 注入的常量 | 未注入时的行为 |
| --- | --- | --- |
| `SPARKII_UPDATE_URL` | `__SPARKII_UPDATE_URL__`：运行时默认更新源地址，被 `electron/main/update/config.ts` 读作 `settings.update.baseUrl` 的默认值 | 空字符串 ⇒ **自动检查关闭**（未配置更新源时不发起任何网络检查）；地址可经 `saveUpdateSettings` 写入（严格校验 + 写审计） |
| `SPARKII_RELEASE_KEYS_FILE` | `__SPARKII_RELEASE_PUBLIC_KEYS__`：**公钥清单 JSON 文件**（由 `scripts/release-keys.mjs` 产出的 `public-key.json`）的原文 | 公钥表为空 ⇒ **所有清单验签失败**，属 fail closed；绝不退化成「无公钥就放行未签名包」 |

- `SPARKII_RELEASE_KEYS_FILE` 指向的文件若为空白，`build-main.mjs` 直接抛错终止构建。**私钥永不进仓库、也不进构建产物**：`release-keys.mjs` 默认把密钥对输出到仓库外的 `%USERPROFILE%\.sparkii-release-keys\`，Windows 下需人工设置 ACL 仅允许发布者账户读取（运维手册 §4）。
- 运行时地址与 `electron-builder.config.mjs` 里的 `publish.url` **无关**：后者是构建期占位常量 `http://localhost/sparkii-updates/`，仅用于让 builder 产出元数据文件，**永不用于运行时网络请求**（设计稿 §5.4 / D18）。

### 打包

在仓库根目录运行：

```powershell
pnpm --filter @sparkii/desktop dist
```

实际执行 `electron-builder --win nsis --publish never --config electron-builder.config.mjs`。`--publish never` 只禁止上传、**不禁止生成**更新元数据，因此产物包含：

- `out/Sparkii-<version>-win-x64.exe` 与同名 `.blockmap`；
- `out/latest.yml` —— **仅构建期产物，不上传服务器**。服务端唯一权威清单是 `release.json`，客户端从已验签清单**本地派生** `latest.yml`（设计稿 §5.2 定案 A / §6.1）；
- `out/win-unpacked/resources/app-update.yml` —— 实测内容只有 `provider: generic` / `url: http://localhost/sparkii-updates/` / `updaterCacheDirName: sparkii-desktop-updater` 三行，**不含 `publisherName`**（§0.7 P0-4）；
- `out/release-manifest.json`、`out/SHA256SUMS.txt`。

上述形态由 `apps/desktop/test/release-config.test.ts`（`win.target` / nsis / 元数据 / `dist` 用 `--config electron-builder.config.mjs`）与 `apps/desktop/test/update-artifacts.test.ts`（`publish.url` 为占位常量、构建配置含 `verifyUpdateCodeSignature: false`、`electron-builder.yml` 已删除）断言固化；其中针对 `out/latest.yml` 与 `resources/app-update.yml` 实物内容（不含 `publisherName`、不含真实 IP）的两条断言在产物存在时才执行（`skipIf(!existsSync(...))`），因此**发布前仍需人工按上文「发布检查」实测确认**。`.blockmap` 本期**不启用差分**（D6：恒定 `disableDifferentialDownload = true`，`release.json` 不带差分 URL，updater 不请求 blockmap），仅留存供 P2 评估。

### 发布

签名与组装在**离线研发机**上完成，只有上传一步接触服务器。调用形态：

```powershell
node apps/desktop/scripts/publish-release.mjs `
  --artifact <安装包绝对路径> --version <semver> --sequence <整数> `
  --key <private.pem> --kid <kid> --out <更新源根目录> `
  --base-url http://<更新源地址>/sparkii-updates/ `
  --min-supported <semver> --summary <说明> --highlight <要点> `
  [--blockmap <路径>] [--previous-sequence <整数>] [--dry-run]
```

- 产出 `channel.json` + `channel.json.sig` 这一组**单一逻辑指针（两个物理文件）**，以及 `releases/<version>/` 整套文件（安装包 → 可选 blockmap → `release.json` + `release.json.sig` → `release-manifest.json`）。
- `sequence` 由操作者显式给出，**唯一递增处是指针**，`release.json` 写等值镜像且必须严格相等；CLI **绝不自动递增**，给了 `--previous-sequence` 时不满足单调即拒绝发布。
- `--base-url` **只用于校验 artifact URL 形态**（拼上去后 host / scheme 必须与 base 一致），**绝不写进任何清单或产物**；脚本另有产物扫描，防止私钥与真实地址出现在发布树里。示例一律写占位符 `http://<更新源地址>/sparkii-updates/`（运维手册 `docs/operations/update-service.md` 里同一占位符写作 `<YOUR_HOST>` / `<YOUR_IP>`，含义相同，都是「不写进仓库的实际主机」）。
- 上传顺序 = 设计稿 §8.2 的七步，但**当前只有第 1–3 步与第 7 步由脚本完成**：校验 → 组装并递增 sequence → 离线 Ed25519 签名（`kid` 计入签名输入）→ **人工**上传整套版本目录 → **人工**回读校验所有文件（含 `.sig`、可选 blockmap）的哈希与签名 → **最后**先传 `channel.json.sig`、再传 `channel.json` 切指针，切完再人工回读一次 → 脚本输出本地发布记录。设计 §8.2 的「SSH 上传 + 远端回读」尚未实现（m3 已登记），不要在文档里把它当成已自动化。
- 上传前必须先离线校验通过：`node apps/desktop/scripts/verify-release.mjs --out <更新源根目录> --public-key <pem 或 public-key.json>` 打印 `OK`（退出码 0）。
- 静态托管没有事务能力，指针两个文件之间存在毫秒级非原子窗口，**本方案不声称原子性**：由客户端 fail closed 覆盖（任一文件缺失、签名不匹配、清单哈希不一致一律当作「无更新」并静默退避）。

### 更新源目录形态

更新源不是新增服务：在现有 RAG 服务的 Web 静态目录下挂一个只读静态目录 `/sparkii-updates/`，与 RAG 服务**同一 IP 的 80 端口**共存（设计稿 D3 / D11 / §8.1）。客户端**只读静态文件，永不调用 RAG 业务 API**。

目录结构、每个文件的用途与缓存策略（`channel.json` 必须 `no-store`、版本目录用 ETag + 长缓存、禁止目录列表）对照：

- `apps/desktop/scripts/update-source-template/README.md`（结构模板 + Nginx / IIS 示例片段）；
- `docs/operations/update-service.md`（部署位置、只读权限、日志与异常告警、发布 SOP）。

## 安装与数据位置

- 安装器为 per-user one-click 模式，不要求管理员权限；
- 首次启动会在当前用户目录准备内置运行时；
- 用户数据位于 `%LOCALAPPDATA%\SparkiiDesktop\data`；
- 覆盖安装和卸载不会删除该数据目录。

## 发布检查

对最终安装包执行：

```powershell
$artifact = Get-ChildItem -LiteralPath 'apps/desktop/out' -File |
  Where-Object { $_.Name -like 'Sparkii-*-win-x64.exe' } |
  Select-Object -First 1
$artifact.VersionInfo | Select-Object CompanyName,ProductName,FileVersion,LegalCopyright
Get-AuthenticodeSignature -LiteralPath $artifact.FullName |
  Select-Object Status,StatusMessage
Get-Content -LiteralPath 'apps/desktop/out/release-manifest.json'
```

预期：

- `CompanyName` 为 `深圳宇岳向上科技有限公司`；
- `ProductName` 为 `Sparkii`；
- 安装包签名状态按当前策略为 `NotSigned`（本期未采购证书）；**但 `out/win-unpacked/resources/scripts/sparkii-update-watchdog.exe` 必须与 app 使用同一张证书签名**，发布构建若设置了 `SPARKII_SIGNTOOL` / `SPARKII_SIGN_CERT`，用 `Get-AuthenticodeSignature` 确认其状态为 `Valid`；未签名时构建日志会有醒目的 WARNING，必须在隔离 VM 验收清单里登记为未完成项；
- `release-manifest.json` 中的 SHA256 与 `SHA256SUMS.txt` 一致。
- 升级链路产物：`out/latest.yml` 存在但**不上传服务器**；`resources/app-update.yml` 只有 `provider / url / updaterCacheDirName` 三行，**不含 `publisherName`**，且 `url` 是占位常量；发布树与构建产物中**不得出现真实服务器 IP、域名或任何私钥**。

发布侧另有四条**本期未自动化**的口径差异（审核记录 R2 · Minor A1–A3 与 R8 · Minor-1 登记为后续加固项），发布时必须人工确认——否则「脚本自检通过」并不等于「客户端会接受」：

1. **kid ↔ 公钥对应**：`verify-release.mjs --kid` 用的是操作者手里的期望值，脚本本身不验证该 kid 真对应内置进客户端的那把公钥。核对方式：**把构建时 `SPARKII_RELEASE_KEYS_FILE` 指向的那一份 `public-key.json` 原样交给自检**——`node apps/desktop/scripts/verify-release.mjs --out <发布树根> --public-key <同一份 public-key.json> --kid <kid>`。该文件同时带 `kid` 与 `publicKeyPem`，所以对应关系由构造成立；换成手写 PEM 或另取一份文件就重新出现人为错配的空间。⚠ `release-keys.mjs` **没有 `list` 子命令**（本条先前写成 `list`，属不存在的命令，R8 · Minor-1 更正），它只有 `--kid/--out-dir/--not-before/--not-after/--rotate`；同 kid 重跑默认**拒绝覆盖已有私钥**，要换钥必须显式加 `--rotate`。
2. **密钥有效期**：脚本自检**不查** `notBefore / notAfter`，客户端会查（`config.ts` 的 `parseReleasePublicKeys`）⇒ 过期密钥签出的树能过自检却被全员拒收。发布前用客户端同口径核一次有效期窗口。
3. **远端回读**：上传完成后从**真实 URL** 回读 `channel.json` / `channel.json.sig` 与对应 `releases/<version>/` 两个文件，逐文件比哈希，确认 CDN / Web 服务器没有改写换行或尾部空白（设计 §8.2 的这一步目前只有本手册描述，没有脚本）。
4. **版本段判据两侧同源**（R5 · Major-1 修复后的新保证）：`publish-release.mjs` / `verify-release.mjs` 与客户端 `dirs.ts` 共用同一条 semver 判据，一致性由 `test/update-version-parity.test.ts` 用同一语料对拍；改任何一侧判据都必须让这条测试先变红。

在干净的 Windows 10 或 Windows 11 x64 用户环境中至少验证：

1. 普通用户双击安装，不出现管理员权限要求；
2. 首次启动完成运行时准备；
3. 设置中的“关于”显示公司名称和未签名状态；
4. 覆盖安装后用户数据保留；
5. 卸载后 `%LOCALAPPDATA%\SparkiiDesktop\data` 保留；
6. 在目标杀毒软件策略下能够安装和启动；
7. 升级链路：「设置 → 关于」检查更新可发现新版，点「下载」出现状态栏进度且完成后为「已下载完，可以安装」，点「安装」后自动重启为新版，审计 / 会话 / 设置 / 密钥完整（真机项仍列「需人工确认」，见下一节）。

## 自动升级的待人工确认项

以下各项涉及真实 GUI / 真实安装行为，**开发机上未做真机验证，状态一律是「需人工确认」，不得视为已通过**。清单原文见设计稿 §11 与 `docs/superpowers/specs/2026-11-06-task0-results.md` §4（M-1…M-9）；**M-10 / M-11 是实现期新增**（分别来自序号下限镜像与安装目录锚定这两条新前提，编号沿用同一序列）。

复现模板：`docs/superpowers/specs/2026-11-06-task0-scripts/manual-windows-check.ps1`

- **第 1 节只读**（查注册表里的安装位置），任意机器可跑；
- **第 2–4 节是注释模板**，只能在**隔离 VM / 备用测试用户**上执行，用临时安装目录 + 临时 `SPARKII_DATA_DIR` + 安装包副本；**绝不允许指向真实安装目录或真实 `%LOCALAPPDATA%\SparkiiDesktop\data`**。主 Agent 未执行这些节。

| 项 | 需人工确认的行为 | 已有事实（不构成通过） |
| --- | --- | --- |
| M-1 | 未签名 per-user NSIS（`perMachine: false`）的 `/S` 静默安装是否真的免 UAC | 配置与安装形态已确认；真机 UAC 行为未验证 |
| M-2 | 安装目录一致性：不传 `/D` 时 `/S` 是否覆盖原目录；`/D=<path>` 的参数顺序（必须最后一个且不加引号）；错目录是否产生两份安装 / 快捷方式仍指向旧版 | 只读注册表实测本机 `InstallLocation` 为**空**、`UninstallString` 指向自定义目录，故实现按 §0.7 P0-2 加了从 `UninstallString` 取父目录的回退，仍解析失败则 fail closed、不传 `/D` 并拒绝自管安装；真机行为未验证 |
| M-3 | MOTW / `Zone.Identifier`：electron-updater 用 Node `fs` 写文件时是否产生该流 | 不能假设，需在隔离 VM 用 HTTP 下载一份真包后观察 |
| M-4 | SmartScreen /「未知发布者」：watchdog `spawn`（`CreateProcess`）与资源管理器双击（`ShellExecuteEx`）的差异、各 Windows 版本与组策略表现 | 未验证 |
| M-5 | 应用 exe 仍在运行时 `/S` 是等待 / 失败 / 杀进程；watchdog 等待主进程 PID 消失后 `spawn` 在真机是否可靠 | 「等 PID 消失 → spawn → 回写 exitCode」已用假安装器 + 临时目录闭环（`probe-watchdog.mjs`，`pass: true`，含成功/失败/超时三场景）；真机行为仍需人工确认 |
| M-6 | NSIS 原地覆盖中途失败 / 断电后，能否**额外**承诺「旧版仍可启动」 | B 关既定验收是「至少有可执行恢复路径且 `data\` 完整」，本项实测不降低该标准 |
| M-8 | `customInstall` 的运行时版本标记 + 「跳过未变更解压」在真实约 401MB 运行时上的连续升级效果（B 关验收⑥） | 未验证 |
| M-9 | 真实服务器 IP / 端口与 Web 服务器类型（设计稿 D15） | 属部署环境事实，**不写进仓库**；见 `docs/operations/update-service.md` |
| M-10 | **DPAPI 序号下限镜像**（`update-seqMirror`）在漫游 profile / 换机 / DPAPI 主密钥轮换后是否仍可读；读不到时须表现为「拒绝自动更新」而不是「当作首次装机」 | 单测用内存 keyring 替身，证不了真 DPAPI 边界；删 `update-state.json` 的验证**只能在临时 `SPARKII_DATA_DIR` 副本上做**，禁止碰真实 `data\` |
| M-11 | **安装目录锚定**（`assertInstallDirAnchored` 以 `dirname(process.execPath)` 为权威）在便携版 / 手工移动安装目录 / 符号链接启动下是否会误拒合法用户 | ⚠ 判据已按 R8 · Major-3 收紧为**只认精确相等**（「候选为祖先」那种形态现在是**拒绝**，不再算相符——旧版这句是过时的，R13 抓到）。单测覆盖：精确相等 / 大小写与尾分隔符归一 / 子孙拒 / 旁支拒 / 换盘符拒 / 取不到 execPath 拒 / 盘根与 UNC 共享根与用户主目录拒，另加 HKCU 填 `C:\` 的端到端；`\\?\` 前缀、8.3 短名、符号链接三种形态只有代码路径推演（结论是 fail closed，不误放行），**无单测**（R14 指出）；真机安装位置形态无法在开发机复现 |
| M-12 | 第一次安装未结束时再点「重试安装」：是否真会出现两个 detached watchdog 并存、同写 `install-result.json`，以及让位一方的结果归属是否符合预期（I-52） | 真机进程时序无法在开发机复现。⚠ 「8 轮并发把让位分支压成必然触发」这句**不成立**（R11 · Major-B 实测 0/80 未触发，我先前写的是愿望不是取证）：现在让位分支由一条**确定性**用例独占钉住（另一进程持有结果文件读句柄 ⇒ rename 必失败 ⇒ 断言不覆盖先赢方、不留 `.tmp`、不改判退出码），8 轮那条只证"正常并发下结果始终是完整 JSON"。**B1 后形态已变（2026-11-08）**：载体固定部署到 `<dataDir>\updates\watchdog\sparkii-update-watchdog.exe`，第二次安装的 `copyFile` 覆盖正在运行的载体大概率 EBUSY ⇒ 事务 fail closed，「两个 watchdog 并存」可能已不可达；真机只需确认失败是**可读的 INSTALL_BLOCKED**、旧版与数据未受损，而不是"必然并存" |
| M-13 | **运行时内容版本常量** `SPARKII_RUNTIME_VERSION`（`build/installer.nsh`）靠人工递增 | 忘记递增 ⇒ 运行时内容变了却跳过解压（静默装旧运行时）。发布检查必须逐版确认：只要 `apps/desktop/runtime/` 下 portable-git / document-parse / tools 内容有变，就递增该常量；本轮实现无法自动把常量与内容哈希绑定（决策 5） |

M-7（差分下载量 / Range / 404 回退全量）按 D6 **本期不启用差分**，仅列 P2，不影响本期验收。
