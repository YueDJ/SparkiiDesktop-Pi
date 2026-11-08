# 更新源发布与运维手册（Sparkii 自动升级 · 发布侧）

> 适用：Windows 桌面客户端 L2 自动升级的**静态更新源**（设计稿 v3 §6 / §8，接口契约 §3 / §7）。
> 权威设计稿：`docs/superpowers/specs/2026-11-06-auto-update-design.md`。
> 配套工具：`apps/desktop/scripts/{release-keys,sign-release,publish-release,verify-release}.mjs`。
>
> **本文所有服务器地址一律用占位符**：`http://<YOUR_HOST>/sparkii-updates/`、`<YOUR_IP>`、`<YOUR_PORT>`、
> `<PUBLISH_DIR>`、`<SSH_USER>`。**绝不写入真实 IP / 域名 / token / 私钥**。仓库内不得出现真实服务器凭据。

---

## 1. 静态托管形态

- **部署位置**：在现有 RAG 服务的 Web 静态目录下挂 `/sparkii-updates/`，对外 `<YOUR_IP>:<YOUR_PORT>`。
  设计稿 D3：与 RAG 服务**同一 IP 的 80 端口**共存，**不改动任何 RAG 业务代码**；RAG 网页可顺手加一个
  「软件下载」入口。客户端只读静态文件，**永远不调 RAG 业务 API**（D11）——RAG 升级 / 换端口 / 临时挂掉
  都不影响更新检查。
- **目录**：`<PUBLISH_DIR>/sparkii-updates/`，结构见
  `apps/desktop/scripts/update-source-template/README.md`（§6.1）。
- **只读**：Web 服务器对该目录只有读权限；发布账户才可通过 SSH/带外方式写入。禁止在服务器上直接改清单。
- **禁止目录列表**：`autoindex off` / 关闭目录浏览。关闭列表避免暴露历史版本清单供攻击者挑选重放。
- **缓存策略（§8.4）**：
  - `channel.json` **必须 `Cache-Control: no-store, no-cache, must-revalidate`**：指针切换不能被缓存延迟。
  - `channel.json.sig` 同样不缓存 / 极短 TTL。
  - `releases/<version>/` 下所有文件（内容在版本目录内不可变）用 **ETag + 长缓存**（如 `max-age=31536000, immutable`）。
- **访问日志与异常告警**：保留 `GET` 访问日志；对「同一客户端短时间内大量请求旧清单 / 反复取 `.sig`」
  等异常形态做告警（对应 §8.4 与客户端 `update.verify-failed` 审计）。日志仅用于运维，不含身份信息。

### 1.1 单一逻辑指针的非原子窗口（§8.2 / Minor·5，必须理解）

静态托管没有事务能力：`channel.json` 与 `channel.json.sig` 是**两个独立物理文件**，上传之间存在毫秒级
不匹配窗口。本方案**不声称原子性**，安全性由客户端 **fail closed** 覆盖：任一文件缺失、指针签名不匹配、
`manifestSha256` 与实收 `release.json` 字节不一致，客户端一律当作「无更新」并按 §7.10 静默退避，
**绝不放行未验签内容**。因此发布顺序是硬约束（见 §2）：版本目录整套文件先就位并校验通过，**最后**才切
这一组指针文件；不存在「新策略清单 + 旧版本清单」窗口。

---

## 2. 发布 SOP（单人发布，D9）

> 单人发布：私钥由用户本人保管，去掉双人复核；但**发布日志 + 签名指纹 + sequence 必须留痕**。
> 全程在**离线研发机**上生成密钥与签名，只有「上传产物」这一步接触服务器。

