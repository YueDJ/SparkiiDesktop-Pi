# 自带运行时 / 可分发打包（Self-contained Runtime）设计规格

- 日期：2026-08-31
- 状态：方向已确认，本文档为决策记录，详细设计待后续讨论
- 范围：把 Sparkii Desktop 做成可分发产品所需的自带运行时（Git / Node / uv + Python venv）

## 1. 背景与目标

现状：Sparkii 依赖用户机器上的环境——`bash` 工具需要用户自装 Git Bash、Pi 运行依赖 Node、Python 任务依赖 `uv`/Python。

目标：把运行时依赖打进安装包，用户零安装、零配置开箱即用，agent 在用户电脑上能稳定运行，不需要用户额外安装软件。

## 2. 参考模型（Hermes）

成熟 agent 产品 Hermes 的本地数据目录里打包了：

- `@earendil-works/pi-coding-agent@0.84.4`（Pi coding agent，与 Sparkii 同版本）
- Node.js 运行时（`node.exe` + `npm`/`pnpm`/`npx`）
- `uv`（Python 工具链管理器）+ 一个预建的 Python `venv`
- Portable Git for Windows（`bash.exe` / `git.exe` / `mingw64` / `usr`）

> 验证依据：`%LOCALAPPDATA%\hermes\node\node_modules\@earendil-works\pi-coding-agent` 与 `pi` CLI shim 均指向 Pi 的 `dist/bundle/cli.js`；Hermes 源码 `agent/prompt_builder.py`、`hermes_cli/main.py` 引用 `earendil-works/pi#7681`、`#7493` 约定。

## 3. 需要打包的组件

| 组件 | 用途 |
| --- | --- |
| Portable Git for Windows | 提供 bash + git + coreutils，满足 `bash` 工具 |
| Node.js 运行时 | Pi 是 Node 包，保证运行 Pi 的 Node 稳定存在 |
| `uv` + 预建 Python venv | 满足 agent 运行 Python 任务，不依赖系统 Python |

## 4. 对 shell 选择的关键简化

- 一旦自带 Git Bash，shell 选择简化为**固定使用自带的 Git Bash**，不再需要在 bash 与 powershell 之间二选一。
- 现有的 shell 检测 / 降级机制（`shell-detect.ts` + 会话级 `shell` 持久化）保留为**兜底**：过渡期、以及自带 Git 缺失或损坏时仍可工作，但不再是主路径。

## 5. 待详细讨论（后续）

- 安装方式与体积控制（完整 Portable Git 约 50MB+，是否裁剪）
- 许可合规（Portable Git 的 GPL / MSYS2 组件）
- 更新策略（运行时与主程序如何升级、是否独立版本）
- 如何把 Pi 的 `shellPath` 指向自带 bash（或沿用 `detectGitBashPath` 显式指向）
- 如何把 `uv` / venv 暴露给 agent（PATH、环境变量、工具链入口）
- Node 版本锁定与 Pi 的兼容性
- 是否本轮同步覆盖 macOS / Linux
