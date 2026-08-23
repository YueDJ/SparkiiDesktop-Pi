# 桌面端 Pi Runtime 受管嵌入设计（消除外部 Pi 进程与可见终端）

- 日期：2026-08-23
- 状态：spec，待用户评审
- 主题：在不牺牲进程隔离和合规演进能力的前提下，把 Pi 从“外部安装的 CLI 子进程”改为“随 Sparkii Desktop 内置、由 Electron 托管的无窗口 Runtime 子进程”

## 1. 背景

当前 Sparkii Desktop 在运行时通过 `PiProcessSupervisor` 启动外部 `pi --mode rpc` 可执行文件。实际体验产生两个问题：

1. 用户会看到一个空白的 terminal/控制台窗口，产品显得不 polish。
2. Sparkii 和 Pi 像两个分离的软件：用户机器必须预先安装 `pi`（或至少能在 PATH、PNPM/npm 全局目录中找到 `pi.cmd`），否则应用无法工作。

本设计的目标是在保留“Agent 与 UI 进程隔离”这一合规地基的前提下，解决这两个体验问题。

## 2. 目标与非目标

### 目标

- Pi 随 Sparkii 安装包内置，用户无需单独安装 `pi`、pnpm 或 Node。
- 启动和运行过程中不出现可见 terminal/控制台窗口。
- Pi 仍是独立 OS 进程，Main 与 Pi Runtime 之间的故障边界不变。
- 现有 Renderer、IPC、审批门、审计、模型路由、workflow 接口尽量保持兼容。
- 保留未来对 Pi Runtime 做 restricted token、容器、微 VM 等硬隔离的接入点。

### 非目标

- 不把 Pi SDK 直接 `import` 进 Electron Main 主进程同进程运行。
- 不引入 Rust/Tauri，不改产品技术栈。
- 不实现 OS 级硬沙箱；本设计只保留该演进路径。
- 不解决本地模型运行时（Ollama/vLLM）的打包问题；模型层仍可独立部署。

## 3. 决策

采用“受管隐藏 Pi Runtime 子进程”方案：

- Pi 由 Electron 主进程 fork 出一个无窗口 Node 子进程。
- 子进程入口是我们自己的 `pi-runtime` 入口文件，在该文件内使用 `@earendil-works/pi-coding-agent` SDK 创建 `AgentSession`。
- Main 与 Pi Runtime 通过结构化消息通信，不再依赖外部 `pi --mode rpc` 的 stdin/stdout 协议。
- Pi SDK 及其依赖在构建阶段被打包进 `dist-electron`，最终只交付一个 Sparkii 安装包。

首选实现载体是 Electron `utilityProcess.fork()`；若 spike 发现 Pi SDK 与 utilityProcess 的 Node 环境不兼容，则回退到 `child_process.fork()` + `windowsHide: true`。两者都满足“无窗口、独立进程、随应用打包”。

## 4. 现状与问题根因

问题根因在以下位置：

- `apps/desktop/electron/main/runtime.ts` 的 `resolvePiBin()` 从 `SPARKII_PI_BIN`、`PI_BIN`、`PNPM_HOME`、`LOCALAPPDATA\pnpm`、`APPDATA\npm` 中寻找 `pi.cmd`。
- `packages/agent-host/src/process.ts` 对 `.cmd` 使用 `spawn('cmd.exe', ['/d', '/s', '/c', ...])`，并将 stderr 设为 `inherit`，这是 Windows 下弹出控制台窗口的直接原因。
- `apps/desktop/electron-builder.yml` 只打包 `dist`、`dist-electron`、`profiles`，没有打包 Pi 运行时。
- `packages/agent-host/src/control-server.ts` 为了让外部 Pi 进程发送写提议，额外启动了一个 `127.0.0.1` 本地 HTTP 服务。

## 5. 目标架构

```text
┌──────────────────────────────────────────────────────────────┐
│ Renderer（React，沙箱化）                                     │
│  业务页面 · 对话工作台 · 审批弹窗 · 审计视图                     │
└───────────────▲──────────────────────────────────────────────┘
                │ Electron IPC（typed，contextBridge）
┌───────────────┴──────────────────────────────────────────────┐
│ Electron Main（控制层，Node + TypeScript）                     │
│  配置加载 · 会话 · 模型路由 · 审批门 · 审计 · RBAC ·           │
│  PiRuntimeSupervisor（受管子进程生命周期）                     │
└───────────────▲──────────────────────────────────────────────┘
                │ 结构化消息（utilityProcess MessagePort 或 fork IPC）
┌───────────────┴──────────────────────────────────────────────┐
│ Pi Runtime 子进程（Node，无窗口，内置）                        │
│  pi-runtime 入口 · createAgentSession · Agent loop · 工具注入 ·│
│  会话树 · 流式事件 · 写操作提议                                 │
└──────────────────────────────────────────────────────────────┘
```

