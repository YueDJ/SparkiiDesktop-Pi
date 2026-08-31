# Self-contained Runtime 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Sparkii Desktop 打包自带的 Portable Git（bash + git + coreutils），并简化 shell 逻辑为「固定使用自带 bash、删除 powershell 检测/降级」。

**Architecture:** 新增 `runtime-layout.ts` 解析固定运行时路径（`%LOCALAPPDATA%\SparkiiDesktop\runtime\portable-git`），`ensureRuntime()` 在首次启动解压随包的 Portable Git 自解压包；`general-executor` 直接使用该绝对路径跑 bash，git 随 bash 自带；删除 `shell-detect.ts`、powershell handler、会话 `shell` 持久化及整套降级。

**Tech Stack:** TypeScript, Electron main process, electron-builder, vitest。

**Spec:** `docs/superpowers/specs/2026-08-31-self-contained-runtime-distribution-design.md`

## Global Constraints

- 运行时根固定为 `%LOCALAPPDATA%\SparkiiDesktop\runtime`，Portable Git 树在 `runtime\portable-git`（`bin\bash.exe`、`cmd\git.exe`）。
- bash 由 Sparkii 自己的代码用绝对路径 spawn；git 随 bash 自带，本轮不做任何单独注入。
- 生产与 dev 共用同一路径解析，无 `app.isPackaged` 分支、无系统 Git Bash 探测。
- 删除 powershell：`detectGitBashPath` / `resolvePowerShell` / `resolveShellChoice` / saddle 替换 / 会话 `shell` 字段 / general-executor 的 powershell handler 及其只读与风险判定。
- 仅本轮打包 Portable Git；Node / uv / Python 不打包。

---

## File Structure

- Create: `apps/desktop/electron/main/runtime-layout.ts` — 纯路径解析 + 解压判断（可单测）。
- Create: `apps/desktop/electron/main/runtime-provision.ts` — 首次解压（spawn SFX）。
- Create: `apps/desktop/scripts/ensure-runtime.mjs` — dev 下载/解压脚本。
- Create: `apps/desktop/test/runtime-layout.test.ts`。
- Modify: `apps/desktop/electron/main/general-executor.ts` — bash-only，用绝对路径。
- Modify: `apps/desktop/electron/main/index.ts` — 启动时 `ensureRuntime()`。
- Modify: `apps/desktop/electron/main/saddle.ts`、`ipc.ts`、`chat-session-store.ts`、`workflow.ts`、`paths.ts`。
- Modify: `apps/desktop/electron/preload/api.ts`、`api-types.ts`。
- Modify: `apps/desktop/src/workbench/pi-timeline.ts`、`apps/desktop/src/surfaces/GeneralChatSurface.tsx`。
- Modify: `packages/agent-host/src/coding-tools.ts`、`tool-registry.ts`。
- Modify: `apps/desktop/electron-builder.yml`、`apps/desktop/package.json`。
- Delete: `apps/desktop/electron/main/shell-detect.ts`、`apps/desktop/test/shell-detect.test.ts`。
- Modify tests: `general-executor.test.ts`、`saddle.test.ts`、`chat-session-store.test.ts`、`pi-timeline.test.ts`、`general-chat-surface.test.tsx`、`coding-tools.test.ts`、`tool-registry.test.ts`。

## Tasks

### Task 1: runtime-layout 纯路径解析

**Files:** Create `apps/desktop/electron/main/runtime-layout.ts`, `apps/desktop/test/runtime-layout.test.ts`

**Interfaces:**
- Produces: `resolveRuntimeRoot(env)`, `resolveBashPath(env)`, `resolveGitCmdDir(env)`, `needsProvision(env)`（后面被 provision、general-executor 使用）。

- [ ] **Step 1: 写失败测试** `runtime-layout.test.ts`：`resolveRuntimeRoot` 返回 `join(LOCALAPPDATA,'SparkiiDesktop','runtime')`；`SPARKII_RUNTIME_ROOT` 覆盖生效；`resolveBashPath` = `root/portable-git/bin/bash.exe`；`needsProvision` 在缺 bash.exe 或 git.exe 时 true、齐备时 false。
- [ ] **Step 2: 跑测试确认失败**（模块不存在）。
- [ ] **Step 3: 实现** `runtime-layout.ts`（常量 `APP_DIR='SparkiiDesktop'`、`PORTABLE_GIT='portable-git'`，纯函数，用 `existsSync`）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**。

### Task 2: ensureRuntime 首次解压

**Files:** Create `apps/desktop/electron/main/runtime-provision.ts`；Modify `apps/desktop/electron/main/index.ts`

**Interfaces:**
- Consumes: `resolveRuntimeRoot`, `needsProvision` from Task 1。
- Produces: `ensureRuntime(opts)`：若 `needsProvision` 且有归档则 spawn SFX 解压；归档路径 `opts.archivePath`。

