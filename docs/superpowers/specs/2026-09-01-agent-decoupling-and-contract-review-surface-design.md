# Agent Decoupling & Contract Review Surface — Design Spec

**Status:** Draft (pending human review)
**Date:** 2026-09-01
**Branch:** `main`

## Goal

把 Sparkii 从「合同审核、通用聊天等表面写死在平台代码里」演进为「平台 + Pi 能力底座 + 可组合 Agent」的架构：

- 平台始终提供 Pi 能力、会话、审批、审计、运行池、模型目录、workspace 等公共能力。
- 每个 Agent 是调用这些公共能力的「壳」，只声明自己的 surface、能力和业务状态。
- 合同审核成为第一个验证该架构的 `workflow` surface。
- 不同客户可以通过构建期组合不同 Agent，而不需要在平台核心里写业务分支。

## Background / Current State

当前架构的主要耦合点：

- `apps/desktop/src/App.tsx` 把 `contract-review`、`chat`、`dashboard`、`general` 写进 `ScreenId`，并在导航逻辑中对 `contract-review` 和 `general` 做特判。
- `ContractSurface` 是手写组件，没有真正走 `PageComposer`；`profiles/contract-review/ui/pages/home.json` 基本未被业务页面使用。
- `apps/desktop/electron/main/runtime.ts` 和 `workflow.ts` 硬编码 `documentConnector`、`knowledgeConnector`、`reportConnector`。
- `firstProfileWithKnowledge` 是全局「找第一个有知识库的 profile」的逻辑，不是按 Agent 隔离。
- 通用智能体被当作普通 profile 使用，代码里出现多处 `agentId === 'general'`、`profileId ?? 'general'`。
- 合同审核 workflow 使用一次性 `randomUUID` session，完成后不进入平台 session 历史，不能恢复。

## Confirmed Design Decisions

1. **只有一个 Agent Registry**。surface 和 capabilities 都属于同一个 Agent，不拆成三个独立注册表。
2. **Agent 的统一入口是 manifest**。main 和 renderer 各自读取同一 manifest 的进程视图。
3. **Agent surface 支持标准范式和自定义实现**。`chat / workflow / dashboard` 是标准范式，复杂场景可自定义，但必须实现统一 `AgentSurface` 契约。
4. **平台只维护模型目录、能力标签和默认模型**。Agent 只声明所需能力，不写死 provider/model。
5. **用户选择不满足 Agent 能力需求的模型时，平台允许但警告**。
6. **所有 Agent 复用统一 session**。恢复来源是平台 DB metadata、Pi JSONL 和 workspace 文件。
7. **所有 Agent 复用统一 workspace**。默认放在 `Documents/Sparkii/workspaces/<agentId>/<sessionId>`，用户可覆盖。
8. **平台主显示只放线程占用、错误中心等全局状态**。context、步骤、模型、产出属于 Agent 页面。
9. **模型连接失败是平台级事件，但会通知受影响的具体 Agent**。
10. **合同审核 surface 自己维护 `stepId → StepView` 映射**。workflow 负责执行顺序，UI 负责步骤内容展示。
11. **中间步骤产出不重复落盘**。Pi JSONL 是过程和结果的唯一事实源；workspace `output/` 只放用户明确要的产物。
12. **JSONL 使用 `workflow_step_start/end` 建立步骤时间线，使用 `workflow_state` 记录非 Pi 自然事件的业务状态**。
13. **通用智能体与其他 Agent 同等级**。它使用平台标准 `chat` surface，没有 `alwaysIncluded` 或 `kind: base` 这类特殊身份；是否交付由 delivery manifest 决定。

## Architecture Overview

```text
Platform Core（始终存在）
  Pi Runtime
  Session Store
  Approval / Audit / RBAC
  Runtime Pool
  Model Catalog
  Workspace Manager
  Settings / Theme / Error Center

Agent Package（每个智能体一个）
  general
  contract-review
  future agents...
  manifest.yaml
  surface view
  capabilities view

Delivery Manifest（未来单独设计）
  本次交付包含哪些 Agent Package
```

### 核心边界

- **Pi 基础能力层负责「干活」**：Agent 循环、模型调用、工具、skills、连接器、会话。
- **Agent 负责「声明和呈现」**：需要哪些能力、使用什么 surface、如何展示步骤和产物。
- **平台负责「公共治理」**：会话、审批、审计、运行池、模型目录、workspace 和错误路由。

