# 自带运行时 / 可分发打包（Self-contained Runtime）设计规格

- 日期：2026-08-31
- 状态：设计已与用户逐点确认，本文档待用户审阅
- 范围：把 Sparkii Desktop 做成可分发产品所需的自带运行时；**本轮仅 Portable Git（bash + git + coreutils）**
- 关联：本文档取代 `2026-08-31-self-contained-runtime-distribution.md`（初始决策记录）；并取代 `2026-08-31-shell-selection.md` 中「Git Bash 优先、PowerShell 兜底」的成品行为

## 1. 背景与目标

现状：Sparkii 的 `bash` 工具依赖用户机器上自装的 Git Bash；否则通用智能体无法执行 POSIX 命令。

目标：把运行时依赖打进安装包并解压到用户本地数据目录，用户**零安装、零配置、离线开箱即用**，agent 在用户电脑上能稳定运行。

## 2. 关键架构事实（已代码核实）

本设计建立在以下已验证事实上，这些事实直接决定组件范围与注入点：

1. **Pi 跑在 Electron 自带的 Node 里，不依赖独立 Node。** Pi SDK 被 esbuild 打进 `dist-electron/pi-runtime/utility-entry.js`，由 `utilityProcess.fork()` 或 `fork()` 启动，复用 Electron 的 Node。全仓库 runtime 代码没有任何 `spawn(node/npm/npx)`。
2. **Sparkii 自身没有任何 Python/uv 依赖。** 全仓库 runtime 代码没有 `python`/`uv`/`venv`/`VIRTUAL_ENV`/`UV_` 引用（唯一命中是 Markdown 语法高亮标签）。Python 只是「agent 帮用户跑 Python 项目」的可选能力。
3. **bash/edit/write 的执行已被 Sparkii 接管到主进程。** `coding-tools.ts` 用 `operations.exec` 覆盖 Pi 原生的 bash 执行，真实 `spawn(bash.exe, ['-c', cmd])` 发生在主进程 `general-executor.ts` 的 `runShell`。Pi 侧只发起审批。
4. **Pi 子进程内仍会直接 `spawn("git", ...)`。** 打包后的 Pi SDK 内 `runCommandCapture("git", ["rev-parse", ...])` 做会话 git 上下文，运行在 Pi 子进程、依赖 PATH 上的 `git.exe`。
5. **`powershell` 当前不是任何 profile 的一等工具。** `general` profile 只有 `bash`；`contract-review` 没有 shell 工具。整套 `resolvePowerShell`/`resolveShellChoice`/`buildProfileSaddle` 替换，存在的唯一目的就是「机器上没有 Git Bash 时降级到 PowerShell」。

结论：Sparkii 自己的运行时只需要 **Portable Git**（提供 bash + git + coreutils）。Node、uv、Python 都是「agent 帮用户跑项目」的可选语言运行时，不属于本轮「让 Sparkii 零安装跑起来」的范围。

## 3. 组件范围（本轮）

| 组件 | 本轮 | 说明 |
| --- | --- | --- |
| Portable Git for Windows | 打包 | 提供 `bash.exe` + `git.exe` + coreutils，满足 `bash` 工具与 git 上下文 |
| Node 运行时 | 不打包 | Pi 跑在 Electron Node；agent 的 `node/npm` 属可选语言运行时，后续单独评估 |
| uv + 预建 Python venv | 不打包 | Sparkii 无 Python 依赖；属可选语言运行时，后续单独评估 |

## 4. 运行时布局（用户本地数据目录）

运行时放在**用户本地数据目录**（LOCALAPPDATA），可写、可按用户隔离、可被后续独立升级替换。

```
%LOCALAPPDATA%\SparkiiDesktop\
  data\                     # 现有：sessions.db / pi-agent / keyring / ...
  runtime\                  # 新增：版本化、可替换的运行时根
    portable-git\           # 解压后的 Portable Git 树（bin/ usr/ cmd/ mingw64/ ...）
      bin\bash.exe
      cmd\git.exe
      usr\bin\ ...          # coreutils（ls/cat/grep/...）
      mingw64\bin\ ...
    installed.json          # 已解压组件的版本 + sha256
```