与旧架构的关键差异：

- 不再有外部 `pi` 可执行文件。
- 不再有可见控制台窗口。
- 不再有 `127.0.0.1` 审批控制 HTTP 服务。
- Pi 子进程由 Electron 生命周期托管，可随应用退出、重启和恢复。

## 6. 进程模型

### 6.1 首选：Electron utilityProcess

- Main 使用 `utilityProcess.fork(piRuntimeEntryPath)` 启动子进程。
- 子进程通过 `process.parentPort` 收发结构化消息。
- 不创建窗口，天然无终端。
- 生命周期由 Electron 提供，`app.quit` 时按需要统一清理。

### 6.2 回退：child_process.fork + windowsHide

如果 Pi SDK 依赖 Node 特性与 utilityProcess 的运行时不完全一致，则使用：

- `fork(piRuntimeEntryPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true })`。
- 通信通过 `process.send` / `message`，或复用 stdio JSONL 作为降级 transport。
- Main 仍需显式管理子进程退出和重启。

最终选择以第 13 节 spike 的结果为准；两个入口共享同一套 `createPiRuntime()` 业务逻辑。

## 7. Pi Runtime 入口职责

建议新增以下模块：

- `packages/agent-host/src/pi-runtime.ts`
  - 导出 `createPiRuntime(transport)`。
  - 使用 Pi SDK 创建 `AgentSession`。
  - 订阅 Agent 事件并转换为现有 `NormalizedEvent`。
  - 将现有 `RpcCommand` 映射为 SDK 调用。
  - 处理 `prompt`、`steer`、`follow_up`、`abort`、`new_session`、`get_state`、`get_messages`、`set_model`、`set_auto_retry`、`set_auto_compaction`、`switch_session`。

- `packages/agent-host/src/pi-sdk-runtime.ts`
  - 导出 `createPiSdkSessionHost(options)`。
  - 作为唯一直接 import `@earendil-works/pi-coding-agent` 的产品模块。
  - 负责 `ModelRuntime`、`createAgentSessionRuntime`、`defineTool`、工具注入和 `PiRuntimeSessionHost` 适配。
  - Desktop 入口不 import Pi SDK，只调用本模块。

- `apps/desktop/electron/pi-runtime/utility-entry.ts`
  - 创建 utilityProcess `parentPort` transport，调用 `createPiSdkSessionHost` 和 `createPiRuntime`，不含 Pi SDK 细节。

- `apps/desktop/electron/pi-runtime/fork-entry.ts`
  - 创建 fork IPC transport，复用同一套高层启动逻辑；仅在回退路径启用。

这两个入口只是 Electron transport bootstrap，不应包含 Pi SDK 或 Agent 业务逻辑。

## 8. 通信协议与 transport 抽象

保留现有 `RpcCommand`、`RpcResponse`、`NormalizedEvent` 语义，把传输层抽象出来：

```ts
export interface PiRuntimeTransport {
  send(command: RpcCommand): Promise<RpcResponse>;
  onEvent(callback: (event: NormalizedEvent) => void): () => void;
  close(): void;
}
```

- 现有 `PiRpcClient` 可作为 stdio transport 保留，供测试和回退使用。
- 新增 utilityProcess MessagePort transport 和 fork IPC transport。
- `PiRuntimeSupervisor.start()` 返回一个统一的 `PiRuntimeClient`，对上层暴露与现在相近的 `send()`、`onEvent()`、`close()`。

协议边界保持不变的好处是：`workflow.ts`、`recovery.ts`、`ipc.ts` 中除 supervisor 类型外，调用方式基本不破坏。

### 8.1 消息信封

Pi Runtime 与 Main 之间的所有消息使用同一种结构化信封，避免把命令、事件、提议混在一条无类型通道里：

```ts
type PiRuntimeEnvelope =
  | { direction: 'main-to-runtime'; id: string; command: RpcCommand }
  | { direction: 'runtime-to-main'; id: string; response: RpcResponse }
  | { direction: 'runtime-to-main'; event: NormalizedEvent }
  | { direction: 'runtime-to-main'; proposal: ProposalRequest & { requestId: string } }
  | { direction: 'main-to-runtime'; proposalDecision: ProposalDecision };
```

