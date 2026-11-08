# 【续接提示词】Sparkii Desktop 自动升级 —— 从 A 关集成收口到三轮架构审核通过

你是本任务的**主 Agent（接手续做）**。前序主 Agent 已完成阶段 0 与 A 关 G1–G5 的编码，现在需要你从「A 关集成收口」开始继续，直到三轮独立架构审核全部判「通过」并产出一次性汇报。**在审核全部通过前不要向用户汇报、不要中途停下等确认。**

## 0. 工作区与权威源（已核实）
- 工作区：`C:\Users\YDJ\Desktop\SparkiiDesktop-Pi`（Windows / Git Bash）。根 `package.json` 是 pnpm workspace，Node ≥22；脚本 `pnpm test`(vitest)、`pnpm lint`、`pnpm typecheck`、`pnpm build`；桌面端 `apps/desktop` 的 `dist` 走 electron-builder NSIS。
- **唯一设计真相源**：`docs/superpowers/specs/2026-11-06-auto-update-design.md`（v3 定稿，顶部状态行已标注「架构审核通过·任务0实测已完成·§5.2定案A·已动工」）。先完整读一遍；本文 D1–D18、§0–§11、任务 0 / A 关 / B 关均指该文档。
- 先读 `AGENTS.md` 并遵守 sub agent **文件交接约定**：派活必须写文件（`.codex-handoff/<task-id>.md`），消息里只给文件路径。`.codex-handoff/` 已存在且含 G1–G5.md（已核实），你新建 G6–G8.md；**绝不碰 CURRENT.md**（本轮无此文件）。
- **以设计稿为准**；代码冲突时按设计稿实现并列入汇报。设计稿 §0.2 / §0.5 / §0.6 审核记录不得删除。
- **不自动 `git commit` / `git push`**。

## 1. 已完成状态（前序 Agent 交付，已逐文件核实）
- **阶段 0 全完成**：`docs/superpowers/specs/2026-11-06-task0-results.md` 含 9 项实测结论（方案 A 技术可行：setFeedURL 接受 file://、绝对 artifact URL 覆盖 feed baseUrl、httpExecutor 可注入、watchdog 假安装器 7 断言全过；真实安装位于 `D:\software\SparkiiPi` 且 HKCU InstallLocation 为空，已记为设计稿修正）。
- **§5.2 已定案为方案 A**（已核实行 240–270：定案 A + 决策记录，A′/B 仅留「被否决路径」记录，无实现描述）。**无需再核实**；仅建议在最终复核时复核一致性。
- **接口契约已写**：`docs/superpowers/specs/2026-11-06-update-interfaces.md`（IPC 签名、update/ 模块导出、文件归属表）。
- **A 关 G1–G5 模块已落地（15 个文件，已核实）**：`apps/desktop/electron/main/update/` 含 `types.ts / globals.d.ts / config.ts / audit.ts / decision.ts / scheduler.ts / dirs.ts / downloader.ts / installer.ts / local-artifacts.ts / state-store.ts / updater-adapter.ts / service.ts / verifier.ts`，以及 `electron/main/shutdown.ts`。支撑改动：`packages/agent-host/src/pi-runtime-pool.ts`(新增 `stopped` 状态与 `stop()`)、`packages/approval/src/gate.ts`(新增 `abortPendingForQuit`)、`electron/main/document-parse-quit.ts`、`electron/main/settings.ts`(新增 `update` 字段)、`electron/preload/api.ts`+`api-types.ts`、`electron/main/ipc.ts`(新增 `sparkii:getAppVersion`/`getUpdateState`/`checkForUpdate`/`downloadUpdate`/`installUpdate` 等 handler 及 `withUpdateService`/`hasUpdateService` 辅助)。
- **构建链路已落地（已核实）**：`apps/desktop/scripts/build-main.mjs`（esbuild 包装器，注入 `--define:__SPARKII_UPDATE_URL__`，缺省空串；已实跑验证 define 正确写入 `dist-electron/main/index.js`）；`apps/desktop/package.json` 的 `build:main` 已改调该脚本、`dist` 脚本已串接（`electron-builder --win nsis --publish never --config electron-builder.config.mjs`）；`apps/desktop/electron-builder.yml` **已删除**，仅保留 `electron-builder.config.mjs`（publish.url 为占位常量 `localhost/sparkii-updates`）；`electron-updater` 已锁定 `6.3.0`；`apps/desktop/test/release-config.test.ts` 新建、`test/preload-api.test.ts` 已加新 API 方法清单。

## 2. 待办（按序，已核实缺口）
### 2.1 完成 A 关集成收口（当前首要阻塞）
- **`apps/desktop/electron/main/index.ts` 尚未装配 `updateService`**（已核实：仅 line 65 有一个泛用 `before-quit`，无任何 updateService / shutdown 钩子引用）。需：
  1. 创建/获取 `updateService`（来自 `update/service.ts` 的 `createUpdateService` 或等价导出），在 app ready 后初始化；
  2. 接 `shutdown.ts`：单实例锁、`before-quit`×2（先 isUpdating 守卫 + 等 installer 回写 exitCode，再真正 quit）、`rt.pool.stop()`、三个 SQLite store `close()`、审批门 `abortPendingForQuit(reason)` 显式过期；
  3. 把 `updateService` 注入 IPC 层（`withUpdateService`/`hasUpdateService` 已在 ipc.ts 预留）。