| 步 | 动作 | 命令 / 说明 |
| --- | --- | --- |
| 1 | **离线生成密钥**（一次） | `node apps/desktop/scripts/release-keys.mjs --kid <kid> [--out-dir <绝对路径>]`。默认输出到 `%USERPROFILE%\.sparkii-release-keys\`。**私钥离线保管、绝不进仓库**；公钥由 **步 2 的构建注入**内置进客户端（`public-key.json` 原样作为注入源，**不需要**手工编辑 `update/config.ts`）。 |
| 2 | **构建** | 带两个构建期变量后执行 `pnpm --filter @sparkii/desktop dist`：`SPARKII_UPDATE_URL`（运行时默认更新源地址；不设 ⇒ 空 ⇒ 自动检查默认关闭，用户可在设置页手填）、`SPARKII_RELEASE_KEYS_FILE`（步 1 产出的 `public-key.json` **绝对路径**；不设 ⇒ 公钥表为空 ⇒ 任何清单验签都失败，属 fail closed，客户端不会放行未签名包）。产出 `out/Sparkii-<version>-win-x64.exe`（及 `.blockmap`，本期不启用差分）。注入实现见 `scripts/build-main.mjs` 的 esbuild `define` 与 `update/config.ts` 的 `parseReleasePublicKeys()`。 |
| 3 | **组装 + 签名** | `node apps/desktop/scripts/publish-release.mjs --artifact <包绝对路径> --version <semver> --sequence <整数> --key <private.pem> --kid <kid> --out <更新源根目录> --base-url http://<YOUR_HOST>/sparkii-updates/ --min-supported <semver> --summary <str> --highlight <str 可重复> [--blockmap <path>] [--previous-sequence <整数>]`。`--base-url` **仅用于校验 artifact URL 形态，绝不写进任何 JSON**。 |
| 4 | **离线校验** | `node apps/desktop/scripts/verify-release.mjs --out <更新源根目录> --public-key <pem 或 public-key.json>`，必须打印 `OK`（退出码 0）才允许上传。 |
| 5 | **上传版本目录** | 把 `releases/<version>/` 整套文件（安装包 → 可选 blockmap → `release.json` → `release.json.sig` → `release-manifest.json`）传到 `<PUBLISH_DIR>/sparkii-updates/releases/<version>/`。此时 `channel.json` 仍指向旧版本，客户端看不到新版本。 |
| 6 | **最后切两个指针文件** | 先传 `channel.json.sig`，再传 `channel.json`（§8.2 步骤 6）。**这是唯一让客户端看到新版本的动作**；两者都就绪后做一次远端回读校验。 |
| 7 | **人工抽查** | 用浏览器 / `curl` 取 `http://<YOUR_HOST>/sparkii-updates/channel.json` 核对 `sequence` / `targetVersion`；再跑一次 `verify-release.mjs`（把 `<out>` 指向已上传目录或本地副本）确认 `OK`。 |
| 8 | **留痕** | 记录：发布者、时间、commit、`sequence`、`kid`、签名指纹（对 `.sig` 或清单字节做 sha256）、产物清单。写入本地发布日志（不进仓库）。 |

**可选 `--dry-run`**：只计算哈希与字节、不落盘，用于预检参数与哈希，不产生任何文件。

---

## 3. sequence 管理

- `sequence` 是**全局单调计数器，只增不减**，**唯一权威来源是 `channel.json`**（§6.1.1）。
  `release.json` 携带**等值镜像** `sequence`，两者必须严格相等，否则客户端 fail closed。
- **递增只发生在发布侧组装指针时，由操作者显式给出 `sequence`**：CLI **绝不自动递增**。
  若提供 `--previous-sequence`，`sequence` 必须 `> previousSequence`，否则抛错拒绝发布。
- 镜像字段的用途：让 `pending/` 内伴生清单在离线状态下仍能提供 `sequence` 供防重放校验。
- 每次发布把「旧 sequence → 新 sequence」记入发布日志；不得复用历史 sequence。

### 3.1 客户端侧的序号下限与 DPAPI 镜像（排障口径）

- 客户端有**两份本地秘密**，都经 `safeStorage`（Windows = DPAPI，当前用户范围）落在 `<data>\keyring\<name>.enc`：
  `update-hmacKey`（32 字节随机，保护 `updates/update-state.json` 的 HMAC）与 `update-seqMirror`
  （`{sequence, nonce, version}` 的**下限镜像**）。**名字里不能有冒号**：Windows 会把 `update:x.enc` 解析成
  基名 `update` 的备用数据流（ADS），目录里就看不见这个文件，任何不保留流的备份 / 复制 / 快照都会静默丢掉它
  （实测与理由见 `docs/superpowers/specs/2026-11-06-implementation-review.md` §1.4 第 10 条）。