- `command` / `response` 对应现有 `RpcCommand` / `RpcResponse` 语义。
- `proposal` 由 Pi Runtime 发起，Main 必须用同一 `requestId` 回 `proposalDecision`。
- 所有跨进程消息必须是可结构化克隆的数据，不传函数、流或不可序列化对象。

### 8.2 Supervisor 接口

`PiRuntimeSupervisor` 至少暴露：

```ts
interface PiRuntimeSupervisor {
  start(): Promise<PiRuntimeClient>;
  stop(): Promise<void>;
  onExit(cb: (code: number | null) => void): () => void;
  onProposal(cb: (req: ProposalRequest & { requestId: string }) => Promise<ProposalDecision>): void;
}
```

上层 `workflow.ts` / `ipc.ts` 继续只依赖 `PiRuntimeClient` 的 `send()` / `onEvent()` / `close()`；proposal 回路由 Main 在装配时注册。

## 9. 审批与写提议流

在新的进程模型下，Pi Runtime 可以直接把写操作提议发给 Main，不再需要本地 HTTP control server：

1. Agent 决定执行写/高风险操作。
2. Pi Runtime 通过 transport 发送 `{ type: 'propose', ... }` 给 Main。
3. Main 调 `ApprovalGate.submit()`，向 Renderer 弹审批 UI。
4. 用户批准/拒绝后，Main 更新权威审批状态；批准则由 `ConnectorExecutor` 执行。
5. Main 将 `ProposalDecision` 通过 transport 返回给 Pi Runtime。

要求：

- `packages/agent-host/src/control-server.ts` 及 `SPARKII_CONTROL_URL` / `SPARKII_CONTROL_TOKEN` 不再参与主路径。
- 写操作仍在 Pi Runtime 中没有可执行写原语，只保留“提议”语义。
- 批准决定和参数冻结仍由 Main 侧确定性代码维护。

### 9.1 工具注入

Pi Runtime 启动时，把当前 `documentConnector`、`knowledgeConnector`、`reportConnector` 的工具以 SDK 工具形式注入：

- `sideEffect === 'read'` 的工具：在 Pi Runtime 内直接执行读 handler，返回结构化的文本结果。
- `sideEffect === 'write' | 'high-risk'` 的工具：不在 Pi Runtime 内执行写，只发送 `proposal` 信封，等待 Main 返回 `proposalDecision`。
- 工具参数 schema 继续复用 `jsonSchemaToTypeBox()` 或等价的 SDK schema 适配。
- 工具注册发生在 Pi Runtime 子进程内，不依赖外部扩展文件加载和 HTTP 控制通道。

## 10. 打包与交付

### 10.1 依赖

- 在 `apps/desktop/package.json` 或 `packages/agent-host/package.json` 中加入并锁定 Pi SDK 依赖。
- 明确记录版本号、来源包名和许可，作为应用供应链清单的一部分。

### 10.2 构建

- 扩展 `apps/desktop/package.json` 的 `build:main` 或新增脚本，使用 esbuild 打包：
  - `dist-electron/main/index.js`（现有）
  - `dist-electron/preload/index.cjs`（现有）
  - `dist-electron/pi-runtime/utility-entry.cjs` 或 `.mjs`
  - `dist-electron/pi-runtime/fork-entry.cjs`（回退用）
- 将 Pi SDK、agent-host、connectors 等运行时依赖打入对应 bundle，避免运行时依赖系统 Node 模块解析。
- 若 Pi SDK 含原生模块或必须在 `app.asar` 外运行的文件，通过 `asarUnpack` 或 `extraResources` 处理，但最终仍是一个安装包。

### 10.3 运行时定位

- 移除 `resolvePiBin()`。
- `PiRuntimeSupervisor` 通过 `app.isPackaged` 或 `import.meta.url` 定位 bundled 的 `pi-runtime` 入口。
- 不再读取 `SPARKII_PI_BIN` / `PI_BIN`；这些环境变量仅保留为开发测试的显式覆盖，默认不依赖。

## 11. 错误处理与恢复

- `PiRuntimeSupervisor` 订阅子进程 exit/error。
- 非 0 退出沿用现有指数退避重启策略，并记录结构化日志。
- 子进程启动后重放恢复配置：
  - `set_auto_retry`
  - `set_auto_compaction`
  - 如有 `SPARKII_SESSION_FILE`，执行 `switch_session`
