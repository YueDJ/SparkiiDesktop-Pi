# Agent Surface Template & Contract Review Surface — Design Spec

**Status:** Draft (pending human review)
**Date:** 2026-09-02
**Branch:** `main`

## Goal

在既定「平台 + Pi 能力底座 + 可组合 Agent」的架构上，完成两件事并保持边界清晰：

- 把「Agent Surface」从「平台层写死的分支」演进为**一个薄契约 + 可选公共件的模板**：任何 Agent 可以做出**完全自定义、个性化的页面**，也可以复用平台标准范式（`chat` / `workflow` / `dashboard`）；平台不再硬编码某个 Agent。
- 把合同审核做成这个模板的**第一个实例**：修复现有合同审核界面的流程与展示 bug，并让它的 Surface **同时支持实时消息与历史回放**（live + history），不再以纯文本/MD 倾倒的方式呈现。

平台层与 Agent 层的划分必须**既逻辑清晰、又物理文件位置清晰**，避免相互渗透。

## Background / Current State

### 现状的三个核心症结

1. **Surface 没有「会话」概念，只挂一个游离的 `state` 对象。**
   `ContractSurface` 依赖内存中的 `state`（documents + workflow.result）+ `workflow`（status）+ `workflowSessionId` 三个分散数据。打开一个历史合同会话时，`onOpenSession` 对非 chat agent 只做 `navigate('contract-review')`，**不加载会话、也不回放数据** → 呈现的是空页面；且 `state` 是全局单例，多会话互相污染。

2. **所有中间产出渲染成 `JSON` 文本（`<pre>`），报告走纯文本 div。**
   [StepViews.tsx](../../../apps/desktop/agents/contract-review/surface/StepViews.tsx) 每步都是 `text(...)` 包一层 `<pre>`；报告 tab 是 `ui-muted contract-pre-wrap` 的纯文本。因此用户看到「全是 MD 文字、没有图形化界面」。

3. **报告 / 复核 / 导出是「断的」。**
   「导出报告 · 需审批」按钮实际只 `setScreen('approvals')` 跳到审批中心，没有发起导出审批；复核的「确认/忽略」只改本地 `reviewed` 状态，不回写、不驱动报告，丢在流程里就没了。

### 边界被破坏的三处

- [App.tsx](../../../apps/desktop/src/App.tsx) 直接 `import { ContractSurface } from '../agents/contract-review/surface/index.js'` 和 `GeneralChatSurface`，并用 `screen === 'general'` / `'contract-review'` 大量特判。平台层硬编码了具体 Agent。
- Agent 的 `ContractSurface` 反向引用平台内部：`WidgetRegistry`（[registry.js](../../../apps/desktop/src/composer/registry.js)）和 `WorkflowStatus`（[WorkflowStatus.tsx](../../../apps/desktop/src/workbench/WorkflowStatus.tsx)）。
- 平台层 [surface-registry.tsx](../../../apps/desktop/src/platform/surface-registry.tsx) 只是返回字符串的桩，没有真正按 `manifest.surface.type` 解析并渲染 Agent 入口。

### 现有设计不一致

- [contract.ts](../../../apps/desktop/agents/contract-review/surface/contract.ts) 硬编码 `STEPS`（upload / 解析 / 检索 / 抽取 / 比对 / 报告），与 [workflow.yaml](../../../apps/desktop/agents/contract-review/agent/workflow.yaml) 的 `load / search / extract / compare / report` 不一致（多了 `upload`）；`StepViews` 里还藏着一个从未被产出的 `review`。
- `parseRiskFindings` 用 `/(高|high)/i` 等正则去「猜」LLM 输出的风险等级，违背产品原则①「权威状态是唯一事实源」。

## Confirmed Design Decisions

