# Shell 选择（Git Bash / PowerShell）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Windows 上 `bash` 工具走 `cmd.exe` 导致 `mkdir -p` 变成 `-p` 目录的问题；实现「Git Bash 优先、PowerShell 兜底」的会话级执行 shell 选择，并持久化 + 历史会话自动降级提示。

**Architecture:** 工具级切换。`bash` 工具固定由 Git Bash 执行，`powershell` 工具固定由 PowerShell 执行；会话鞍（`SessionSaddle.tools`）在构建时按「profile 工具 + Git Bash 探测 + 持久化选择」把 `bash` 替换为 `powershell`；选择结果持久化到 `chat_sessions.shell`。

**Spec:** [2026-08-31-shell-selection.md](../specs/2026-08-31-shell-selection.md)

## Global Constraints

- ESM + strict TS；新文件 import 相对路径带 `.js`；沿用分号风格。
- 单测不依赖真实 Electron 窗口 / 真实 LLM；`spawn` 用 `vi.mock('node:child_process')` 注入假实现；文件探测用临时目录。
- `bash` 与 `powershell` 的语义不混用：绝不把 POSIX 命令喂给 PowerShell。
- 选择逻辑对「无 `bash` 的 profile」零影响（不替换、不写 shell）。

---

### Task 1: Shell 探测模块

**Files:**
- Create: `apps/desktop/electron/main/shell-detect.ts`
- Test: `apps/desktop/test/shell-detect.test.ts`

**Interfaces:**
- `detectGitBashPath(): string | null` — 按 Pi 官方顺序探测并校验 `bash.exe`。
- `resolvePowerShell(): { exe: string; args: string[] }` — 优先 PowerShell 7（`pwsh`），否则回退 Windows PowerShell。
- `resolveShellChoice(profileTools: string[], persisted?: 'bash' | 'powershell' | null, bashPath?: string | null): { shell: 'bash' | 'powershell' | null; degraded: boolean; bashPath: string | null }` — 只在 `bash` 在列表时决策；`bashPath` 仅供测试注入，生产自动探测。

**Notes:** 探测结果可在模块内做一次惰性缓存（进程生命周期内 Git Bash 路径不变）。

### Task 2: 会话存储增加 shell 字段

**Files:**
- Update: `apps/desktop/electron/main/chat-session-store.ts`
- Test: `apps/desktop/test/chat-session-store.test.ts`

**Interfaces:**
- `ChatSessionRecord` 增加 `shell: 'bash' | 'powershell' | null`。
- `chat_sessions` 表新增 `shell TEXT` 列（迁移逻辑沿用 `thinking_level` 的 `ADD COLUMN` 模式）；`create/get/list/update` 全链路带上 `shell`。

### Task 3: 鞍构建时替换工具

**Files:**
- Update: `apps/desktop/electron/main/saddle.ts`
- Test: `apps/desktop/test/saddle.test.ts`

**Interfaces:**
- `buildProfileSaddle(..., shell?: 'bash' | 'powershell' | null)` 新增可选 `shell` 参数；为 `powershell` 时把 `tools` 中 `bash` 替换为 `powershell`，否则保持原样。

### Task 4: 注册 powershell 工具定义

**Files:**
- Update: `packages/agent-host/src/coding-tools.ts`
- Update: `packages/agent-host/src/tool-registry.ts`
- Test: `packages/agent-host/test/tool-registry.test.ts`

**Interfaces:**
- `createCodingToolDefinitions` 额外产出 `powershell` 定义（`createPowerShellToolDefinition`，`exec` 沿用 `propose` 模式、`toolName: 'powershell'`），返回 `[bash, powershell, edit, write]`。
- `resolveToolDefinitions` 识别 `powershell` 名字并映射到该定义。

### Task 5: 执行器按 shell 语义执行

**Files:**
- Update: `apps/desktop/electron/main/general-executor.ts`
- Test: `apps/desktop/test/general-executor.test.ts`

**Interfaces:**
- 注册 `powershell` handler。
- `bash` handler 用 `spawn(bashPath, ['-c', command], { cwd, windowsHide: true })`；`powershell` handler 用 `spawn(pwshOrWindowsPowerShell, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command', command], { cwd, windowsHide: true })`。
- 保留工作区缺失 / `markWorkspaceCreated` 的既有处理；`bash` 与 `powershell` 都提供只读分类器，遵循统一政策「只读免审批、写需审批」。

**Notes:** 移除 `bash` handler 中 `shell: true` 的 `cmd.exe` 语义；若探测不到 Git Bash 而仍执行 `bash`（不应发生），返回明确错误而非静默回退 cmd。

### Task 6: IPC 接线（持久化 + 打开历史会话降级提示）

**Files:**
- Update: `apps/desktop/electron/main/ipc.ts`

**Interfaces:**
- 新会话：在构建鞍前解析 shell，`chatSessions.create` 写入 `shell`。
- 打开历史会话：读回持久化 `shell`，调用 `resolveShellChoice`，将结果传入 `buildProfileSaddle`；`openChatSession` 返回值带出 `shell` 与 `degraded`。

### Task 7: Renderer 降级提示 + debug 档显示 shell

**Files:**
- Update: `apps/desktop/src/surfaces/GeneralChatSurface.tsx`
- Update: `apps/desktop/src/workbench/pi-timeline.ts`
- Update: `apps/desktop/src/workbench/chat-detail-level.ts`
- Update: `apps/desktop/src/workbench/LifecycleCard.tsx`
- Test: `apps/desktop/test/general-chat-surface.test.tsx`、`apps/desktop/test/pi-timeline.test.ts`、`apps/desktop/test/chat-detail-level.test.ts`

**Interfaces:**
- `openChatSession` 返回 `shell`/`degraded`；renderer 加载时在时间线**头部（`agent_start` 之前）**注入 `shell_selected` 条目，`degraded` 时额外显示非阻断横幅。
- `shell_selected` 为 debug 级条目：label「执行 Shell」，detail「Git Bash」/「PowerShell」/「PowerShell（降级）」。

### Task 8: 全量验证

**Commands:**
- 全量 vitest；`apps/desktop` 与 electron 两个 `tsc --noEmit`；esbuild 构建 main bundle（改了 electron/main 后必跑）。

**Acceptance:**
- Windows 无 Git Bash：新会话走 `powershell`，`mkdir -p` 类命令不再产生 `-p` 目录；有 Git Bash：走 `bash`。
- 历史会话记录 `bash` 但 Git Bash 被移除：打开时降级 `powershell` 且出现提示。
- 非 Windows（macOS/Linux）逻辑分支按规格覆盖（bash 常驻命中，不触发降级）。
