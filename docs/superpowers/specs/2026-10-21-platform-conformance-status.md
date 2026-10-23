# 平台安全适配与一致性状态

- 日期：2026-10-21
- 状态：Windows 原生原型部分通过；macOS/Linux 契约为实现基础

## 平台无关层

以下模块不包含 OS 条件：

- `CapabilityKind`
- `SecurityAction`
- `TaskGrant`
- `PolicyEngine`
- `TaskGrantRegistry`
- `WorkspaceAdmission`
- `CapabilityGateway`

平台通过实现同一 `WorkspacePathProbe`、`WorkspaceSandboxAdapter`、
`PlatformSecurityReport` 和 `PlatformAdapterRegistry` 接入。

## Windows

已验证：

- AppContainer 每次任务唯一 SID。
- Workspace 与任务 scratch ACL 隔离。
- Workspace 外写入、用户秘密文件读取、TCP、localhost 和命名管道阻断。
- Job Object 进程树终止。
- 信任锚隔离与硬链接 fail closed。

限制：

- Git Bash/MSYS2 在 Windows 10 AppContainer 中返回
  `0xC0000002 (STATUS_NOT_IMPLEMENTED)`。
- Windows 报告为 `partial`；Standard `process.exec` 保持 `DENY`。

## macOS

当前只交付适配契约和 fail-closed 一致性测试。尚未实现的原生要求：

- Seatbelt profile；
- Apple Events、辅助功能、XPC、Mach 服务与 Unix socket 隔离；
- arm64/x86_64 能力探测。

因此不得声称 macOS 生产适配完成。

## Debian/Ubuntu

当前只交付适配契约和 fail-closed 一致性测试。尚未实现的原生要求：

- Bubblewrap/Landlock/seccomp 组合；
- user namespace、network namespace 与受控代理；
- D-Bus、Unix socket、设备和 `/proc` 限制。

因此不得声称 Debian/Ubuntu 生产适配完成。

## 一致性门禁

`packages/approval/test/platform-conformance.test.ts` 验证：

- 平台通过 Registry 选择；
- 未知或未安装平台失败关闭；
- macOS/Linux 未实现适配器不会放宽 Policy；
- 所有必需隔离能力均不可用时输出相同的 `deny`。