平台不需要知道「合同审核」这个业务。它只需要知道当前 Agent 的 `surfaceType`、`capabilities` 和 session 状态。

## Subsystem 1: Agent Package & Unified Agent Registry

### 目录结构

目标目录建议为：

```text
agents/
  general/
    manifest.yaml
    capabilities.ts
    prompts/
      system.md
    security/
      roles.yaml
      approval.yaml
  contract-review/
    manifest.yaml
    surface.tsx
    capabilities.ts
```

`general` 使用平台标准 `chat` surface，因此不需要自己的 `surface.tsx`。`contract-review` 是 workflow surface，保留自己的 `surface.tsx`。

从现有 `profiles/` 平滑演进，不要求一次重命名。迁移完成后，`agents/<id>/manifest.yaml` 是每个 Agent 的唯一入口。

### Agent Manifest

manifest 只放声明和路径引用，不包含实现代码：

```yaml
id: contract-review
displayName: 合同审核智能体
version: 1.0.0
sortOrder: 20

surface:
  type: workflow
  entry: surface.tsx

capabilities:
  entry: capabilities.ts

workflow: workflow.yaml
skills: skills/
prompts: prompts/

security:
  roles: security/roles.yaml
  approval: security/approval.yaml

modelRequirements:
  requires: [reasoning, vision]
  prefers: [longContext]
```

`general` 使用：

```yaml
id: general
displayName: 通用智能体
version: 1.0.0
sortOrder: 10

surface:
  type: chat

capabilities:
  entry: capabilities.ts
  tools: [read, ls, grep, find, bash, edit, write]

modelRequirements:
  requires: [chat, toolCall]
```

### 统一注册表

逻辑上只有一个 Agent Registry：

```text
AgentRegistry
  agentId -> Agent
              ├─ manifest
              ├─ surface 视图
              └─ capabilities 视图
```

由于 Electron 进程隔离，surface 由 renderer 使用，capabilities 由 main 使用。它们是同一个 Agent 在两个进程里的视图，不是独立注册表。

### 加载原则

manifest 是唯一事实源。构建期根据所有 Agent 的 manifest，分别生成 renderer 侧 surface 绑定和 main 侧 capabilities 绑定。运行期不做任意文件动态 import。

## General Agent Split

通用智能体是普通 Agent，不放在 Platform Core。

### 归属

- **General Agent Package** 持有 `manifest.yaml`、`capabilities.ts`、`prompts/system.md`、`security/`。
- **Platform Standard ChatSurface** 持有消息流、工具卡片、模型选择、context、workspace、队列、附件和停止/发送。
- **Platform Core** 只提供 Pi 能力、session、审批、审计、运行池、模型目录和 workspace。

### 职责

```text
general
  surface: platform standard chat
  capabilities: read, ls, grep, find, bash, edit, write
  modelRequirements: chat, toolCall
  session kind: chat
```

平台渲染 `general` 时，不写 `agentId === 'general'`。它只是发现当前 Agent 的 `surface.type = chat`，然后渲染标准 `ChatSurface`。

### 现有 GeneralChatSurface 迁移

现有 `GeneralChatSurface` 升级为平台标准 `ChatSurface`，并继续复用 `ChatMessage`、`ToolCard`、`Composer`、`LifecycleCard`、`Markdown`、`pi-timeline` 等 UI 组件。`App.tsx` 中 `activeGeneralSession`、`generalTitle` 和单独渲染 `generalSurface` 等特判全部移除。

## Subsystem 2: Agent Surface Contract

### 职责

平台只通过统一契约渲染 Agent 页面，不关心内部是聊天、合同审核还是仪表板。

### 契约

```text
AgentSurfaceProps
  agent: AgentDescriptor
  sessionId: string | null
  state: AgentSurfaceState
  actions: AgentSurfaceActions
```

`AgentSurfaceState` 至少包含：

```text
workflowSteps
selectedStepId
sessionEntries
model
contextUsage
workspace
approvals
errors
```

`AgentSurfaceActions` 至少包含：

```text
send
stop
startWorkflow
approve
newSession
openSession
setModel
chooseWorkspace
```

### 标准表面与自定义表面

