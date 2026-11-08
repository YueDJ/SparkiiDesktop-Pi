# 【审核提示词】Sparkii Desktop 自动升级实现 —— 独立只读审核

> 用法：把本文全文复制给一个新 Agent 作为首条消息。工作区保持 `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi`。

---

你是**独立审核者**，不是实施者。任务：对已完成的「自动升级机制」实现做只读审核，判定它是否真的符合设计、是否真的安全、测试是否真的有效。你**不修代码**，只出结论与证据。

## 0. 身份与只读约束（最先读）

- **除第 7 节指定的报告文件外，不得创建、修改、删除仓库内任何文件。**
- **不得为了验证而改动产品代码做变异实验。** 上一轮就发生过只读代理为了做变异实验而改动了产品文件，导致盘态需要人工逐项核对。要验证测试有效性，用**静态推演 + 追加只读探针脚本（放临时目录）**，不要碰仓库文件。
- 可以并且应该真跑只读命令：`git status`、`git diff`、`pnpm typecheck`、`pnpm lint`、`pnpm test`、`grep`。**不要跑 `dist`**——它会就地重编三个已跟踪的 `.exe`，历史上有构建失败把它们从工作树删掉的记录。产物只做只读核对，并明确指出其时效性。
- 你的结论只能来自你**自己读到的代码与自己跑出的输出**。任何「实施方说通过了」都不算证据。

## 1. 审核基准 vs 被审对象（不要混淆）

**权威基准**（判对错的尺子）：

1. `docs/superpowers/specs/2026-11-06-auto-update-design.md` —— **v3 + §0.7 修订 + §5.2.1 定案 A**。D1–D18、§0.4 四条不变量、§6 协议、§7 模块与状态机、§7.7 关机协议、§9 验收标准、§10 影响面、§11 开放问题，全部有效。
2. `docs/superpowers/specs/2026-11-06-update-interfaces.md` —— 接口契约。但注意：其 **§10「集成变更记录 I-1…I-88」是实施方的自述**，只能当线索，不能当基准。

**被审对象**（要审的东西，不是依据）：

- 全部代码改动（见 §2 清单）；
- `docs/superpowers/specs/2026-11-06-implementation-review.md` —— 实施方自审记录（R1–R18+、I-1…I-88）。**它的结论一律不采信**，但要读：它是「被审对象的自辩」，也是找问题的最快线索。凡是它自己承认的残留、回退、口径变化，必须逐条独立复核（§5）。
- `docs/superpowers/specs/2026-11-06-task0-results.md` —— 任务 0 实测。同样只当线索：抽查其中的关键结论是否与代码现状一致。

判定原则：**代码与设计稿冲突，以设计稿为准**。若设计稿本身有错，只记录、不据此判实现有罪（但要检查实施方是否按 §0 规则**先修订设计稿**再改码）。

## 2. 审核对象（当前盘态，68 项改动）

`git status --porcelain` = **29 M + 38 ?? + 1 D**。逐项都要能解释「为什么改」。

- **M（关键）**：`apps/desktop/build/installer.nsh`、`electron/main/{index,ipc,settings,document-parse-quit}.ts`、`electron/preload/{api-types,api}.ts`、`apps/desktop/package.json`、`src/{App.tsx,shell/SettingsView.tsx,shell/Shell.tsx}`、`packages/agent-host/src/pi-runtime-pool.ts`、`packages/approval/src/gate.ts`、`packages/ui/src/patterns/{Shell,StatusBar}.tsx`、`test/{document-parse-quit,preload-api,release-config}.test.ts`、`pnpm-lock.yaml`、`.gitignore`、`README*.md`、`PRODUCT.md`、`docs/{release-windows,deploy}.md`、2026-10-23 plan
- **M（需单独质疑）**：`native/windows-sandbox/bin/{HostShellRunner,SandboxProbe,SparkiiSandbox}.exe` —— 三个二进制被改。判断：这是构建副产物误入交付，还是必要变更？是否应还原？
- **D**：`apps/desktop/electron-builder.yml`（按设计删除，应有替代载体）
- **??（新增）**：`electron-builder.config.mjs`、`electron/main/shutdown.ts`、`electron/main/update-bootstrap.ts`、`electron/main/update/`（15 个模块）、`scripts/{build-main,publish-release,release-keys,sign-release,verify-release,update-watchdog}.mjs`、`scripts/update-source-template/`、`src/shell/SettingsUpdatePane.tsx`、`docs/operations/`、`test/update/`、15 个 `test/update-*.test.ts`、`test/{gate-expire,shutdown-order,sign-release,publish-release}.test.ts`、5 份 specs 文档
- **额外质疑**：`?? .workbuddy/` 出现在未跟踪列表里 —— `.gitignore` 已改但没盖住？这是项目数据目录，不该进版本库。

