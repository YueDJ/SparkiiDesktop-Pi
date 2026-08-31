# 会话执行 Shell 选择（Git Bash / PowerShell）设计规格

- 日期：2026-08-31
- 状态：设计决策已与用户逐项确认，本文档待用户审阅
- 范围：修正通用智能体在 Windows 上执行 `bash` 工具时走 `cmd.exe` 导致的 `-p` 目录问题，并确立「Git Bash 优先、PowerShell 兜底」的执行 shell 选择策略

## 1. 背景与问题

通用智能体的写命令执行链路是：

`Pi bash 工具 → 提议/审批 → ConnectorExecutor → general-executor.ts 的 bash handler → spawn(command, { shell: true })`

在 Windows 上，`spawn(..., { shell: true })` 实际启动的是 `cmd.exe`。而 Pi 的 `bash` 工具在语义上期望 POSIX/Git Bash，于是 `mkdir -p xxx` 被 `cmd.exe` 当成「目录名为 `-p`」处理，用户工作区里出现一个名为 `-p` 的文件夹。

## 2. 官方事实依据

仓库内安装的 Pi SDK（`@earendil-works/pi-coding-agent@0.84.x`）源码确认：

- `bash` 与 `powershell` 是**两个相互独立、平级的一等工具**，各自带系统提示（"Execute bash commands" / "Execute PowerShell commands"），Pi 不会自动在两者间降级切换。
- `bash` 工具在 Windows 上的解析顺序（`utils/shell.ts` 的 `getShellConfig`）：用户 `shellPath` → Git Bash 已知安装路径 → PATH 上的 `bash`。**没有 cmd.exe 兜底。**
- `powershell` 工具（`createPowerShellTool` / `createPowerShellToolDefinition`）为官方支持；`getPowerShellConfig()` 解析 Windows PowerShell，优先 PowerShell 7（`pwsh`），参数固定为 `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`。

结论：本次 bug 的根因是我们用 `shell: true`（cmd.exe）绕开了 Pi 官方 shell 解析；修正方向是让执行侧回归 Pi 官方支持的 shell 语义。

## 3. 已确认决策

| 主题 | 决策 |
| --- | --- |
| 切换粒度 | **工具级切换，不做后端偷换**：`bash` 工具只走 Git Bash，`powershell` 工具只走 PowerShell，绝不把 POSIX 命令喂给 PowerShell |
| 检测时机 | **会话初始化时（第一条 prompt 之前）检测一次**，结果锁定到该会话；不按安装时写死，也不每条 prompt 重复检测 |
| 选择规则 | profile 工具列表含 `bash` 时：检测到可用 Git Bash → `bash`；否则替换为 `powershell` |
| 持久化 | 把该会话最终选用的 `bash` / `powershell` 作为会话级字段持久化（`chat_sessions.shell`） |
| 历史会话 | 打开时读回持久化选择；若记录为 `bash` 但当前无 Git Bash → **自动降级到 PowerShell 并给出可见提示**（选项 A）；无持久化记录的老会话默认按 `bash` 处理，找不到 Git Bash 则降级并提示 |
| macOS / Linux | `/bin/bash` 随系统必带，永远命中 bash 分支、fallback 不触发；shell 选择层天然覆盖，客户端其他平台差异不在本规格范围 |

## 4. 关键机制

1. **检测**：新增 `shell-detect.ts`，按 Pi 官方顺序探测 Git Bash（已知路径 + PATH），并验证 `bash.exe` 真实可执行；同时提供 PowerShell 解析。
2. **选择与替换**：在构建会话鞍（`buildProfileSaddle`）时，依据「profile 工具 + 环境检测 + 持久化记录」决定是否把 `tools` 里的 `bash` 替换为 `powershell`。
3. **执行**：`general-executor.ts` 同时注册 `bash` 与 `powershell` 两个 handler；`bash` 用 `bash.exe -c <cmd>`，`powershell` 用 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <cmd>`。
4. **降级提示**：历史会话检测到「记录为 bash、环境无 Git Bash」时，向 renderer 发一次性事件，在会话顶部显示非阻断提示（不拦截发送）。