1. **平台 Surface 模板是「薄契约 + 可选公共件」，不是万能 SurfaceHost。** 不造能渲染所有 surface 类型的巨型宿主；chat 与 workflow 布局差异大，放进一个宿主只会催生大量 `if (type === 'chat')` 分支。
2. **平台层与 Agent 层严格分离**：逻辑上平台不认合同步骤、Agent 不认平台内部；物理上各归各自的目录。
3. **Agent 可以完全自定义页面**，不只是复用平台组件。平台公共件是可选加速器；自定义 Surface 只需满足**薄契约**。
4. **步骤条是单一事实源**：来自 Agent 的 `workflow` 定义（顺序 + 显示名），面层只提供显示名映射，避免与后端漂移。
5. **「导入/上传」不是步骤，是空态/前置态**；「复核」是独立阶段面板（门控导出），不伪装成后端运行的假步骤。
6. **类型化业务态 schema**：工作流产出结构化 `RiskFinding` / `Report` / 复核结论，面层渲染权威结构；LLM 文本只作解释性旁注。用类型化数据替换正则猜等级。
7. **live 与 history 同源**：都走「归一化会话流」（`useAgentSession`），live 靠事件增量喂、history 靠 JSONL 确定性回放。历史默认「结果导向」，过程证据可展开。
8. **平台解析 Surface**：构建期按 `manifest.surface.type` 解析出 Surface 组件；`custom` 类型用 manifest 的 `entry`。平台层不再出现 `agentId === 'general'` / `'contract-review'` 特判。

## Architecture Overview

```text
Platform Core（始终存在）
  Shell（顶栏 / 左栏 / 会话抽屉 / 状态栏）
  Trust（审批中心 / 审批面板 / 倒计时）
  Audit（审计视图 + 导出）
  Runtime Pool / Error Center / Theme / Settings
  AgentSurface 薄契约
  useAgentSession（会话打开/恢复/订阅/回放）
  Timeline Normalizer（message / tool / event / workflow_step / workflow_state / custom）
  manifest→surface 绑定（构建期由 manifest 生成，App 边缘解析）
  共享展示件（Header / StepRail / ToolCard / RiskBadge / Markdown / Composer / LifecycleCard）

Agent Package（每个智能体一个）
  general            -> surface.type = chat（复用平台标准 ChatSurface）
  contract-review    -> surface.type = workflow（自研分步视图 + 业务模型 + 业务动作；步骤条数据来自 workflow 定义）
  未来 Agent...       -> 标准范式或 custom
```

### 核心边界

- **Pi 基础能力层负责「干活」**：Agent 循环、模型调用、工具、skills、连接器、会话。
- **平台负责「公共治理 + 会话接入」**：会话、审批、审计、运行池、模型目录、workspace、错误路由、Surface 薄契约与模板。
- **Agent 负责「声明与呈现」**：声明 `surface.type`、步骤、每步视图、业务数据模型、业务动作，以及整套个性化页面。

平台不需要知道「合同审核」这个业务。它只根据 `manifest.surface.type` 渲染 Surface，并根据薄契约把会话上下文和动作传给 Surface。

## Strict Boundary & Physical Layout

### 边界规则（硬性）

- `apps/desktop/src/surface/`（平台 Surface 模板）**绝不** import `apps/desktop/agents/**`。它只依赖面向所有 surface 的契约、会话 hook、归一化器与共享框架组件。
- 「哪个 agent 用哪个 surface」由 `manifest` 唯一决定，并在**构建期生成一份 `agentId → surface 组件` 的绑定**（或由 `import.meta.glob` 扫 `agents/*/manifest.yaml` 推导）。该绑定放在 App 边缘（如 `apps/desktop/src/platform/agent-surface-bindings.ts`，生成物），是**全工程唯一** import 到 `apps/desktop/agents/**` 的地方。它是派生数据，不是需要人工维护的「注册表层」。
- `apps/desktop/agents/<id>/surface/`（Agent surface）**只**通过公开的 `AgentSurface` 契约与 `@sparkii/ui`、平台可用的公共件与平台交互；不允许 import `src/composer`、`src/workbench` 等平台内部模块。
- 平台层**不再**出现 `agentId === 'general'` / `'contract-review'` 特判；只认 `manifest.surface.type`。

### 物理位置

