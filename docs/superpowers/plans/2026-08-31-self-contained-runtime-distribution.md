# 自带运行时「安装器解压」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Portable Git 的解压从「首次启动」挪到「NSIS 安装器」阶段，安装完成即运行时已就位，首次启动零解压、零等待、零弹窗；保留首次启动兜底。

**Architecture:** 新增 `build/installer.nsh`，用 electron-builder 的 `customInstall` 宏在文件安装完成后静默执行随包 SFX 解压到 `%LOCALAPPDATA%\SparkiiDesktop\runtime\portable-git`，`customUnInstall` 卸载时清理该目录。运行时代码 `ensureRuntime()` 不变，作为「安装器解压失败 / 用户误删 LOCALAPPDATA」时的幂等兜底。

**Tech Stack:** NSIS（经 electron-builder 集成）、electron-builder、TypeScript/Electron（不变）。

**Spec:** `docs/superpowers/specs/2026-08-31-self-contained-runtime-distribution-design.md`

## Global Constraints

- 运行时根固定为 `%LOCALAPPDATA%\SparkiiDesktop\runtime`，Portable Git 树在 `runtime\portable-git`（`bin\bash.exe`、`cmd\git.exe`）。
- 固定自带、不做系统 Git Bash 检测；bash 由代码绝对路径 spawn，git 随 bash 自带。
- 生产与 dev 共用同一路径解析，无 `app.isPackaged` 分支。
- 仅本轮打包 Portable Git；Node / uv / Python 不打包。
- SFX 解压为静默模式（`-o<dir> -y`），解压失败不阻断安装，交由首次启动 `ensureRuntime()` 兜底。
- 卸载清理只删 `runtime\portable-git`，绝不触碰 `%LOCALAPPDATA%\SparkiiDesktop\data\` 用户数据。

---

## File Structure

- Create: `apps/desktop/build/installer.nsh` — NSIS 自定义宏（`customInstall` 解压、`customUnInstall` 清理）。
- Modify: `apps/desktop/electron-builder.yml` — `nsis` 加 `include: build/installer.nsh`。
- 不变：`apps/desktop/electron/main/runtime-provision.ts`（`ensureRuntime()` 已是幂等兜底）、`runtime-layout.ts`。

## Tasks

### Task 1: NSIS 安装器脚本 installer.nsh

**Files:**
- Create: `apps/desktop/build/installer.nsh`

**Interfaces:**
- Produces: NSIS 宏 `customInstall`（安装后解压 SFX）与 `customUnInstall`（卸载清理）。electron-builder 在 `installSection.nsh` 第 81-82 行、`uninstaller.nsh` 第 156-157 行以 `!ifmacrodef` + `!insertmacro` 调用，宏名必须完全一致。

- [ ] **Step 1: 写 installer.nsh**

```nsh
!macro customInstall
  DetailPrint "Installing Portable Git runtime..."
  ExecWait '"$INSTDIR\resources\runtime\portable-git.7z.exe" -o"$LOCALAPPDATA\SparkiiDesktop\runtime\portable-git" -y' $0
  DetailPrint "Portable Git runtime extraction exit code: $0"
!macroend

!macro customUnInstall
  RMDir /r "$LOCALAPPDATA\SparkiiDesktop\runtime\portable-git"
!macroend
```

- [ ] **Step 2: 打包编译验证 NSIS 语法**（Task 2 完成后执行）：`pnpm dist` 若 NSIS 宏语法/引号错误会在生成安装器时报错。

- [ ] **Step 3: 提交**（与 Task 2 一并提交）。

### Task 2: electron-builder.yml 引入 installer.nsh

**Files:**
- Modify: `apps/desktop/electron-builder.yml`

**Interfaces:**
- Consumes: Task 1 的 `build/installer.nsh`。

- [ ] **Step 1: 在 `nsis` 块加 `include`**

```yaml
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  include: build/installer.nsh
```

- [ ] **Step 2: 提交 Task 1 + Task 2**

```bash
git add apps/desktop/build/installer.nsh apps/desktop/electron-builder.yml
git commit -m "feat(runtime): 安装器阶段解压 Portable Git 并卸载清理"
```

### Task 3: 打包与安装/卸载冒烟

- [ ] **Step 1: 打包**

Run: `pnpm --filter @sparkii/desktop dist`
Expected: 在 `apps/desktop/out/` 生成 NSIS 安装器（如 `Sparkii Setup 0.1.0.exe`），编译过程无 NSIS 语法错误。

- [ ] **Step 2: 静默安装**

Run: `& "apps/desktop/out/Sparkii Setup 0.1.0.exe" /S`（NSIS `/S` 静默安装）
Expected: 安装完成后 `%LOCALAPPDATA%\SparkiiDesktop\runtime\portable-git\bin\bash.exe` 与 `cmd\git.exe` 存在。

- [ ] **Step 3: 首次启动验证**

Run: 启动已安装应用，观察 `[runtime] verify` 日志 `ready: true` 且 `bashVersion` / `gitVersion` 非空。
Expected: 首次启动零解压（runtime 已由安装器解压），verify 通过。

- [ ] **Step 4: 静默卸载**

Run: 用卸载器 `/S` 静默卸载（`%LOCALAPPDATA%\Programs\Sparkii\Uninstall Sparkii.exe /S`，路径以实际安装目录为准）
Expected: 卸载后 `%LOCALAPPDATA%\SparkiiDesktop\runtime\portable-git` 已删除，但 `%LOCALAPPDATA%\SparkiiDesktop\data` 仍在。

- [ ] **Step 5: 兜底验证（可选）**

手动删除 `%LOCALAPPDATA%\SparkiiDesktop\runtime\portable-git`，再次启动应用。
Expected: `ensureRuntime()` 首次启动静默补解压，runtime 恢复，verify 通过。

- [ ] **Step 6: 提交**（如有 `.gitignore`/文档微调）。

## Self-Review

- Spec 覆盖：第 5 节「安装器解压 + 首次启动兜底 + 卸载清理」由 Task 1（解压/清理）+ Task 3（冒烟验证兜底）覆盖；第 6/7 节（bash-only、git 随 bash）已在此前提交完成，本计划不变。
- 占位符扫描：无 TBD/TODO；`build/installer.nsh` 内容完整可执行。
- 类型一致性：宏名 `customInstall` / `customUnInstall` 与 electron-builder 模板 `installSection.nsh:81-82`、`uninstaller.nsh:156-157` 严格一致。