## 3. 先建立自己的事实（在评估结论之前）

1. 跑 `git diff --stat` 与 `git status --porcelain`，自己确认改动规模与上面一致（不一致就写出来）。
2. 自己跑并记录**真实输出**（不要引用实施方报告里的数字）：`pnpm typecheck`、`pnpm lint`、`pnpm test`。若默认并发不稳定，可用 `--maxWorkers=4`，但**必须注明这是降低并发的取数方式**，并说明是否影响判据强度。
3. 检查 `test/update*` 是否存在 `it.skip` / `it.skipIf` / `describe.skip`；列出所有条件跳过的**条件表达式**，判断它是否可能在关键时刻静默关闭校验（已知 `test/update-artifacts.test.ts` 有 `skipIf(!existsSync(appUpdateYmlPath))`，读的是构建产物）。
4. 检查 `.gitignore` 是否已覆盖 `out/`、`*.key`、`.codex-handoff/`、`.workbuddy/`；grep 仓库内是否存在私钥、真实 IP、token。

## 4. 六个审核维度

### A. 设计一致性（逐条对照，不许抽样）

- D1–D18 每条是否落地；§10 影响面清单里列的每个文件是否真的改了（**漏改也是缺陷**）。
- §7.1 模块划分是否与实际文件对应（实际有 `shutdown.ts` / `update-bootstrap.ts` / `dirs.ts` / `snapshot.ts` / `globals.d.ts`，设计稿没有——判断是合理拆分还是职责漂移）。
- §7.2 状态机与「状态不落盘、由 `pending/` 推导」是否成立（**代码里是否存在任何持久化下载/安装阶段的字段**）。
- §7.3 IPC 表与 `preload` 三层是否一一对应；`test/preload-api.test.ts` 的精确断言是否同步更新（加了方法没改断言 = 缺陷）。
- §7.5 UI 交互：状态栏 pill、小进度条、不弹窗不抢焦点、安装确认弹窗列出待审批数、0.2/0.3 二选一、设置页三入口。
- §7.10 调度：统一闸门 `shouldCheck()`、90s 启动延迟 + 抖动、24h 递归、网络/resume 补检、失败退避、提醒节流与检查节流分离、`installId` 永不出网。

### B. 安全与信任链（最重，逐条找反例）

1. **`verifier.ts` 是否真的独占「清单与策略数据」的网络入口**：grep 全仓是否还有第二处 `fetch` / `net.request` 去取 `channel.json` / `release.json` / `.sig`。
2. **`latest.yml` 是否真的本地派生**：确认服务器发布脚本**不上传** `latest.yml`；确认派生文件写在 `data/updates/feed/`；确认派生只取自已验签清单（不得掺入 `UpdateInfo` 或远端数据）。
3. 派生 `latest.yml` 的 artifact 是否**绝对远程 URL**，且校验了 host/port/scheme 与 `baseUrl` 一致。
4. **`httpExecutor` 是否在 `setFeedURL()` 之前赋值**（顺序错则注入失效）。`request()` 是否只处理 `file:`，其它 scheme 一律拒绝。
5. `download()` 是否真强制：host/port 相等、`maxRedirects = 0`、拒绝 `https → http`、8s 连接超时、超过 `artifact.bytes` 立即 abort、自己复核 sha512 与 bytes、`cancellationToken` 生效。
6. **IPC 层门禁**：`downloadUpdate` 与 `installUpdate` 是否在 Main 侧重新验签（不是只挡 UI）；`installUpdate` 是否**重新打开文件句柄**验 sha512 + 伴生清单签名 + `sequence` / `nonce` 绑定 + `expiresAt`，并持有句柄到交给安装器。
7. `lastSeenSequence` 与 `(sequence → nonce)` 绑定是否 **HMAC 保护**；文件缺失 / 解析失败 / HMAC 不匹配是否 **fail closed 且不回退默认**；`state-store` 在篡改时是静默返回还是抛错（抛错更安全，但要看调用方是否吞掉）。
8. `sequence` 语义：`channel.json` 是否唯一权威/唯一递增，`release.json` 是否等值镜像且**严格相等**才放行。
9. 发布 CLI：是否「先传整套版本目录 → 最后切指针」；是否 `.sig` 先于 `.json`；是否回读校验；**是否会上传 `latest.yml`**（上传了就是破不变量）。
10. `autoDownload === false` 与 `disableDifferentialDownload === true` 是否恒真且有单测（`autoInstallOnAppQuit` 也应关）。
11. `electron-updater` 是否锁定 `>= 6.3.0`（`package.json` 与 lockfile 都要看）。
12. `win.verifyUpdateCodeSignature: false` 的产物语义是否按 §0.7 D-4 订正为「`app-update.yml` **不含 `publisherName`**」，且产物断言是这么写的（不是断言含同名键）。