- **真跑全量**：`pnpm install && pnpm typecheck && pnpm lint && pnpm test` 必须全绿；解决共享文件（package.json / ipc.ts / preload-api.test.ts / release-config.test.ts）任何合并冲突。

### 2.2 B 关并行实施 G6–G8（先写 `.codex-handoff/G6.md`~`G8.md`，每个 sub agent 返回后逐个核对实际改动）
- **G6 安装事务**：`apps/desktop/build/installer.nsh` 当前 `customInstall`/`customUnInstall` 是**空宏桩**（已核实仅 line 1/19 声明，无内容）——需补：customInstall 运行时版本标记（如 `WriteRegStr` 写 `Software\SparkiiPi\RuntimeVersion` 或等价哨兵，**跳过解压**用户 data）、customUnInstall 仅删该标记；detached watchdog（等待主进程 PID 消失 → spawn `/S` 安装器 → 回写 `install-result.json` 单一写入）；`install-result.json` 单一写入防竞态。
- **G7 整 `data\` 一致性快照 / 哨兵 / 重启自检 / 旧版恢复介质 / 客户端审计哈希链 / 磁盘保留策略 / 断电注入测试**（`update/installer.ts` line 54 已注明「B 关由 G7 接管」；watchdog 尚未实现）。
- **G8 文档契约同步**：`docs/release-windows.md` / `docs/deploy.md` / `docs/superpowers/plans/2026-10-23-windows-internal-release.md` / `README.md` / `PRODUCT.md` / `TODO.md` / `branding.ts`。

### 2.3 全量验收
- 真跑 `pnpm install/typecheck/lint/test` + `pnpm --filter @sparkii/desktop dist`（或等价最小构建）。
- 产物断言：out/latest.yml 与 resources/app-update.yml 存在、`publish.url` 为占位常量（不含真实 IP）、`win.verifyUpdateCodeSignature:false`、`electron-updater >= 6.3.0`。
- §9 A关①–⑦ / B关①–⑥ 逐条给证据；无法自动化的产出可复现脚本并标「需人工确认」，不得判通过。

### 2.4 多轮独立架构审核（≥3 个只读架构师 sub agent）
- ①架构一致性 ②安全与发布链路 ③最终复核。必须实际读代码与测试，给文件行号证据，输出通过/有条件通过/不通过。
- 任何一轮非「通过」则自行修复后重新审核，直到三轮全「通过」。每轮结论与修复记录落盘 `docs/superpowers/specs/2026-11-06-implementation-review.md`。
- **不允许把「有条件通过」当通过，不允许自己宣布通过。**

### 2.5 一次性汇报（仅三轮全通过后）
三轮审核结论与逐条修复、阶段0实测与定案、A/B关验收逐条+待人工确认清单、改动文件清单与新增依赖、真实测试输出摘要、遗留风险、首版不做自动更新契约同步、未执行破坏性验证/未 commit 声明。

## 3. 硬性安全边界（违反即失败）
- 不得删除/清空 Desktop、Downloads、Documents、Home、`%LOCALAPPDATA%\SparkiiDesktop\data`、`.workbuddy/` 或任何系统目录。
- **不得在当前开发机执行覆盖现有安装或改动真实 `data\` 的验证**：真实 NSIS `/S` 重装、`customUnInstall`、清空 `pending/` 一律禁止。B 关安装验证用隔离手段（临时 `SPARKII_DATA_DIR`、临时安装目录副本、假安装器脚本、可复现脚本供人工执行）。
- 不得把私钥、真实服务器 IP、token 写进仓库。
- **不得伪造任何测试或实测输出**。跑不动就如实记「未验证」列入待人工确认清单。
- 不得削弱/绕过：IPC 层验签门禁、`autoDownload=false`、§5.2 的 `httpExecutor` 约束、fail closed、`lastSeenSequence` 的 HMAC 与损坏即拒绝、整 `data\` 一致性快照、伴生清单校验。

## 4. 遇阻处理
- 不中途停下等确认；按设计稿最保守路径推进，临时决策记入最终汇报。
- 唯一允许停下：实现必须破坏用户现有安装或真实 `data\`，或设计稿存在无法自行仲裁的自相矛盾——此时写清阻塞原因与建议选项等用户裁决。

## 5. 关键文件路径速查
- 设计稿：`docs/superpowers/specs/2026-11-06-auto-update-design.md`
- 任务0实测：`docs/superpowers/specs/2026-11-06-task0-results.md`
- 接口契约：`docs/superpowers/specs/2026-11-06-update-interfaces.md`
- 审核记录：`docs/superpowers/specs/2026-11-06-implementation-review.md`（待创建）
- A 关模块：`apps/desktop/electron/main/update/*`、`electron/main/shutdown.ts`
- 构建：`apps/desktop/electron-builder.config.mjs`、`apps/desktop/scripts/build-main.mjs`、`apps/desktop/package.json`
- 交接目录：`.codex-handoff/`（已含 G1–G5.md；你新建 G6–G8.md；**绝不碰 CURRENT.md**）
- 本交接提示词存档：`docs/superpowers/specs/2026-11-06-handoff-prompt.md`