- [ ] **Step 1: 写失败测试**（mock `node:child_process.spawn`）：归档存在 + 缺 bash → 调用 spawn 且参数含 `-o` 与 portable-git 目录；已就绪 → 不 spawn。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现** `runtime-provision.ts`。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 在 `index.ts` 的 `app.whenReady` 里 `await ensureRuntime()`（best-effort，失败仅记录日志，不阻断启动）。
- [ ] **Step 6: 提交**。

### Task 3: general-executor 改为 bash-only

**Files:** Modify `apps/desktop/electron/main/general-executor.ts`, `apps/desktop/test/general-executor.test.ts`

**Interfaces:**
- Consumes: `resolveBashPath` from Task 1。
- Produces: 仅导出 `isReadOnlyBashCommand`、`riskOfCommand`、`registerGeneralExecutor`（只注册 bash/edit/write）。

- [ ] **Step 1: 改测试**：删除 powershell 相关断言与 `detectGitBashPath/resolvePowerShell` mock，改为 mock `runtime-layout.js` 的 `resolveBashPath` 返回固定路径，断言 bash 用绝对路径 spawn。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**：移除 powershell handler 与只读/风险函数，`runShell` 用 `resolveBashPath()`。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**。

### Task 4: 删除 shell-detect 与降级/持久化

**Files:** Delete `shell-detect.ts`, `shell-detect.test.ts`；Modify `saddle.ts`, `ipc.ts`, `chat-session-store.ts`, `workflow.ts`, `preload/api.ts`, `api-types.ts`, `pi-timeline.ts`, `GeneralChatSurface.tsx`, `paths.ts`, 相关测试

- [ ] **Step 1: 删 `shell-detect.ts`** 及 `resolveShellChoice` 的所有 import/调用。
- [ ] **Step 2: `saddle.ts`** 去掉 `shell` 参数与 bash→powershell 替换。
- [ ] **Step 3: `chat-session-store.ts`** 去掉 `shell` 字段（interface/建表/insert/update/select）。
- [ ] **Step 4: `ipc.ts`** 去掉 `resolveShellChoice`、`shell`/`degraded` 返回值与 `buildProfileSaddle` 的 shell 实参。
- [ ] **Step 5: `preload/api.ts` + `api-types.ts`** 去掉 `openChatSession` 的 `shell`/`degraded`。
- [ ] **Step 6: `pi-timeline.ts`** 去掉 `shellSelectedEntry` 与 `shell_selected` 事件类型/label/detail/status。
- [ ] **Step 7: `GeneralChatSurface.tsx`** 去掉 `shellNotice` 与 shell 相关渲染。
- [ ] **Step 8: `workflow.ts`** 改 import 为 `isReadOnlyBashCommand`/`riskOfCommand`，去掉 powershell 分支。
- [ ] **Step 9: 更新/删除相关测试**。
- [ ] **Step 10: 提交**。

### Task 5: 移除 agent-host 的 powershell 工具定义

**Files:** Modify `packages/agent-host/src/coding-tools.ts`, `tool-registry.ts`, `coding-tools.test.ts`, `tool-registry.test.ts`

- [ ] **Step 1: `coding-tools.ts`** 去掉 `createPowerShellToolDefinition` 与 powershell def，`shellExec` 去掉 toolName 参数并固定 `bash`，返回 `[bash, edit, write]`。
- [ ] **Step 2: `tool-registry.ts`** 去掉 `name === "powershell"` 分支。
- [ ] **Step 3: 更新测试**。
- [ ] **Step 4: 提交**。

### Task 6: 构建配置与 dev 脚本

**Files:** Modify `apps/desktop/electron-builder.yml`, `apps/desktop/package.json`；Create `apps/desktop/scripts/ensure-runtime.mjs`

- [ ] **Step 1: `electron-builder.yml`** 加 `extraResources` 携带 Portable Git 自解压包到 `resources/runtime`。
- [ ] **Step 2: `scripts/ensure-runtime.mjs`** 下载并解压 Portable Git 到 `%LOCALAPPDATA%\SparkiiDesktop\runtime\portable-git`。
- [ ] **Step 3: `package.json`** 加 `ensure:runtime` script。
- [ ] **Step 4: 提交**。

### Task 7: 全量验证

- [ ] **Step 1:** `pnpm test`（vitest）全绿。
- [ ] **Step 2:** `pnpm typecheck` 全绿。
- [ ] **Step 3:** 复查无残留 `shell-detect`/`resolveShellChoice`/`resolvePowerShell`/`detectGitBashPath`/`shell`/`powershell` 引用（不含文档）。
- [ ] **Step 4: 提交**。
