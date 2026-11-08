# 【开工提示词】Sparkii Desktop 自动升级机制 —— 从零实施到架构审核通过

> 用法：把本文全文复制给一个新的 Agent 作为首条消息。工作区保持 `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi`。

---

你是本任务的**主 Agent（总负责人）**。目标：把已定稿的自动升级设计**完整落地为可运行代码**，并通过独立架构审核；**在审核全部通过之前不要向用户汇报、不要中途停下来等确认**。

## 0. 权威来源与工作区规则

- 工作区：`C:\Users\YDJ\Desktop\SparkiiDesktop-Pi`（Windows / Git Bash）。根：`package.json` 是 pnpm workspace，Node ≥22；脚本 `pnpm test`(vitest)、`pnpm lint`、`pnpm typecheck`、`pnpm build`；桌面端 `apps/desktop` 的 `dist` 走 electron-builder NSIS。
- **唯一设计真相源**：`docs/superpowers/specs/2026-11-06-auto-update-design.md`（**v3 定稿，架构审核已通过**）。先完整读一遍；本文引用的 D1–D18、§0–§11、任务 0 / A 关 / B 关 均指该文档。
- 先读 `AGENTS.md` 并遵守其 sub agent **文件交接约定**：本环境父线程发给子 agent 的 payload 可能丢失（空信封），因此派活必须写文件、消息里只给文件路径。
- 若 `.codex-handoff/CURRENT.md` 存在且首部为 `status: open`，以该文件正文为权威补充，逐字执行，不改写/不删除，并在最终汇报引用其 `task-id`。
- **以设计稿为准**；代码与设计稿冲突时按设计稿实现并列入汇报。若发现设计稿本身有错，**先修订设计稿并记录修订理由**再改代码，不允许代码静默偏离。设计稿 §0.2 / §0.5 / §0.6 的审核与决策记录不得删除。
- **不自动 `git commit` / `git push`**，改动留在工作区。

## 1. 范围：从头到尾全部完成

1. **阶段 0**：现状复核 → 任务 0 实测 → §5.2 路径定案（串行，是后面所有工作的前提）
2. **A 关**：发现与下载（设计稿 §9）
3. **B 关**：安装与重启（设计稿 §9）
4. 文档同步、全量测试、类型检查、lint、构建产物断言
5. **多轮独立架构审核，直到全部判「通过」**
6. 一次性汇报

P2 项一律不做（差分启用、强制更新、灰度、RAG 发布后台、双层根密钥、发布透明日志、代码签名接入）。**本期不启用差分**（D6：恒定 `disableDifferentialDownload = true`）。

## 2. 硬性安全边界（违反即任务失败）

- 不得删除/清空 Desktop、Downloads、Documents、Home、`%LOCALAPPDATA%\SparkiiDesktop\data`、`.workbuddy/` 或任何系统目录。
- **不得在当前开发机上执行会覆盖现有安装、或改动真实 `data\` 的验证**：真实 NSIS `/S` 重装、`customUnInstall`、清空 `pending/` 一律禁止。B 关安装验证必须用隔离手段：临时 `SPARKII_DATA_DIR`、临时安装目录副本、假安装器脚本，或产出可复现脚本供人工执行。
- 不得把私钥、真实服务器 IP、token 写进仓库；示例密钥离线生成后立即加入忽略规则。
- **不得伪造任何测试或实测输出**。跑不动就如实记「未验证」，列入汇报的「待人工确认清单」，不得判为通过。
- 不得削弱/绕过：IPC 层验签门禁、`autoDownload = false`、§5.2 的 `httpExecutor` 约束（或其明文降级取舍）、fail closed、`lastSeenSequence` 的 HMAC 与「损坏即拒绝」、整 `data\` 一致性快照、伴生清单校验。

## 3. 阶段 0（必须先做，定案前不许写 A 关业务代码）

1. **现状复核**：重新读设计稿 §2 列出的每个文件，确认事实基线是否与 v3 一致，输出差异清单。不要盲信文档里的旧结论。
2. **任务 0 实测**（设计稿 §9 与 §11 共 9 项）。可自动化的必须真跑，把「命令 / stdout 摘要 / 退出码 / 产物路径 / 结论」写入 `docs/superpowers/specs/2026-11-06-task0-results.md`：
   - `publish: generic` + `--publish never` + `--config electron-builder.config.mjs` 是否稳定产出 `out/latest.yml` 与 `resources/app-update.yml`；
   - `setFeedURL` 是否接受 `file://` / 本地目录（写最小可运行验证脚本，**不下载真包**）；
   - 派生 `latest.yml` 中的**绝对 artifact URL** 能否覆盖 feed baseUrl；
   - 锁定的 `electron-updater >= 6.3.0` 中 `AppUpdater.httpExecutor` 是否可注入；
   - watchdog「等待主进程 PID 消失 → spawn → 回写 exitCode」用**假安装器脚本**验证；
   - `/S` 免 UAC、安装目录一致性（`HKCU\...\Uninstall\{appId}` 的 `InstallLocation` + `/D=`）、MOTW / SmartScreen：涉及真实 GUI 交互，用隔离环境验证；**无法自动化的明确标注「需人工确认」，禁止假设通过、禁止伪造结果**；
   - `.blockmap` 差分仅做可行性评估（本期不启用）。