### C. 生命周期与数据安全

1. 单实例锁是否在 `app.whenReady()` **之前**；失败是否 `app.exit(0)` 而不走 `before-quit`。
2. 两个 `before-quit` 是否协调：`document-parse-quit.ts` 原本无条件 `preventDefault()`，现在是否靠 `isUpdating` 放行；`reviewer.dispose()` 钩子是否也在更新退出时正确处理；3s 兜底 `app.exit(0)` 是否存在。
3. `rt.pool` 是否复用既有 `stopAll()` 并**补了 `stopped` 闸门**拒绝新 `acquire()`（设计稿 §0.7 D-1 的修订）。
4. 三个 SQLite store 的 `close()` 是否真被调用，且顺序是**先关库再快照**。
5. 审批门 pending 是否**逐条** `expire` + 写 `update.install-abort` 审计；未清空是否阻止进入安装。
6. 整 `data\` 快照是否覆盖 `audit.db` / `-wal` / `-shm` / `sessions.db` / `errors.db` / `settings.json` / `keyring/` / `logs/` / `tasks/` / `pi-agent/`。
7. watchdog 是否「**等主进程完全消失**才 `spawn` `/S`」，超时分支是否写 `failed`；`install-result.json` 是否**只有一个写入方**（watchdog），`customInstall` 是否确实不写。
8. 安装目录（§0.7 D-2）：`InstallLocation` 为空时是否从 `UninstallString` 的带引号 exe 路径取父目录；解析失败是否 **fail closed、不传 `/D` 并拒绝自管安装**（本机实录 `InstallLocation` 为空、`UninstallString` 在 `D:\software\SparkiiPi`）。
9. `installer.nsh`：宏是否为**纯 ASCII**（makensis 3.0.4.1 对无 BOM 非 ASCII 直接报错）；`customInstall` 是否只在运行时未变更时跳过解压；`customUnInstall` 是否**只删标记**、不扩大清理范围。
10. 保留策略是否会误删「待回滚」的旧包与备份；`data/updates/` 是否有总量上限。

### D. 测试有效性（不是「测试通过」，而是「测试能不能抓住错」）

- 随机抽 **5 条**关键用例（建议从验签拒绝、sequence 回退、nonce 换值、IPC 门禁、watchdog 单一写入、断电恢复里选），读它的断言与对应实现，回答：**如果把实现改坏（不真改），这条测试会不会红？**
- 找出**弱断言**：只有 `toBeDefined()` / `not.toThrow()` / 只断言调用次数而不断言参数与副作用、`try/catch` 吞掉断言、`await` 漏写。
- 检查是否存在「用 `setTimeout` / sleep 掩盖时序」的用例，以及是否会随机器负载抖动（实施方自述有一例在并发下超时、一例 `renameSync` 在 Windows 被占用时留 `.tmp` 残留）。
- 核对 skip 数漂移（3 ↔ 4）是否真如实施方解释（`it.skipIf(!existsSync(appUpdateYmlPath))`），以及**是否存在恒实跑的同类断言兜底**。

### E. 产物与构建

- 唯一构建载体是否为 `electron-builder.config.mjs`，`electron-builder.yml` 已删，`dist` 是否加了 `--config`。
- `publish.url` 是否为占位常量、产物是否不含真实 IP；`__SPARKII_UPDATE_URL__` 是否经 esbuild `define` 注入 `build:main`（不是硬编码在源码）。
- 现有 `out/` 产物**是否对应当前盘态**：实施方自述 `out/` 属旧盘态、**不含 I-80…I-88 的修复**。那么所有产物断言都必须标为「时效性存疑，发布前须重跑 `dist`」。**不要因为 `out/` 里有文件就判产物通过。**
- 公钥注入链：`SPARKII_RELEASE_KEYS_FILE` → `__SPARKII_RELEASE_PUBLIC_KEYS__`；未注入是否**空表 ⇒ 验签全失败（fail closed）**。

### F. 文档与契约同步

`docs/release-windows.md`、`docs/deploy.md`、2026-10-23 plan 是否已不再声称「首版不做自动更新 / 不引入新网络服务」；`README.md:154` / `README.en.md:155` / `PRODUCT.md:9` 的 NSIS+MSIX 描述是否订正；`TODO.md` / `branding.ts` 若确认无冲突，是否有说明（不能只说「grep 过了」）。

## 5. 实施方已披露的残留项 —— 逐条独立复核（重点，别放过）

这些是实施方自己在记录里承认的。**不许照抄它的定性**，你要自己判断严重性：

| # | 实施方口径 | 你要回答的问题 |
| --- | --- | --- |
| 1 | A⑦「部分达成」：`windows-sandbox-spike.test.ts` 报 `cannot grant runtime ACL`，判为**环境项** | 它真的与更新链路毫无关系吗？代码里有没有任何更新路径会触发 ACL 授予？它是否掩盖了另一个真问题？「部分达成」能否算过 A 关？ |
| 2 | 用 `--maxWorkers=4` 取数，理由是默认并发下 worker 启动超时 | 这是取数回退还是**判据弱化**？在 `--maxWorkers=4` 下是否有用例实际被跳过或超时被吞？默认并发下到底红在哪，有没有产品缺陷藏在「负载抖动」里？ |
| 3 | `out/` 是旧盘态，不含 I-80…I-88 修复，「发布前必须重跑 dist」 | 那么 §3.3 的产物断言、字节数、sha256 现在**全部过期**。当前有没有任何**恒实跑**的断言能替代它？如果没有，产物层应判「未验证」而非通过 |
| 4 | skip 数在 3 ↔ 4 之间漂移，解释为 `skipIf(!existsSync(...))` | 这个解释成立吗？有没有别的 skip 也依赖构建产物？发布机上会不会连这条也跳过？ |
| 5 | `installer.ts` 曾是占位（G7 只交 `snapshot.ts`），后由 G7b 接续 | 现在的 `installer.ts` 是否**完整实现**（不是半成品 + 测试绕过）？install/snapshot/power-cut 测试是否真覆盖？ |
| 6 | 三个 native `.exe` 被改 | 这是必要变更、构建副产物，还是应该还原？会不会影响沙箱二进制的一致性校验？ |
| 7 | `?? .workbuddy/` 未跟踪 | `.gitignore` 改了但没盖住；这个目录会不会被误提交？ |
| 8 | 曾有 R10 派发失败（代理零产出），重派为 R13 | 架构线在 R8 之后是否真有过独立结论？还是用主 Agent 自述补位？ |

**另需复核 11-07 那批自审的闭合**（记录在 `implementation-review.md` 与 `.workbuddy/memory/2026-11-07.md`）：

- **R22 判了 6 条 Major**，逐条核对是否真修、修法是否只治标：`state-store.ts` 悬空 junction 误判 absent（改走 `lstatSync` 区分）、`service.ts` 的 `clearDownloaded` / `cancelDownload` 第三态出口遗漏（统一 `refuseUnreadableState` 早退）、`decision.ts` 与 `installer.ts` 的版本比较改为 semver 优先级（build 不参与）、`state-store.ts` 的 `enforceFloorFromMirror` 补 `readFailureCode` 闸门、`update-bootstrap.ts` 从 `GATE_SUPPRESSED` 移除不可达项、文档计数校正。
- **R15c 的 6 处文档分叉**是否真的收敛：同一事实（如某类错误的抑制条件、用例条数、失败前缀数量）在多份文档里是否还存在互相矛盾的版本。
- **R23 判「不通过」的三条理由**（`out/` 未重编 / 真机与真实 IO 故障未验证 / 全量唯一红项只记「部分达成」）：判断「为保守而不重跑 `dist`」这个处置在**当前阶段**是否可接受，还是已经构成发布阻塞。

**倾向性风险提示**：本项目已连跑十几轮自审（R1–R23）。轮次多不等于覆盖全，反而容易形成**共识性盲区**——同一处错误假设被多份文档反复继承、互相引用成「已确认」。你的价值是找这类盲区，不是复述已有结论。

## 6. 已知易走样点（照这个清单逐条找，别只做通读）

1. 验签字节与 updater 输入**不是同一份**（重新请求了一次元数据）。
2. `httpExecutor` 注入顺序错误（`setFeedURL` 之后赋值 ⇒ 悄悄失效，测试仍可能绿）。
3. 服务器仍在发布 `latest.yml`（不变量直接破）。
4. 派生 `latest.yml` 里写相对路径（`downloadUpdate` 会去本地 feed 找 401MB 包）。
5. `installUpdate` 只校验「文件存在」而不重验签名（TOCTOU）。
6. `sequence` 回退被放行，或 HMAC 失败时回退默认状态。
7. `autoDownload` 在某条分支被置 true（例如「强制更新」路径）。
8. 单实例锁写在了 `whenReady()` 里（第二个实例已经跑起来一半）。
9. `install-result.json` 有两个写入方（`customInstall` + watchdog 双写竞态）。
10. watchdog 先 spawn 再退出（撞文件占用，正是设计稿反复纠正的错误）。
11. 差分没关（`disableDifferentialDownload` 未恒真或没测）。
12. 状态栏进度条变成模态/遮罩/抢焦点，或每次启动都打网络请求。
13. 私钥、真实 IP、token 出现在代码、脚本、测试 fixture 或文档里。
14. 文档仍写「不做自动更新」。

## 7. 输出要求

先给**结论**，再给证据。报告写入 `docs/superpowers/specs/2026-11-07-independent-audit.md`（**这是你唯一允许写的文件**）。

结论只能是三者之一：**通过 / 有条件通过 / 不通过**。判「通过」的门槛：

- A–F 六维无 Blocker，且 §5 的 8 项残留 + R22 / R15c / R23 三批自审闭合全部有明确处置结论；
- 全部关键验收项有**你自己跑出来的**证据，没有「引用实施方」的条目；
- 无未解释的改动（68 项全部能对上设计稿或合理的工程必要性）。

报告结构：

1. **结论与判级理由**（3–5 行）
2. **改动清单核对表**：68 项 × {是否符合设计 / 是否可解释 / 备注}
3. **六维逐项核对表**：`维度 | 结论 | 证据（文件:行号 或 命令输出摘要）`
4. **缺陷清单**：按 `Blocker / Major / Minor` 分级，每条含 `文件:行号`、问题、为什么违反哪条设计（引 D 编号或 §）、最小修法建议
5. **§5 残留项与自审闭合复核结论**：8 项残留 + R22（6 条 Major）/ R15c（6 处文档分叉）/ R23（3 条不通过理由）逐条
6. **测试有效性抽样**：5 条用例 × {它能否抓住相应错误 / 依据}
7. **未验证项与风险**：明确写「我没验证什么、为什么」
8. **若判「有条件通过」**：给出「动工/发布前必须闭合的最小集合」，不要夹带优化建议

禁止事项：不要把「实施方说通过了」写成证据；不要因为测试全绿就判实现正确；不要为了凑结论去改代码；不要写「建议进一步优化」这类不落地的空话。

## 8. 可选的并行方式

若你想更快，可派 **2–3 个只读子审核**并行分线（架构线 A / 安全线 B / 生命周期+测试线 C+D），要求各自附 `文件:行号` 证据、互不参考对方结论；你负责汇总、去重、定级，并对最终结论负责。子审核同样受 §0 只读约束。