- `chat / workflow / dashboard` 是平台提供的默认实现。
- 极少数复杂 Agent 提供自定义实现，但必须实现同一契约。
- 平台仍然统一控制会话、审批、错误和运行状态。
- `general` 使用平台标准 `chat` surface；`contract-review` 使用 `workflow` surface。

## Subsystem 3: Agent Capabilities Contract

### 职责

每个 Agent 的 capabilities 模块负责把这个 Agent 需要的领域能力注册给平台。真正的执行、审批、审计仍由平台调度。

### 最小接口

```text
AgentCapabilities
  id: string
  init(context): Promise<void>
  tools(context): ToolDef[]
```

`context` 包含：

```text
agent manifest
sessionId
workspace
model catalog
proposal broker
```

### 常驻能力与注册能力

- 平台常驻 Pi 通用能力和通用工具。
- Agent 通过 `tools(context)` 返回自己的领域工具。
- 平台在工具进入 Pi 前统一处理 `read / write / high-risk` 语义，并接入审批门。

合同审核的 capabilities 返回：

```text
document.read
knowledge.search
report.export
```

通用智能体的 capabilities 返回平台通用工具清单 `read / ls / grep / find / bash / edit / write`。平台解析这些工具并统一执行 workspace 限制、审批和审计，而不是对 `general` 做特殊分支。

## Subsystem 4: Model Capability Catalog & Selection

### 职责

模型控制由平台负责。Agent 只声明能力需求，不声明具体 provider/model。

### 模型能力标签

第一版固定以下能力：

```text
chat
reasoning
longContext
vision
fast
toolCall
thinking
```

`thinking` 还包含模型支持的档位，例如 `low / high / max`。

### 平台模型目录

```yaml
providers:
  deepseek:
    models:
      deepseek-v4-pro:
        capabilities: [chat, reasoning, longContext, toolCall, thinking]
        thinkingLevels: [low, high, max]
      deepseek-v4-flash:
        capabilities: [chat, fast, toolCall]
      deepseek-vision:
        capabilities: [chat, vision]
```

### Agent 能力需求

```yaml
modelRequirements:
  requires: [reasoning, vision]
  prefers: [longContext]
```

### 模型选择流程

1. 如果当前会话已有用户选择的模型，优先使用。
2. 否则使用平台默认模型，但前提是它满足 Agent 能力需求。
3. 默认模型不满足时，推荐第一个满足能力的可用模型。
4. 用户可以随时在 Agent 页面修改模型。
5. 用户选择不满足能力的模型时，平台允许但显示警告。

### 模型事件

模型连接失败是平台级事件：

- 进入平台错误中心。
- 携带 `providerId / modelId / 受影响 session`。
- 具体 Agent 页面显示「影响当前智能体」的局部提示。

## Subsystem 5: Unified Session & Recovery

### 统一 Session 模型

所有 Agent 复用同一个 session 概念：

```text
SessionRecord
  id
  agentId
  kind: chat | workflow | dashboard
  title
  status
  model
  thinkingLevel
  workspacePath
  piSessionFile
  currentStep
  pinned / archived / sortOrder
  createdAt / updatedAt
```

底层 Pi session 不变，平台只给它挂上 `agentId / kind / currentStep` 等索引。

### 恢复来源

```text
平台 DB metadata  → 快速恢复索引和当前状态
Pi JSONL          → 恢复对话、工具调用、workflow 步骤和业务状态
workspace 文件     → 恢复输入文件和用户明确要的产物
```

### JSONL 时间线

在 Pi JSONL 中增加轻量步骤标记：

```text
workflow_step_start
  stepId
  attempt
  startedAt

workflow_step_end
  stepId
  status
  finishedAt
  error?
```

两个标记之间的消息、工具调用和工具结果都属于该步骤。

### workflow_state

`workflow_state` 记录既不是模型对话、也不是工具调用，但会影响业务状态的事件：

- 用户复核动作：确认风险、忽略风险、补充意见。
- 产物路径：导出报告完成。
- 其他影响恢复结果的用户操作。

示例：

```json
{
  "type": "workflow_state",
  "stepId": "compare",
  "action": "risk_confirmed",
  "riskId": "risk_001",
  "actor": "审核员A",
  "at": "2026-09-01T10:20:00.000Z"
}
```

### 权威顺序

```text
运行池实时状态
  >
平台 DB 当前状态
  >
Pi JSONL 历史
```