3. **定案**：依据实测在 §5.2 的 **A / A′ / B** 中选一条，把定案结论、证据、被否决理由写回设计稿 §5.2，并删除另两条的实现描述（只保留决策记录）；若定案为兜底 B，同步修订 D5 与 §10 的依赖说明。**定案前不得开始 A 关编码。**

## 4. 并行策略（用 sub agent，但先定契约）

**并行前先由主 Agent 落地接口契约与文件归属表**，否则必然互相覆盖。写 `docs/superpowers/specs/2026-11-06-update-interfaces.md`：

- 全部 IPC 方法签名与事件 payload（照设计稿 §7.3）；
- `electron/main/update/` 各模块的导出签名；
- **文件归属表**：每个文件只允许一个 owner，禁止跨界写；共享文件（`package.json`、`main/index.ts`、`test/preload-api.test.ts` 等）由主 Agent 独占，sub agent 只提交「需要主 Agent 合并的改动清单」。

派活方式：每个 sub agent 一个 `.codex-handoff/<task-id>.md`，内容含目标、权威文档路径、归属文件白名单、契约路径、验收标准、禁止事项；消息里**只发文件路径**。任务结束前清理自己创建的这些文件，**绝不碰 `CURRENT.md`**。

| 组 | 阶段 | 内容 | 主要文件 |
| --- | --- | --- | --- |
| G0 | 0 | 现状复核 + 任务 0 实测 + 定案 | 主 Agent 独占，串行 |
| G1 | A | 发布侧：签名 / 发布 CLI、更新源目录模板、密钥工具、发布运维文档 | `scripts/*`、模板、`docs/operations/*` |
| G2 | A | 构建配置：`.mjs`、删 `electron-builder.yml`、`dist` 加 `--config`、esbuild `define` 注入 `__SPARKII_UPDATE_URL__`、产物断言 | `electron-builder.config.mjs`、`apps/desktop/package.json`、`test/release-config.test.ts` |
| G3 | A | 客户端更新核心：`update/` 全部模块 + 单测 | `electron/main/update/*`、`test/update/*` |
| G4 | A | 主进程装配与生命周期：`app.whenReady()` 前单实例锁、两个 `before-quit` 与 `isUpdating`、新增 `rt.pool.stop()`、三个 SQLite store `close()`、审批门 pending 显式过期、`settings.ts` 加 `update` 字段 | `main/index.ts`、`runtime.ts`、`document-parse-quit.ts`、`gate.ts`、`settings.ts` |
| G5 | A | UI / IPC / preload 三段式 + 状态栏小进度条 + 设置页关于 pane | `preload/api-types.ts`、`preload/api.ts`、`main/ipc.ts`、`src/shell/*`、`StatusBar.tsx`、断言测试 |
| G6 | B | 安装事务：`installer.nsh` 两项改动（`customInstall` 运行时版本标记 + 跳过解压；`customUnInstall` 仅删标记）、detached watchdog、`install-result.json` 单一写入 | `build/installer.nsh`、watchdog 脚本 |
| G7 | B | 整 `data\` 快照、哨兵、重启自检、旧版恢复介质、客户端审计哈希链、磁盘保留策略、断电注入测试 | `update/installer.ts` 相关、`test/update/install*` |
| G8 | B+收尾 | 文档契约同步：`docs/release-windows.md`、`docs/deploy.md`、2026-10-23 plan、`README.md`、`PRODUCT.md`、`TODO.md`、`branding.ts` | 文档 |

依赖：`G0 → (G1‖G2‖G3‖G4‖G5) → 集成收口 → (G6‖G7‖G8) → 集成收口 → 审核`。G3/G4/G5 靠接口契约解耦；G2 与 G5 都碰测试断言文件，由主 Agent 合并。**每个 sub agent 返回后，主 Agent 必须逐个核对实际文件改动**，不能只信汇报。

## 5. 验收（每关真跑，输出真实结果）

- 真跑并全绿：`pnpm install`、`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm --filter @sparkii/desktop dist`（或等价最小构建命令）。
- 新增单测至少覆盖：验签门禁（篡改 `release.json` / `.sig` / 包体 / 指针 / 同 sequence 换 nonce 一律拒绝）、`autoDownload === false`、derived state 扫描、sequence 单调与 HMAC 损坏 fail closed、下载进度与取消不丢包、0.2 / 0.3 二选一、关机顺序、watchdog 时序与退出码、断电注入恢复。
- 设计稿 §9 的 **A 关验收①–⑦、B 关验收①–⑥** 逐条给证据；无法自动化验证的，产出可复现脚本并标注「需人工确认」，**不得判为通过**。
- 产物断言：`out/latest.yml` 与 `resources/app-update.yml` 存在、`publish.url` 为占位常量、产物不含真实 IP、`win.verifyUpdateCodeSignature: false`、`electron-updater >= 6.3.0`。

## 6. 架构审核（用户明确要求，不可省略、不可自判通过）

实现全部完成后，启动**至少 3 个独立只读架构师 sub agent**：

1. **架构一致性审核**：逐条比对代码与 v3 设计稿（D1–D18、§5.2 定案、§6 协议、§7 模块、§9 验收），查漏项、静默偏离、过时结论残留。
2. **安全与发布链路审核**：信任链、验签字节 == updater 输入、IPC 门禁、HTTP MITM、`httpExecutor`、sequence / nonce / HMAC、发布单一指针竞态、安装目录 `/D`、`data\` 快照、私钥处理、fail closed 路径。
3. **最终复核**：前两轮修复后独立复核，确认无阻塞项、无新引入矛盾。

要求每个审核 Agent **实际读代码与测试**，不是只看文档；输出「通过 / 有条件通过 / 不通过」并给具体文件行号证据。

**循环规则**：只要有任何一轮不是「通过」，主 Agent 自行修复（必要时再并行），然后重新审核，直到三轮全部判「通过」。**不允许把「有条件通过」当作通过，不允许自己宣布通过**。每轮结论与修复记录落盘到 `docs/superpowers/specs/2026-11-06-implementation-review.md`。

## 7. 汇报（只在三轮审核全部通过后，一次性汇报）

必须包含：

- 三轮审核结论与逐条修复记录；
- 阶段 0 实测结论与 §5.2 定案（含证据，说明删掉了哪两条路径）；
- A / B 关验收逐条结果，**未自动验证项单列「待人工确认清单」**；
- 改动文件清单（按模块分组）、新增依赖；
- 测试 / 类型检查 / lint / 构建的真实输出摘要；
- 遗留风险、下一步，以及「首版不做自动更新」契约是否同步完成；
- 明确说明：未执行任何破坏性验证、未自动 commit。

## 8. 遇阻处理

- **不要中途停下来等用户确认**：在不违反 §2 安全边界的前提下，按设计稿最保守路径推进，临时决策记入最终汇报。
- 唯一允许停下来的是：实现必须破坏用户现有安装或真实 `data\`，或设计稿存在无法自行仲裁的自相矛盾——此时写清阻塞原因与建议选项，等用户裁决。
