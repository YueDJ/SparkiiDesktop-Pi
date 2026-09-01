# 离线捆绑 fd/rg 运行时实现计划（最终版）

> **For agentic workers:** 本文件记录已实施的方案与验证结果，后续执行时以当前工作区代码为准。

**Goal:** 将 Pi `find`/`grep` 所需二进制 `fd.exe`、`rg.exe` 捆绑进安装包，并统一放到离线运行时目录 `runtime/tools`，通过 PATH 注入让 Pi 找到它们。

**Architecture:** 扩展现有 Portable Git 分发链路；不引入通用依赖清单。安装器、首次启动兜底和 dev 脚本都把 fd/rg 放到 `<runtimeRoot>/tools`，Pi 子进程 PATH 前置该目录。

**Tech Stack:** Node.js、Electron main process、electron-builder、NSIS、Vitest。

**Spec:** `docs/superpowers/specs/2026-08-31-self-contained-runtime-distribution-design.md`

## 最终目标布局

```text
%LOCALAPPDATA%\SparkiiDesktop\
  data\                     # Pi 数据目录，不再放 fd/rg
  runtime\
    portable-git\
    tools\
      fd.exe
      rg.exe
```

## 关键改动

- `runtime-layout.ts`：新增 `resolveRuntimeToolsDir()` 与 `resolveSearchToolPaths()`，路径基于 `runtime/tools`。
- `runtime-provision.ts`：首次启动从 `resources/runtime/tools` 复制到 `<runtimeRoot>/tools`；诊断返回 fd/rg 状态。
- `runtime.ts`：Pi 子进程环境变量 `PATH` 前置 `<runtimeRoot>/tools`。
- `ensure-runtime.mjs`：下载并校验 fd 10.5.0、ripgrep 15.2.0，生成 `apps/desktop/runtime/tools/**` 与许可证，并复制到本地 `runtime/tools`。
- `electron-builder.yml`：打包 fd/rg 及许可证。
- `installer.nsh`：安装时复制到 `runtime/tools`，并清理旧版 `data/pi-agent/bin` 中的 fd/rg；卸载时清理运行时工具文件。

## 固定版本

| 工具 | 版本 | Windows x64 资产 | SHA256 |
| --- | --- | --- | --- |
| fd | 10.5.0 | `fd-v10.5.0-x86_64-pc-windows-msvc.zip` | `a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7` |
| ripgrep | 15.2.0 | `ripgrep-15.2.0-x86_64-pc-windows-msvc.zip` | `71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5` |

## 验证命令

```powershell
pnpm --filter @sparkii/desktop exec vitest run test/runtime-layout.test.ts test/runtime-provision.test.ts
pnpm --filter @sparkii/desktop test
pnpm --filter @sparkii/desktop typecheck
pnpm typecheck
```

## 验证结果

- 桌面端完整测试：61 个测试文件、291 个测试全部通过。
- 桌面端类型检查通过。
- 全仓类型检查通过。
- `ensure-runtime.mjs` 幂等运行通过。