- 镜像只回答一个问题：`update-state.json` 不在，是**首次装机**还是**用过之后被人删掉**。
  | 现场 | 行为 | 用户/审计看到什么 |
  | --- | --- | --- |
  | 文件缺 + 镜像空 | 判首装，正常检查一次 | 无异常 |
  | 文件缺 + 镜像有值 | **本次运行拒绝自动更新**，并按镜像下限重建文件 | 状态 `STATE_TAMPERED`、更新面板显示需手动恢复；审计 `update.verify-failed`，detail 含 `state file absent but DPAPI sequence mirror exists` |
  | 文件 MAC 合法但序号低于镜像 | 只把下限**抬高**到镜像值（绝不降低），继续运行 | 审计 `update.verify-failed` 之外无用户可见变化 |
  | 镜像本身不可解析 / 形态非法 | 下限顶到 `Number.MAX_SAFE_INTEGER` ⇒ 任何清单都过不了第Ⅶ步（等效停用） | 需人工处置，见下 |
- **重启一次就算恢复**的情况：中间那行「文件缺 + 镜像有值」只封锁当前这次运行，文件已按镜像重建，下次启动即正常。
  若重启后仍然 `STATE_TAMPERED`，说明是镜像坏了，不是文件坏了。
- **被拒绝的那次运行里，手动点「下载」「安装」同样会被拒**（同一个闩锁，见契约 I-46）——这不是按钮坏了，
  而是设计上不允许在一次锚点不可信的进程里继续更新；「丢弃已下载的包」（`clearDownloaded`）**不受**这道门限制，
  用户任何时候都能清干净。排障时别把它当成 UI bug。清理自身失败时同样不许把定性洗成
  `LOCAL_STORAGE_FAILED`（I-82，见下面第 3.1 节后段）。