- 运行时根：`%LOCALAPPDATA%\SparkiiDesktop\runtime`（与现有 `data\` 同级，复用 `DATA_APP_DIR = 'SparkiiDesktop'`）。
- 固定可执行路径：
  - bash：`<runtimeRoot>\portable-git\bin\bash.exe`
  - git：`<runtimeRoot>\portable-git\cmd\git.exe`
- **单一固定路径，无分支**：生产与 dev 共用同一路径解析；不存在 `app.isPackaged` 分支，也不存在「探测系统 Git Bash」的兜底。

## 5. 打包与首次解压

- 安装包通过 electron-builder `extraResources` 携带 Portable Git 官方自解压包（压缩后约 50MB）到 `resources/runtime/`。
- 随包附带 `runtime-manifest.json`，形如 `{ "portable-git": { "version": "2.47.1", "sha256": "<hex>" } }`；具体版本在构建期锁定并随主程序同一发布节奏。
- 首次启动（`app.whenReady` 内）校验 `installed.json` 与随包 manifest 的版本/sha256：
  - 缺失或不一致 → 解压到 `<runtimeRoot>\portable-git`；解压后确认 `<runtimeRoot>\portable-git\bin\bash.exe` 存在（若官方 SFX 自带一层目录名，则对齐到该布局），并写回 `installed.json`。
  - 一致 → 跳过。
- 解压未完成时 `bash` 不可用：`bash` handler 等待解压完成或返回清晰错误，**不做 PowerShell 降级**。
- dev 环境：由 `pnpm ensure:runtime`（或 `start.cmd` 钩子）下载并解压到同一 `%LOCALAPPDATA%\SparkiiDesktop\runtime\portable-git`，与生产共享路径；运行时代码不感知打包/未打包差异。

## 6. shell 简化（取代 shell-selection 的兜底）

- 生产固定使用自带 bash；shell 选择退化为常量，不再「bash/powershell 二选一」。
- 删除 `detectGitBashPath` / `resolvePowerShell` / `resolveShellChoice`、`saddle.ts` 的 bash→powershell 替换、会话级 `shell` 持久化。
- `bash` handler 直接使用固定 `bash.exe` 路径（第 4 节）。
- 一并移除 powershell handler 与相关只读/风险判定代码（`isReadOnlyPowerShellCommand` / `riskOfPowerShellCommand` / `isReadOnlyShellCommand` / `riskOfShellCommand` 的 powershell 分支），因为降级链已不存在。
- 若后续希望保留一个**独立** PowerShell 工具（非 bash 的兜底），作为可选工具另行加回，不在本轮范围。

## 7. 环境注入（暴露给 agent）

- 主进程启动时一次性把以下目录按序 prepend 到 PATH：`portable-git\cmd`、`portable-git\bin`、`portable-git\usr\bin`、`portable-git\mingw64\bin`。其中 `cmd`（`git.exe`）是 Pi 子进程内直接 `spawn("git")` 所必需的。
- Pi 子进程 env 为 `{ ...process.env, ...env }`，继承主进程 PATH，故**主进程注入一次即覆盖两处**：主进程的 bash spawn 与 Pi 子进程内的 git 调用。
- bash 内部的 coreutils/git 由 Portable Git 自带的 `/etc/profile` 组织 PATH（与现有系统 Git Bash 行为一致），无需在 Windows PATH 里为每个 coreutils 单列。
- 验收标准（冒烟）：`bash -c "git --version && ls && grep --version"` 在解压后的运行时上通过。

## 8. 更新策略

- 运行时与主程序同版本发布：每次发版重钉 `runtime-manifest.json` 中的版本 + sha256。
- 启动校验时，若 manifest 版本 > `installed.json` 版本 → 重新解压并写回 `installed.json`。
- 独立运行时自更新通道（组件级热补丁）留待后续；第 4 节的可写目录布局已为其预留，无需改架构。

## 9. 许可合规

- Portable Git 原样分发（不做手拼裁剪）：完整携带其 `licenses/` 目录 + `THIRD-PARTY-NOTICES` + 源码提供承诺（指向精确的 Git-for-Windows / MSYS2 版本）。
- bash/git 以独立进程被 Electron 聚合调用，属「mere aggregation」，不使 Sparkii 传染为 GPL。
- 公开发布前需过法务确认，属发布门禁而非本轮工程范围。

## 10. 非目标 / 后续

- macOS / Linux：本轮不做。`RuntimeLayout` 抽象预留平台参数化（macOS/Linux 用系统 `/bin/bash`，无需 Portable Git）。
- Node / uv / Python：作为可选语言运行时，后续单独评估是否及如何打包。
- Portable Git 体积裁剪：先用完整版并实测体积，确有需要再评估「bash+git+coreutils 子集」。