- utilityProcess 崩溃时，Main 必须检测并在下一轮恢复窗口重建 transport 和 client，避免持有已关闭 port。
- Renderer 看到的仍是“重连中”体验，不暴露底层进程机制。

## 12. 安全与合规影响

- Pi Runtime 仍是独立 OS 进程，未来可在该子进程上叠加 Windows restricted token、目录/网络限制、容器或微 VM。
- Main 仍是可信但最小权限的控制层，持有审批、审计、身份和密钥能力。
- 去掉本地 HTTP control server 后，减少一个本地端口和 token 暴露面。
- Pi SDK 依赖作为供应链资产纳入版本锁定和许可记录。
- 审批不变量不变：LLM 只能提议，Main 侧确定性 executor 执行；拒绝不执行，全程审计。

## 13. 测试策略

### 13.1 Spike

在写实现代码前，用一个最小可运行 spike 验证：

1. 在 Electron `utilityProcess` 中加载并运行 Pi SDK。
2. `createAgentSession()` 可创建会话并流式返回事件。
3. 工具注入、模型配置、`abort` 等基本调用可用。
4. 在 `child_process.fork({ windowsHide: true })` 中的回退表现。

Spike 代码标记为 throwaway，不进入正式产品路径。

### 13.2 单元测试

- transport 抽象：每个 transport 能正确 `send`、接收事件、`close`。
- supervisor 生命周期：启动、幂等 start、stop、exit 回调、重启退避。
- 协议映射：`RpcCommand` 到 SDK 调用的映射保持现有语义。
- 审批流：propose 消息从 Pi Runtime 经 transport 到 Main，批准/拒绝决定正确回传。

### 13.3 集成测试

- 在 Electron 测试环境中 fork 真实 `pi-runtime` 入口，验证 `get_state`、`prompt`、事件流、abort、恢复。
- 保留现有 `PiProcessSupervisor` 的进程树终止测试逻辑，迁移到新的 supervisor。
- 端到端验证“上传合同 → 跑 workflow → 审批 → 导出报告 → 审计”仍通过。

### 13.4 打包验证

- 构建产物中不存在对系统 `pi` 的运行时依赖。
- 在干净 Windows 环境（无 `pi`、无 pnpm、无系统 Node）安装并启动应用，确认不出现终端且可完成一次对话。

## 14. 实施顺序

1. 完成 Pi SDK 与 utilityProcess 兼容性 spike，并决定 6.1 或 6.2。
2. 引入 Pi SDK 依赖并锁定版本。
3. 实现 `PiRuntimeTransport`、`PiRuntimeSupervisor`、`createPiRuntime()`。
4. 实现 utilityProcess 入口和回退 fork 入口。
5. 移除 `resolvePiBin()` 和本地 HTTP control server 主路径依赖。
6. 调整打包脚本，把 Pi Runtime 和 SDK bundle 进 `dist-electron`。
7. 迁移并补齐单元、集成、E2E 测试。
8. 在干净 Windows 环境做安装包验收。

## 15. 验收标准

- 单个 Sparkii 安装包可在未安装 `pi`、pnpm、Node 的 Windows 主机上启动并完成对话。
- 应用启动和运行全程不出现空白 terminal/控制台窗口。
- Pi Runtime 崩溃后 Main 能自动恢复，Renderer 正常显示重连/恢复状态。
- 写操作仍由 Main 侧审批门和确定性 executor 控制，被拒绝的写不执行且写入审计。
- `pnpm test` 与现有 Playwright Electron pilot 流程通过。
- 打包产物不包含对 PATH 中 `pi.cmd` 的隐式依赖。

## 16. 风险与备选

- 风险：Pi SDK 与 Electron utilityProcess 的 Node 运行时存在兼容差异。
  - 应对：第 13.1 节 spike 先行；不兼容时回退到 `child_process.fork` + `windowsHide: true`。
- 风险：Pi SDK 打包后体积或原生依赖超出预期。
  - 应对：使用 esbuild 精确 external 与 `asarUnpack` 策略，只打包运行时必需路径。
- 风险：事件协议映射与当前 RPC 语义不完全一致。
  - 应对：保留 `RpcCommand` / `NormalizedEvent` 契约，并用集成测试锁定行为。
- 风险：Pi SDK 上游版本变更导致 API 漂移。
  - 应对：锁定具体版本，并将升级作为受控供应链变更处理。