正常恢复时，JSONL 提供步骤时间线和业务状态；DB 提供索引；workspace 提供大文件。

## Subsystem 6: Unified Workspace

### 统一机制

每个 session 只有一个 workspace。

```text
Documents/
  Sparkii/
    workspaces/
      <agentId>/
        <sessionId>/
          input/
          output/
```

用户未指定时，平台创建默认 workspace；用户指定时，使用用户目录。

### 合同审核示例

```text
workspace/
  input/
    contract.pdf
  output/
    report.docx
```

中间步骤产出不写入 workspace 的 `output/`。它们由 Pi JSONL 恢复。

### DB 存储

DB 只存：

```text
workspaceKind
workspacePath
```

不存大文件内容。

## Subsystem 7: Contract Review Surface

### 页面结构

合同审核是 `workflow` surface，顶部流程条常驻，下方显示当前步骤内容。

```text
模型 · context · workspace
上传 → 解析 → 检索 → 抽取 → 比对 → 报告 → 复核
当前步骤内容视图
```

用户可以点击任意步骤查看该步骤的产出，流程完成后也可以回溯。

### Step Views

合同审核 surface 内部按 `stepId` 映射：

```text
UploadStepView
ParseStepView
SearchStepView
ExtractStepView
CompareStepView
ReportStepView
ReviewStepView
```

每个步骤展示权威结果，并可展开过程证据。

### 状态归属

- 流程步骤、模型、context、风险、报告属于合同审核页面。
- 线程占用、全局错误属于平台主显示。
- 模型连接失败作为平台事件通知合同审核页面。

### 恢复行为

重新打开合同审核 session 时：

1. 从 DB 恢复 `workspacePath / piSessionFile / currentStep`。
2. 从 Pi JSONL 恢复步骤时间线。
3. 从 `workflow_state` 恢复用户复核动作和产物路径。
4. 从 workspace 恢复合同原文和报告文件。

## Error Handling

- **模型能力不满足**：允许用户选择，但显示警告，说明会丢失的能力。
- **模型连接失败**：平台错误中心记录，同时通知受影响 Agent。
- **Pi JSONL 损坏或缺失**：DB 仍能恢复索引；Agent surface 显示「历史过程不完整」。
- **workspace 文件缺失**：显示文件缺失状态，不伪造结果。
- **workflow 失败**：记录 `workflow_step_end` 的失败状态，并在对应步骤视图中显示错误。
- **审批拒绝**：权威结果仍以平台审计和 JSONL 为准，界面不显示「已执行」。

## Testing Strategy

- **Agent Registry**：manifest 解析、surface/capabilities 视图生成、Agent 排序。
- **Model Catalog**：能力标签匹配、默认模型回退、不满足能力时的警告。
- **Session Recovery**：从 JSONL 的 `workflow_step_start/end` 切片步骤，从 `workflow_state` 恢复复核状态。
- **Workspace**：默认路径、用户覆盖路径、输入文件复制、输出目录隔离。
- **Contract Review Surface**：步骤切换、完成态回溯、模型/context 展示、风险复核、报告导出审批。
- **安全不变量**：拒绝的写不执行；所有写尝试有审计；步骤状态不依赖 LLM 文字叙述。

## Out of Scope

- 运行时插件安装、动态加载和 side-load。
- profile 携带任意前端代码。
- 完整 connection registry / 第三方 connector 插件系统。
- 多模型并行、自动成本计算。
- 复杂能力推断。
- 客户交付时的 Delivery Manifest，本次只预留概念，单独出 spec。
- 硬沙箱、SSO/LDAP/AD、集中审计等既有规划项。

## Self-Review Notes

- 本 spec 覆盖已确认的 Agent 边界、模型能力目录、session/workspace 统一和合同审核 surface。
- `general` 已从 Platform Core 移出，作为普通 Agent 使用平台标准 `chat` surface，无 `alwaysIncluded` 或 `kind: base`。
- 逻辑上只有一个 Agent Registry；surface 和 capabilities 被明确描述为同一 Agent 的两个进程视图。
- 中间步骤产出不重复落盘，恢复来源为 Pi JSONL + DB metadata + workspace 文件。
- `workflow_step_start/end` 建立时间线，`workflow_state` 补充用户复核和产物路径，避免依赖解析模型自由文本。
- Delivery Manifest 被明确列为 out of scope，避免本 spec 过度扩张。