- 审计里**六种** `STATE_TAMPERED` 现场**各留一条**（R5 · Minor-1 之后，限流键加入 `subreason` 标识；R8 · Minor-2 补上原先零落痕的
  「MAC 不匹配」；I-63 补写侧拒绝；同标识重复仍被限流压掉，防刷库能力不变）：
  `STATE_FILE_DELETED`（文件被删、镜像还在）／`MIRROR_WRITE_FAILED`（镜像写不回，多为 `keyring\` 权限或磁盘问题）／
  `STATE_REBUILD_FAILED`（状态文件写不回）／`FLOOR_RAISE_FAILED`（抬不动下限）／
  `STATE_MAC_BROKEN`（文件在、但 MAC / 形态校验不过 = 被改过字节；`checkForUpdate` 与 `startupScan` 两个现场都会写）／
  `STATE_TAMPERED_WRITE_REFUSED`（状态文件本身不可信时**写侧的拒绝**，见下面第 123 行起那段）。
  ⚠ 本段原先写「五种」，漏的正是 I-63 那条；R21 · Minor-3 与 R15b 都独立点名这处自相矛盾，现按代码枚举的 6 个前缀改正。
  ⚠ 最后这条以前**只在界面上显示 `STATE_TAMPERED`、审计里一条都不写**，运维手册据此区分根因就失效了：
  「删档」和「改字节」在库里长得一样（都看不见）。现在两种都有独立 `subreason`，`detail` 也区分。
  ⚠ **但"两个现场都会写"不等于库里会出现两行**：限流键是「类型 + 天 + reason + subreason」，
  同一台机器同一天内 `STATE_MAC_BROKEN` 只留**一条**（这是防刷库的既有设计，不是漏写）。
  我先前把它写成"各自现场各写一条"是超出盘态的措辞（R13 抓到），实际含义是"任一现场第一次命中都会留痕"；
  要区分是启动扫描还是手动检查命中的，看 `detail` 与同一条记录里的 method 字段，不要指望两行并列。
  `reason=STATE_WRITE_FAILED` 另有七种带方法名的现场：`STATE_WRITE_FAILED_DEFERUPDATE` /
  `..._SKIPUPDATE` / `..._RESET_ID` / `..._CHECK`（= 检查成功后「记下已见版本」这一步）/
  `..._MARKSUCCESS`（同一条路上最后那步「记成功时间」）/ `..._MARKCHECK`（失败支路的失败计数）/
  `..._UNREADABLE`（状态文件的**位置读不动**，见下面的第三态）。
  ⚠ **标签长度是被判据绑死的**（R14 · Major-2）：审计限流键只接受 `^[A-Z][A-Z0-9_]{0,31}$`（≤32 字符），
  原先直接拿方法名拼出的 `..._CHECKFORUPDATE` 与 `..._RESETINSTALLID` 都是 **33 字符** ⇒ 双双退化成空标签、
  共用同一把键 ⇒ 同一次运行里先落的那条把后一条**静默压掉**，而本节当时写着"六种各留一条"。
  现在标签来自 `service.ts` 的有限枚举表，并由 `test/update-state-mirror.test.ts` 同时钉住
  「每个标签过得了键判据」与「同一天各条现场逐条落库」。
  另有 `reason=LOCAL_STORAGE_FAILED` 三种现场（R13 · Major-1，非状态文件的本地 IO）：
  `..._PLAN`（下载前的目录预检）/ `..._SETTINGS`（设置落盘）/ `..._CLEAR`（丢弃已下载的包）。
  这一类必须与 `STATE_WRITE_FAILED` 分开：前者多半是磁盘 / 权限，后者涉及防降级锚点，处置动作不同。
- **第三态：位置读不动（R19 · 差异 (c) / I-75，I-80 补全平台差异与存活性）**。`update-state.json` 这个位置可能压根不是一个能读的文件
  （`EISDIR` = 被占成目录、`EPERM` = ACL / 杀软锁、上级目录变成文件）。这一格既不是「首次装机」
  也不是「被人改过字节」，处置是**第三种**。`fileStatus()` 四态全表（`absent` / `tampered` / `unreadable` / `ok`）：
  | 判据 | 报什么 | 抬不抬「本次运行停用」闩锁 | 故障消失后 |
  | --- | --- | --- | --- |
  | 只有 `ENOENT`，且父目录确是目录 | absent（可能是首装，也可能被删 ⇒ 交给镜像判别） | — | — |
  | 文件在、MAC / 形态不符 | `STATE_TAMPERED` + `STATE_MAC_BROKEN` | **抬** | 需重启 |
  | 位置读不动（`EISDIR`/`EPERM`/上级是普通文件） | `STATE_WRITE_FAILED` + `..._UNREADABLE` | **不抬** | **同一次运行即可恢复**（I-80，见下） |
  | 合法状态文件 | `ok`，正常链路 | — | — |
  ⚠ **Windows 的 errno 平台差异（I-80）**：`updates` 上级是普通文件时，`readFileSync(<updates>/update-state.json)`
  在本机报的是 **`ENOENT` 而不是 `ENOTDIR`**（R20 与 R21 各自独立实测，errno `-4058`）。只按 `code === 'ENOENT'`
  判缺失会把这一格折成 `absent` ⇒ 镜像有序号时误报 `STATE_TAMPERED`、镜像为空时当首装且零留痕。
  现在 `ensureLoaded()` 对 `ENOENT` 补一次 `statSync(dirname(file)).isDirectory()`：父目录不是目录 ⇒
  归一为 `ENOTDIR` 第三态；父目录不存在 ⇒ 仍是正常首装。三个原本被这条平台差异绕过的形态因此都进 `unreadable`。
  ⚠ **「同一次运行即可恢复」现在有实现和用例承重（I-80）**：`ensureLoaded()` 不再把 `loaded` 当整次运行闩锁
  （故障现场每次访问都会重读），`readFailureCode` 在重新解码成功时清零；`test/update/state-store.test.ts` 有一条
  「占位目录消失、换成合法状态文件后**同一实例** `fileStatus()==='ok'` 且 `write()` 成功」的用例。
  R20 · Major / R21 · Major-1 抓到的正是这格此前只有文档承诺、零用例承重。
  出网面同样补齐（I-81）：`checkForUpdate` / `downloadUpdate` / `installUpdate` / `startupScan` 四处统一走
  `refuseUnreadableState()` ⇒ 第三态下不出网、不进安装事务、不写状态、不删包、不抬闩锁。
  排障口径：看到 `..._UNREADABLE` 就按磁盘 / 权限现场查（`dir <data>\updates`、看这个名字是不是目录、看 ACL），
  **不要**按「有人篡改了本机」去立案——反过来也一样，看到 `STATE_MAC_BROKEN` 不要当偶发 IO 故障放过去。
  两种现场都**不会**删任何已下载的包（下限不可信时一律跳过扫描，I-70 / I-75），也都照样在启动扫描里留痕。
  ⚠ 以前这里只分两态，于是「把状态文件的位置占成目录」会被读成「这台机器从没写过状态」：镜像也为空时整条更新链
  看着像全新装机、界面无痕、`phase=idle`（I-31 的删档判别当场失效）。现在 `fileStatus()` 有四态。
  ⚠ 同一类里还有 `reason=STATE_TAMPERED` + `subreason=STATE_TAMPERED_WRITE_REFUSED`：
  状态文件本身不可信时**写侧的拒绝**（R13 · Major-2：原先 store 是静默 return，
  于是"稍后提醒 / 跳过这个版本"对用户报成功、盘上一个字节没动）。看到这一条意味着
  本机状态文件被改过字节，不是磁盘坏了。
  `STATE_TAMPERED` 那**六条**的 `reason` 恒为 `STATE_TAMPERED`，`STATE_WRITE_FAILED` 那**七条**的 `reason` 是 `STATE_WRITE_FAILED`（另三种 `LOCAL_STORAGE_FAILED` 见上面第 107 行起）；detail 都带原始 IO 错误。
  ⚠ 这里原先写「五条 / 六条」，与上面「六种 / 七种」自相矛盾；按 `WRITE_FAILURE_LABELS` 的 6 个方法标签 + `writeFailureSubreason('unreadable')` = 7、`STATE_TAMPERED` 的 6 个前缀（散在各调用点，`tamperSubreasonOf` 仅返回其中 2 个值，见 `service.ts:568-569`），统一为 **6 / 7**。
  ⚠ 这两类**都伴随界面状态异常**（`stateTampered` / `phase=error`），不是纯后台噪声；
  `STATE_WRITE_FAILED` 是可恢复的运维现场（磁盘 / 权限 / 文件被占），与 `STATE_TAMPERED` 的「被人动过」要分开处理。
  另外（R7 · N-3）闩锁立起之后，**同一次运行里的后续检查不再出网**，也不会把远端版本报成「发现新版本」；
  「取消下载」（R7 · M-4）同样不会把这条异常状态洗成正常显示。
  ⚠ 例外：`scanPending` 删坏包那类审计仍按「类型 + 天 + reason」压成一条（那是可被服务端喂垃圾清单刷库的路径，故不细化）。
- ⚠ **反过来要知道的一条限制（设计 §7.9 原文就是「其余 `update.*` 按类型 + 天限流」，目的是防 MITM 刷库）**：
  生命周期事件（`update.completed` / `update.install-start` / `update.cleanup`）**同一天只落一条 AuditStore 记录**。
  也就是说"这台机器今天装过两次"在审计库里看不出两次——这不是 bug，是 §7.9 那条限流的直接代价，
  本期不放宽（放宽等于削弱一条明文门禁）。**每台机器的逐次安装历史在客户端哈希链里**
  （`<data>\updates\update-audit-chain.jsonl` 每装一次追加一条，带 `txnId`、不受限流影响），
  取证与追溯请以链为准；AuditStore 那侧只适合看"今天有没有装过 / 有没有异常"。
  链目前由 `startupScan` 里的 `verifyAuditChain` 自检，断链留 `AUDIT_CHAIN_BROKEN`（见 I-67②）。
  ⚠ **链的覆盖面（R19 · Major-2 / I-76）**：原先只有安装类进链，于是"今天真下过两次、丢弃过一次"在库里被限流压成一条、
  在链里**一条都没有**＝彻底无痕。现在 `update.download-start` / `update.download-complete` /
  `clearDownloaded` 的 `update.cleanup` 与安装失败的 `update.failed`（`reason=INSTALL_FAILED`）都同时进链。
  进链的都是**用户动作 + 已验签清单**才产得出的事件（服务端喂垃圾清单喂不出 `download-start`），不属于可被刷的路径；
  链写失败不改变任何判定（只读盘 / 权限问题时下载与安装仍按原语义走）。
- 另外两组带 `subreason` 的现场（各占一把限流键，R18 · Minor-1 / I-73 / I-77）：
  `reason=SETTINGS_CHANGED` 两种——`BASE_URL_CHANGED`（改更新源）与 `INSTALL_ID_RESET`（重置本机检查标识），
  两条都走门面留痕、且**留痕排在落盘成功之后**（写盘失败时不许声称"源已变更"，那是过度留痕）；
  `reason=INSTALL_FAILED` 的 `subreason` 取自 `installer.ts` 的事务结论（有限集合、截断到 ≤24 字符），
  表示"上次安装没装成"这一格的具体形态，界面对应设置页的红色提示 + 重试入口。
- **用户点安装失败的本次运行就留痕（I-83）**：此前 `INSTALL_FAILED` 只有 `startupScan` 读哨兵那一格同时进库 + 进链，
  用户当面点「安装」失败时事务路径只进链、门面路径既不进库也不进链 ⇒ 本次运行 AuditStore 里查不到。
  现在 `installUpdate` 返回失败、`installer.ts` 的 `blocked()` 事务中止、`startupScan` 三条出口都写
  `reason=INSTALL_FAILED`（库 + 链），排障时不必等下次重启。
- **清理失败也不许洗掉锚点异常（I-82）**：`clearDownloaded` 成功支路一直保持 `stateTampered=true / STATE_TAMPERED`，
  但删包失败的 early-return 分支原先只报 `LOCAL_STORAGE_FAILED`，把界面上的定性洗掉了。
  现在两条出口一致：闩锁在场时一律以 `STATE_TAMPERED` 说话，本地 IO 原因留在 `detail` 里。
- **可自愈的本地 IO 故障不计入「连续不可用」（I-84 / §7.10）**：`STATE_WRITE_FAILED` 是 I-74/I-75 承诺「故障消失后同实例即恢复」的现场——状态文件位置读不动时 `checkForUpdate` 在出网之前就早退并回报该 reason，它经调度层 `afterOutcome()` 进入 `GATE_SUPPRESSED` ⇒ 始终排 15min 闸门心跳、不累加、不出现「降级为仅手动」告警。⚠ `LOCAL_STORAGE_FAILED` 是另一类本地 IO 故障，但**只**由 IPC 用户动作（`saveSettings` / `planDownload` / `clearDownloaded`）回报、不经调度链路，因此**不是**闸门抑制项（用户主动操作本就不参与自动排期）；R22 · Maj-5 据此把冗余的该抑制项从集合中移除，使 `GATE_SUPPRESSED` 每一项都可达。`STATE_TAMPERED`（by-design 拒绝、需重启）**仍计入不可用**，R18 · Minor-3 的登记不改：只排除可自愈那一类，不把「拒绝」与「不可用」混起来。
  `STATE_TAMPERED`（by-design 拒绝、需重启）**仍计入不可用**，R18 · Minor-3 的登记不改：
  只排除可自愈那一类，不把「拒绝」与「不可用」两个语义混起来。
- 人工恢复（最后手段，必须发布负责人确认）：在**该 Windows 用户**下删除 `<data>\keyring\update-seqMirror.enc`，
  并**同时**删除 `<data>\updates\update-state.json` —— 只删一个会留下互相矛盾的下限。
  这等于放弃这台机器的防降级历史（回到首装口径），执行前确认该机没有需要保住的版本轨迹。
- **不提供任何 UI / IPC 入口来重置镜像**（刻意设计：任何能重置下限的入口都是攻击面）。
  设置面板里的「重置检查标识」只影响检查时间的散布，不动下限。

---

## 4. 密钥管理

- **生成**：`release-keys.mjs` 用 `node:crypto` 的 `generateKeyPairSync('ed25519', …)`（spki 公钥 /
  pkcs8 私钥），与 `packages/config/src/integrity.ts` 的 `generateKeyPair()` 一致。
  参数只有 `--kid <kid> [--out-dir <绝对路径>] [--not-before ISO] [--not-after ISO] [--rotate]`，**没有 `list` 之类的子命令**；
  想核对已生成的 kid / 公钥请读 `<out-dir>\public-key.json`（它就是构建注入用的 `SPARKII_RELEASE_KEYS_FILE`）。
- **覆盖防护**（R8 · Minor-1）：同一 `--kid` 重跑时，若 `<out-dir>\<kid>.private.pem` 已存在则**直接报错退出**，
  不覆盖。理由：销毁旧私钥等于让此前用该 `kid` 签发的清单**永远无法重签或补发**（撤回、补公告都办不了），
  而客户端只认内置公钥。确要换钥必须显式加 `--rotate`，并在换钥后按上一条走一次完整的 kid ↔ 公钥核对。
- **私钥**：由用户本人**离线保管，绝不进仓库**（`.gitignore` 已忽略 `*.key`、`*.private.pem` 与 `.sparkii-release-keys/`；默认输出目录在
  `%USERPROFILE%` 下 —— 若用 `--out-dir` 把目录选在仓库内，`*.private.pem` 仍会被忽略，公钥 `*.public.pem` / `public-key.json` 不受影响）。Windows 下请**手工设置 ACL**，仅允许发布者账户读取；POSIX 下工具已尝试 `chmod 600`。
  任何脚本 / 产物 / 日志都**不得打印或写入私钥内容**。
- **公钥**：编译期内置客户端（带 `notBefore / notAfter`）。每把密钥有 `kid`，**`kid` 计入签名输入**：
  `sign(kid || 0x00 || sha256(fileBytes))`，签名覆盖文件**原始字节**。
- **轮换**：新公钥**随一次「用旧密钥签名」的更新下发**，旧钥保留过渡期；客户端按 `kid` 选钥。
  轮换期结束后再停用旧 `kid`。
- **泄露带外预案（必须线下执行，不能只靠带内）**：
  1. **立即下线更新源**（撤掉 `/sparkii-updates/` 或置为 503 / 下线静态目录）；
  2. **人工通知**所有客户「不要点升级」（邮件 / 电话 / IM，带外通道）；
  3. 发布**全量重装**的新版本，内置**新公钥**（新 `kid`），旧公钥从内置列表移除；
  4. 必要时签发**撤销清单**。
  > **HTTP 下带内撤销清单可能被中间人屏蔽**，因此绝不能把「下发撤销清单」当作唯一手段；
  > 下线更新源 + 人工通知 + 全量重装才是主路径（§8.3）。

---

## 5. 紧急撤回

- **下线某版本**：不要改 `sequence` 往下走（只增不减）。做法是把 `channel.json` 切回上一个**合法且未过期**
  的版本指针，或直接**下线整个更新源静态目录**；同时把问题版本目录移出可访问路径。
- **通知「不要点升级」**：走带外通道（邮件 / 公告 / IM）明确告知用户暂缓升级；客户端在更新源不可达时
  会静默退避、当作「无更新」，不会误装。
- 撤回后重新发布必须用一个**新的、更大的 `sequence`**，并留痕说明撤回原因。
- 若怀疑私钥泄露，按 §4 泄露预案处理，而不是仅做指针回切。

---

## 6. 签名与校验速查

- `.sig` 文件是 JSON envelope：`{"kid":"<kid>","signature":"<base64>"}`。
- 签名输入：`kid || 0x00 || sha256(文件原始字节)`，Ed25519 `sign(null, …)`，覆盖**原始字节**、不做归一化。
- 客户端验签顺序（§6.3，任一失败 fail closed）：指针形态/正则 → 指针签名 → 实收 `release.json`
  的 sha256 == `manifestSha256` → 清单签名 → `sequence` 相等 → `expiresAt` 未过 / nonce 绑定 →
  包体 sha512 / bytes 终检。
- `verify-release.mjs` 是**离线**工具：不联网、不改客户端、只读一棵发布树，输出 `OK` / `FAIL <reason>`，
  退出码 0 / 1。

---

## 7. 本期 P2 不做（明确边界，勿在本期引入）

按设计稿 §9 / §8.3，以下内容**本期一律不做**：

- 双层根密钥（离线根公钥 + 日常签名密钥）；
- 服务端单调哈希链 / 发布透明日志（注意与「客户端审计哈希链」B 关不是同一组件）；
- **差分启用**（本期恒定 `disableDifferentialDownload = true`，`.blockmap` 仅复制留存供评估）；
- 强制更新（`mandatory`）、灰度（`rollout.percentage` 恒 100）；
- 代码签名（Authenticode 证书采购与 `verifyUpdateCodeSignature` 回启）。

本期信任完全来自 **§6.3 的内容签名 + §5.2 单一已验签字节入口**；无证书、单人发布、静态托管。

---

## 8. 占位符对照

| 占位符 | 含义 |
| --- | --- |
| `<YOUR_HOST>` / `<YOUR_IP>` | 更新源主机名 / IP（占位，不写进仓库） |
| `<YOUR_PORT>` | 对外端口（设计稿 D3 为 80） |
| `<PUBLISH_DIR>` | 服务器上静态目录父路径 |
| `<SSH_USER>` | 发布上传账户 |
| `<kid>` | 密钥标识（计入签名输入） |
| `<version>` / `<semver>` | 版本号，如 `0.3.0` |
