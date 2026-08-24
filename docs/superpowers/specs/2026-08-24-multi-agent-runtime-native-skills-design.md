# Multi-Agent Runtime & Native Skill Loading — Design Spec

**Status:** Draft (pending human review)
**Date:** 2026-08-24
**Branch:** codex/pi-embedded-runtime

## Goal

把 Sparkii 从「单 Runtime → 单 Pi 子进程 → 单 session」演进为「多 Agent 并行（有上限）+ 每 Agent 独立 session + Pi 原生的 Agent Skills 按需加载」，使新开的 Agent 与正在运行的 Agent 在对话状态上完全隔离，并把 skill 的加载方式从「body 全文贴进 prompt」改为 Pi 标准的 progressive disclosure（目录注入 + read 工具按需读正文与 references/assets）。

## Background / Current State

- 一个 Electron 应用持有一个全局 `Runtime`（[index.ts](../../../apps/desktop/electron/main/index.ts)），其中 `supervisor` 是单例 `PiRuntimeSupervisor`，懒启动**一个** Pi 子进程。
- 该子进程内部只有一个 `AgentSession`；`runWorkflow` 与聊天都复用同一个 session，`sessionId` 硬编码为 `'default'`（[workflow.ts](../../../apps/desktop/electron/main/workflow.ts)、[ipc.ts](../../../apps/desktop/electron/main/ipc.ts)）。
- skill 加载现状：`@sparkii/config` 的 `loadProfile` 把 `agent/skills/**/SKILL.md` 解析为 `SkillPackage[]`，并派生 `prompts: Record<name, body>`；desktop 的 `resolveWorkflowTemplates` 把 workflow 的 `ref`/`template` 替换成整段 body，`LinearRunner` 用 `sendPrompt(body + inputs)` 发给 Pi。frontmatter 的 `description` 只做校验、不参与运行时。
- 审计 `AuditEvent` 无 `sessionId` 字段，无法区分是哪个 Agent 触发的审批。

## Confirmed Design Decisions

1. **sessionId**：主进程 `randomUUID()` 生成；一个 Agent 实例 = 一个 sessionId；贯穿 proposal、audit（新增字段）、workflow 事件、Pi session 映射。`actor`（人）、`sessionId`（Agent 实例）、`profileId`（能力包）三者正交。
2. **隔离粒度**：每 Agent 一个 Pi 子进程（进程池），懒启动 + 复用；并发上限默认 4，可用 `SPARKII_MAX_AGENTS` 配置。
3. **超过上限**：排队等待（有槽位再分配），不拒绝。
4. **Agent 结束**：`release` 归还槽位；作废旧 sessionId；对该子进程的 Pi session 调 `newSession()` 重置（清空对话历史/工具/模型状态）。新 sessionId 在**下一次 acquire** 时才生成，不预分配。
5. **审批/审计/RBAC/profile 全局共享**（安全合规层，故意不隔离）；审计补 `sessionId` 字段使审批可回溯到具体 Agent。
6. **L3 决策 1**：skills 全量注入 —— 一个 session 的 `<available_skills>` 包含 profile 内全部 skill（name+description+location），每步靠 workflow 指令锁定用哪个 skill。
7. **L3 决策 2**：复用 Pi 内置 `read` 工具（不覆盖）。
8. **L3 决策 3**：正文与 `references/`、`assets/` 一并按需读（progressive disclosure），并把 skill 目录下全部文件纳入 profile integrity 签名文件集。

## Architecture Overview

三个子系统，按依赖顺序排列（后一个是前一个的基础）：

1. **Session 制**：把硬编码 `'default'` 换成 per-Agent 的 sessionId 生命周期与路由。
2. **Pi 进程池**：每 Agent 一个 Pi 子进程，池化并限流。
3. **原生 skill 加载（L3）**：session 创建时把 profile skills 交给 Pi，靠内置 read 工具按需读正文。

```
Renderer (App.tsx)
   |  newAgent / runWorkflow(sessionId) / prompt(sessionId) / decideApproval(proposalId)
   v
Main Process
   +- PiRuntimePool ---> [slot0: PiRuntimeSupervisor -> Pi子进程 -> AgentSession]
   |                    [slot1: ...]
   |                    [slot2: ...]   (上限 SPARKII_MAX_AGENTS=4, 懒启动)
   |                    [slot3: ...]
   +- ApprovalGate / AuditStore / Rbac  (全局共享, audit 带 sessionId)
   +- profile (loadProfile: 校验 integrity, 派发 skills 目录路径)
```

## Subsystem 1: Session 制

### 职责