| 层 | 职责 | 位置 |
| --- | --- | --- |
| 平台 Shell + 设计系统 | 顶栏/左栏/会话抽屉/审批/审计/运行中心/错误中心/主题；共享展示件（StepRail、ToolCard、RiskBadge、Markdown、Composer、LifecycleCard） | `packages/ui/`；`apps/desktop/src/shell/`、`apps/desktop/src/trust/`、`apps/desktop/src/audit/` |
| 平台 Surface 模板（薄） | `AgentSurface` 契约、`useAgentSession`、会话流归一化器、共享框架组件；**不含任何 agent 引用，无万能宿主** | `apps/desktop/src/surface/`（新建） |
| App 边缘生成绑定 | 由 `manifest` 生成 `agentId → surface 组件`（标准 ChatSurface / workflow / custom entry）；**唯一 import agents/** 的地方 | `apps/desktop/src/platform/agent-surface-bindings.ts`（构建期生成） |
| 合同审核 Agent | 步骤条（单一事实源化）、分步视图、业务数据模型、业务动作、step→view 映射 | `apps/desktop/agents/contract-review/surface/` |
| 通用 Agent | `surface.type: chat`，复用平台标准 ChatSurface | `apps/desktop/agents/general/surface/` |

## Subsystem 1: Agent Surface Thin Contract & Standard Paradigms

### 薄契约（最小，仅当前需要的字段）

```text
AgentSurfaceProps
  agent:      AgentDescriptor       // id / name / manifest.surface
  sessionId:  string | null
  mode:       'live' | 'history'
  session:    AgentSession           // 归一化 entries + streaming + meta
  actions:    AgentSurfaceActions

AgentSurfaceActions（只放当前真实用到的）
  newSession()
  openSession(id)
  startWorkflow(payload)
  review(action, payload)   // risk_confirmed / risk_ignored / risk_escalated / comment
  requestExport()
```

### 标准范式与自定义范式

| 类型 | 说明 | 定制自由度 |
| --- | --- | --- |
| `chat` | 平台标准消息流 + Composer（general 使用） | 低 |
| `workflow` | 平台提供步骤条/骨架，步骤视图由 Agent 自研（contract-review 使用） | 中 |
| `dashboard` | 平台提供骨架（预留，未落地） | 中 |
| `custom` | 整个页面由 Agent 自研，平台只保证契约 | 高 |

> 说明：就算是 `workflow` 标准范式，**每步的 StepView、步骤映射、业务模型仍归 Agent**，平台不预置合同步骤。任何 Agent 想做一个完全不同的个性化页面，只要满足薄契约即可进入平台。

## Subsystem 2: useAgentSession & Timeline Normalizer

### 职责

- 负责会话的打开 / 恢复 / 事件订阅 / 错误处理。
- live 模式：订阅事件流，增量更新 entries。
- history 模式：读取会话的 Pi JSONL，归一化为同一种 entries。
- 返回统一的 `AgentSession`（归一化 entries + streaming + meta），供 Surface 渲染。

### Timeline Normalizer 扩展

在已有的 `ChatEntry`（message / tool / event）基础上补充：

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

workflow_state
  stepId
  action        // risk_confirmed / risk_ignored / risk_escalated / comment / report_exported
  payload       // riskId / actor / note / path
```

### 权威顺序

```text
运行池实时状态  >  平台 DB 当前状态  >  Pi JSONL 历史
```

正常恢复时：JSONL 提供步骤时间线与业务状态；DB 提供索引；workspace 提供大文件。

## Subsystem 3: manifest → Surface Binding

### 职责

「哪个 agent 用哪个 surface」完全由 `manifest` 决定，因此不需要人工维护的「注册表层」。构建期根据所有 Agent 的 `manifest` 生成一份 `agentId → surface 组件` 绑定（或由 `import.meta.glob` 扫 `agents/*/manifest.yaml` 推导）：

- `surface.type === 'chat'` → 平台标准 ChatSurface。
- `surface.type === 'workflow'` → 平台 Workflow 框架 + Agent 提供的步骤视图。
- `surface.type === 'custom'` → 解析 `manifest.surface.entry`（agent 自定义页面）。

### 渲染机制（模板不 import agent 的原因）

`src/surface/` 只提供契约、会话 hook、归一化器与共享框架组件，**不含任何 agent 引用**。agent 的 surface 组件由「构建期生成的绑定」在 App 边缘解析出来，再直接渲染；没有统一的 `AgentSurfaceHost`（chat 与 workflow 布局差异大，不应塞进一个万能渲染器，各 surface 自行用共享框架组件拼装）。

```text
src/surface/                             模板：契约 + hook + 归一化器 + 共享框架组件（无 agent 引用）
src/platform/agent-surface-bindings.ts   构建期生成：agentId → %surface% 组件（唯一 import agents/**）
  general          -> standardChatSurface     （平台标准件）
  contract-review  -> ContractReviewSurface   （agent 自定义）
App.tsx            -> 取当前 agent 的绑定，直接渲染该 surface 组件
```

`App.tsx` 移除 `ContractSurface` / `GeneralChatSurface` 直接 import 与 `screen === 'general'` / `'contract-review'` 特判，改为「从生成绑定取当前 agent 的 surface 并渲染」。

## Subsystem 4: Contract Review Surface (Redesign)

### 交互主线

```text
头部（模型 / context / workspace 常驻）
步骤条（唯一、可点击、状态可回放，来源 = workflow 定义）
主区（随步骤切换）
右侧/绑定：风险概览（严重度计数、确认/忽略/升级状态）
```

### 步骤条（真实执行步骤，来自 workflow.yaml）

`解析 → 检索 → 抽取 → 比对 → 报告`

- **「导入/上传」不是步骤**：未开始审核时，主区即导入 + 审核基准配置的 CTA（空态即主入口）。点「开始」进入上面的执行步骤。
- **「复核」不是后端步骤，是独立的人工阶段面板**：管线完成（`report` 生成）后激活，门控导出；它写入 `workflow_state`。步骤条把它作为**终态人工关卡**（区别于执行步骤）呈现，不伪装成后端运行的假步骤。该顺序与产品文档「…生成报告 → 人工复核 → 审批导出」一致。
- 步骤状态：pending / active / done / failed；可点击查看该步的权威产出（未执行则显示「尚未执行」）。

### 每个步骤展示内容

| 步骤 | 展示内容 | 关键交互 |
| --- | --- | --- |
| 空态（导入） | 合同文件卡（名/大小/类型）+ **审核基准/风险域配置** + 开始 CTA | 拖入合同，选基准，开始审核 |
| 解析 | 结构化概览：当事人/日期/金额/文档类型/章节树 + 原文预览开关 | 校验解析质量 |
| 检索 | 命中的规则/法规/内部制度 + 覆盖度（已匹配 N 条 · 覆盖 x/x 风险域） | 展开命中依据 |
| 抽取 | 按类别（付款/违约/责任/终止/保密…）分组的条款，含位置 + 计数 | 展开原文 |
| 比对 | **风险评估卡片**：严重度徽标 + 原文+位置 + 命中规则 + 判断依据 + 建议；可按严重度/状态筛选 | 证据可展开 |
| 报告 | 结构化草稿报告（标题+分节+风险表格），标记为待复核 | 复核结论合并后为「复核后报告」 |
| 复核 | 审核员工作台：按严重度排序、批量确认/忽略/升级/备注、进度「已复核 x / y」、写回 `workflow_state` | 合并进「复核后报告」，门控导出（导出触发审批提案） |

### 类型化业务态 schema（替换正则）

```text
RiskFinding
  id / title / level(high|mid|low) / clause / position / ruleId / ruleText
  reason / advice / status(none|confirmed|ignored|escalated) / note / actor / at

Report
  title / sections[{ heading, body }] / riskTable[RiskFinding[]] / reviewSummary
```

面层渲染该权威结构；LLM 文本只作为解释/旁注，不作为等级等结构化判断的依据。

## Subsystem 5: Live & History Replay

- **实时（live）**：`useAgentSession` 订阅事件流；步骤推进、工具卡片、增量消息实时更新。
- **历史（history）**：打开历史会话 → 读取 Pi JSONL → 归一化为同一 entries → 推导当前步骤 + 每步权威产出。默认「结果导向」，过程证据（消息/工具调用）折叠为可展开。
- 这既修复「显示不全」（从 JSONL 全量回放，而非内存残留），又修复「全是 MD 文字」（渲染结构化权威状态，LLM 文本做旁注）。

## Fixes to Existing Bugs

- 合并重复的 3 套步骤指示（`WorkflowStatus` + `WorkflowSteps` + `contract-step-nav`）→ 唯一一条可点击步骤条。
- `StepViews` 的 `<pre> JSON` → 真结构化视图。
- 报告纯文本 → 结构化排版，内部段落用现有 `Markdown` 组件渲染。
- 「导出报告 · 需审批」→ 真正 `requestApproval` 发导出提案，而非跳审批中心。
- 复核确认/忽略/升级 → 写 `workflow_state` 持久化，并合并进最终报告/导出。
- 多会话隔离：state 按 `sessionId` 隔离，不再用全局单例。
- 头部补齐模型 / context / workspace 信息（只读优先，交互式模型选择按需后置）。
- 边界所需的公共件下沉：把被多个 surface 共享的展示件（`Markdown`、`ToolCard`、`LifecycleCard`、步骤条）从 `apps/desktop/src/workbench` 提升到 `@sparkii/ui`，使平台与 Agent surface 都能使用，而不跨越边界。

## Error Handling

- **模型能力不满足**：允许选择，但显示警告，说明会丢失的能力。
- **模型连接失败**：平台错误中心记录，同时通知受影响 Agent。
- **Pi JSONL 损坏或缺失**：DB 仍能恢复索引；Agent surface 显示「历史过程不完整」。
- **workspace 文件缺失**：显示文件缺失状态，不伪造结果。
- **workflow 失败**：记录 `workflow_step_end` 的失败状态，并在对应步骤显示错误。
- **审批拒绝**：权威结果以平台审计和 JSONL 为准；界面不显示「已执行」。
- **恢复的历史会话若步骤未执行**：显示「尚未执行」，不展示超前的占位。

## Testing Strategy

- **manifest→surface 绑定**：由 `manifest.surface.type` / `entry` 正确推导出组件；standard vs custom 分支无误。
- **Timeline Normalizer**：从 JSONL 的 `workflow_step_start/end` 切片步骤，从 `workflow_state` 恢复复核状态。
- **useAgentSession**：live 订阅与 history 回放产生同一 entries；会话隔离。
- **Contract Review Surface**：步骤切换、完成态回溯、模型/context/workspace 展示、风险复核（确认/忽略/升级/备注）、报告导出审批；空态 CTA。
- **安全不变量**：拒绝的写不执行；所有写尝试有审计；步骤状态不依赖 LLM 文字叙述。

## Out of Scope

- 运行时插件安装、动态加载和 side-load。
- 通用 widget / 组件引擎（超出当前薄契约所需的共享展示件）。
- dashboard / 其它未来 surface 的落地。
- 多模型并行、自动成本计算、复杂能力推断。
- 客户交付时的 Delivery Manifest（本次只预留概念，单独出 spec）。
- 交互式模型选择 / context 仪表（workflow surface 上，若有需要再后置）。
- 硬沙箱、SSO/LDAP/AD、集中审计等既有规划项。

## Phasing / Delivery Order

- **M1（地基）**：薄契约 + `useAgentSession` + 会话流归一化器扩展 + manifest→surface 绑定（构建期生成，删掉 App.tsx 硬编码）；把 ChatSurface 抽成平台标准件。
- **M2（合同审核实例 · live）**：唯一执行为 workflow 定义的步骤条、结构化 StepView、Markdown 报告、真实导出审批、复核回写、类型化业务态 schema（替换正则）、空态 CTA。
- **M3（合同审核 · history）**：打开历史会话 → 从 JSONL 归一回放 → 推导当前步骤 + 每步权威产出；默认结果导向、过程证据可展开。
- **M4（可选 / 清理）**：通用 chat surface 收敛到同一契约（低优先级，按需做）。

## Self-Review Notes

- 本 spec 收紧为「薄模板 + 单一事实源步骤条 + 类型化业务态 + 明确非目标」，避免万能 SurfaceHost 与虚假步骤的过度设计。
- `general` 作为普通 Agent，使用平台标准 `chat` surface，无 `alwaysIncluded` / `kind: base` 特殊身份。
- 逻辑上只有一份 Surface 契约；标准范式与自定义范式都通过它接入。
- `workflow_step_start/end` 建立时间线，`workflow_state` 补充用户复核与产物路径，避免解析模型自由文本。
- 「导入/上传」「审批导出/审计留痕」明确为前置态/动作，不进入步骤条；「复核」为独立阶段面板。
- Delivery Manifest 明确列为 out of scope，避免本 spec 过度扩张。