为每个 Agent 分配唯一 `sessionId`，并把它贯穿到审批、审计、事件与 Pi 会话路由。

### 组件与接口

- **新增 IPC `sparkii:newAgent`**：主进程生成 `sessionId = randomUUID()`，从池 `acquire` 一个槽位，返回 `{ sessionId }`。Agent 创建即占用槽位。
- **`runWorkflow(sessionId, input)` / `prompt(sessionId, text)`**：改为按 sessionId 路由到对应槽位的 Pi client；`LinearRunner` 的 `RunContext.sessionId` 使用真实值。
- **审批归属**：每个槽位注册自己的 `onProposal`，闭包捕获该槽位的 sessionId；`gate.submit(req, { profileId, sessionId, actor })` 使用真实 sessionId；审批事件推给 renderer 时携带 sessionId，供 UI 显示 Agent 标识。
- **审计**：`AuditEvent` 增加 `sessionId?: string`；`AuditStore` 表新增 `session_id` 列（对已存在的 SQLite 库做幂等迁移：检测列是否存在，缺则 `ALTER TABLE audit ADD COLUMN session_id TEXT`）。`append`/`query`/`exportJsonl` 均携带该字段。

### 数据流

1. Renderer 发起新 Agent -> `sparkii:newAgent` -> 主进程 `sessionId = uuid()` -> `pool.acquire(sessionId)` -> 返回 sessionId。
2. Renderer 用 sessionId 调 `runWorkflow`/`prompt` -> 主进程 `pool.get(sessionId)` 拿到 client -> 发 `prompt`/`set_model`。
3. Pi 侧工具调用产生 proposal -> 该槽位的 `onProposal` 以 sessionId 转发 -> `gate.submit` -> 审计记 `proposal.created`（含 sessionId）。
4. Renderer `decideApproval` -> `gate.decide`（全局）-> 审计记 `proposal.approved/denied`（含 sessionId）-> `broker.decide` 回对应槽位。
5. Agent 结束 -> `pool.release(sessionId)` -> 作废映射 + `newSession()` 重置槽位。

## Subsystem 2: Pi 进程池

### 职责

管理有上限的 Pi 子进程集合；每 Agent 独占一个槽位直至结束。

### 组件与接口

- **新增 `PiRuntimePool`**（建议置于 `packages/agent-host`，命名 `PiRuntimePool`）：
  - `constructor({ maxAgents, makeSupervisor })`
  - `acquire(sessionId): Promise<PiRuntimeClient>` —— 有空格则取用；否则挂起排队；返回该槽位的 client。
  - `release(sessionId): Promise<void>` —— 作废映射，对该槽位 Pi session 做 `newSession()` 重置，标记空闲，唤醒等待者。
  - `get(sessionId): PiRuntimeClient | undefined` —— 按 sessionId 取 client。
  - `stopAll()` —— 关闭全部子进程。
- **懒启动**：仅在 `acquire` 时 `supervisor.start()` 启动子进程；复用 `PiRuntimeSupervisor` 的现有懒启动语义。
- **Runtime 改造**：`Runtime.supervisor: PiRuntimeSupervisor` 替换为 `Runtime.pool: PiRuntimePool`。`assemble` 构造池，`makeSupervisor` 复用现有 `createUtilityHostHandle` / `createForkHostHandle`。
- 池大小 `SPARKII_MAX_AGENTS`（默认 4）在 `assemble` 读取并注入。

### 错误处理

- 子进程退出（`onExit`）-> 该槽位 client `failPending`；若该槽位有绑定 sessionId，其后续请求报「runtime exited」，Agent 标记失败并 `release`。
- 队列中等待的 Agent 若被取消/超时，从队列移除并返回错误。

## Subsystem 3: Native Skill Loading (L3)

### 职责

让 Pi 在 session 内加载 profile skills、注入 `<available_skills>` 目录，并用内置 read 工具按需读正文。

### 组件与接口

- **注入 skills**：`createPiSdkSessionHost` 新增 `skillsDir` 选项；创建 services 时传 `resourceLoaderOptions: { additionalSkillPaths: [skillsDir] }`，使 Pi 的 `DefaultResourceLoader` 经 `loadSkills` 加载该目录（含全部 SKILL.md）。
  - 事实依据：Pi 的 `buildSystemPrompt` 在 `read` 工具可用且 skills 非空时自动调用 `formatSkillsForPrompt`，把 `name+description+location` 注入 system prompt；正文不注入。
- **保留 read 工具**：当前 `session.agent.state.tools = piTools` 覆盖了工具集，会丢掉内置 read。改为经 `createAgentSessionFromServices` 的 `tools: ['read']` + `customTools: sparkiiTools`（`buildPiRuntimeTools(...).map(defineTool)` 的产物）组合，确保 read 与 connector 工具并存。若 Pi 的组合语义与预期不符，则退化为显式把 `createReadTool` 的产物并入 `piTools`（实现时验证二选一）。
- **workflow 改造**：`resolveWorkflowTemplates` 不再把 `ref`/`template` 替换为 body 全文；skill/llm 步骤的 prompt 改为一条指令：「请读取并遵循 `X` 这个 skill 完成本步骤」+ 输入 JSON。`LinearRunner` 仍确定性锁定每步的 skill 名。
- **`profile.agent.prompts`**：保留派生字段 `prompts: Record<name, content>`（`raw`/`content` 继续用于 integrity 签名），但运行时不再用它拼 prompt。
- **integrity 扩展**：`loadProfile` 的 `files` 集合从「仅 SKILL.md」扩展为「skill 目录下全部文件（含 references/、assets/、scripts/）」。新增递归收集：以 skill 根目录为界，规范化相对路径（统一 `/`），排除 `.` 前缀、`node_modules`；每个文件以 `agent/skills/<relPath>` 为 key、原始字节为值纳入 `files`。
- **签名/发布一致性**：将「收集 profile 文件」抽为单一事实来源（例如 `collectProfileFiles(dir)`），供运行时 `loadProfile` 与（未来）签名工具复用，避免两边收集逻辑漂移导致验签不一致。

### 数据流（skill 按需读）

1. session 创建：`additionalSkillPaths=[skillsDir]` -> Pi `loadSkills` -> `buildSystemPrompt` 注入 `<available_skills>`（仅 name+description+location）。
2. 某 skill 步骤：workflow 发指令「请读取并遵循 `clause_extract`…」-> 模型调 `read(location)` 读 SKILL.md 正文。
3. 正文引用 `references/x.md` 时，模型按目录内指示把相对路径解析到 skill 目录，再 `read` 绝对路径读 references/assets 内容。
4. `report.export` 等有副作用工具仍走 proposal -> 主进程审批（不受影响）。

## Error Handling

- **池耗尽**：`acquire` 排队；若等待超时或被取消，返回明确的「并发已满」错误。
- **子进程崩溃**：槽位 failPending，Agent 标记失败并 release；池不整体崩溃。
- **验签失败**：沿用现有 `SIGNATURE_INVALID`（fail closed）；未签名 profile 仅开发模式放行。
- **read 失败**：模型收到文件读取错误后可重试或报错，错误经现有 `workflow_failed` 通道上抛，不伪造成功。

## Testing Strategy

- **单元**（`@sparkii/agent-host` / `@sparkii/config`）：
  - sessionId 路由：pool.get/acquire/release 的映射与排队；
  - 审计：`AuditStore` 带 sessionId 的 append/query/迁移；
  - integrity：递归收集 skill 目录文件、路径规范化、排除规则；
  - skills 注入：`additionalSkillPaths` 正确传入（用 fixture 断言 Pi 侧 `getSkills()` 或 mock resource loader）。
- **集成**（desktop）：
  - `resolveWorkflowTemplates` 改后仍产出确定性 skill 名；
  - 审批归属：proposal 携带正确 sessionId，decide 回正确槽位。
- **e2e**：
  - 单 Agent pilot 仍 1 passed（skill 步骤经 read 加载正文、`report.export` 一次审批、`审核完成`）；
  - 并发：两个 Agent 并行，各自审批互不串（用 `SPARKII_SKIP_LLM` 或真实模型，视耗时取舍）。

## Out of Scope

- 空闲槽位超时回收（`release` 后延迟销毁子进程）——留作后续可选项。
- 每 Agent 绑定不同 profile / 多 profile 路由。
- 多用户 UI 与权限矩阵（RBAC 已有，仅单用户 pilot）。
- skill 的 `allowed-tools` / `license` / `compatibility` 等 enforcement。
- `<available_skills>` 之外的模型自由选 skill（LinearRunner 无 agent loop 的部分仍不在本次范围）。

## Self-Review Notes

- 三个子系统按「session 制 -> 进程池 -> L3」的顺序，后者依赖前者；spec 内无 TBD/TODO。
- sessionId 三标识（actor/sessionId/profileId）语义唯一，无歧义。
- L3 的「保留 read 工具」给出主方案 + 退化方案，避免实现时卡死。
- integrity 扩展的路径规范化与排除规则已在「组件与接口」中明确。
