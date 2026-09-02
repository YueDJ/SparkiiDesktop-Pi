# Agent Surface Thin Contract & Custom Surface Extension — Design Addendum

**Status:** Draft (pending human review) — 补充主 spec `docs/superpowers/specs/2026-09-02-agent-surface-template-and-contract-review-design.md`。
**Date:** 2026-09-02
**Branch:** `codex/agent-surface-template-contract-review`

## Goal

解决上一轮实现暴露的设计张力：**通用薄契约 `AgentSurfaceProps` 如何与自定义 surface（如合同审核）的专属状态/动作共存**，既要保持契约「薄」（不变成 god-object），又要让自定义 surface 能统一消费会话流（live/history 同源），从而落实跟进偏差 #3 与 #4。

## Background / Tension

主 spec 定义了统一契约：

```text
AgentSurfaceProps
  agent / sessionId / mode / session(AgentSession) / actions(AgentSurfaceActions)
```

合同审核是 `workflow` 自定义 surface。尝试让 `ContractSurface` 完全消费 `session`/`actions` 时，发现三块内容不属于通用契约：

1. **输入文件 `documents`**：工作流的输入合同文件路径，用于「原文」标签页与发起工作流。
2. **文件选择动作**：`api.chooseDocument`（系统文件对话框），不在 `AgentSurfaceActions` 内。
3. **surface 本地 UI 状态**：`tab`（报告/原文）、`selectedStep`、`reviewed`，属页面本地交互态。

若把 1/2/3 都塞进通用契约，`AgentSurfaceActions`/`AgentSession` 会被撑厚、携带合同专属语义，违背「薄契约、避免过度设计」。

## Proposed Resolution：能力下沉 + 会话流承载

原则：**通用契约只携带「平台级通用能力 + 会话流」；surface 专属的交互态留在 surface 内部；自定义 surface 的输入数据由会话流/会话元数据承载。**

### 改动 1：`AgentSurfaceActions` 增加平台级通用能力

文件输入是平台能力（与已有 `chooseWorkspace` 同级），下沉到通用 actions：

```text
AgentSurfaceActions
  newSession()
  openSession(id)
  startWorkflow(payload)
  review(action, payload)      // risk_confirmed / risk_ignored / risk_escalated / comment
  requestExport()
  chooseDocument()             // 新增：平台文件对话框，返回 { path?: string }
```

### 改动 2：`AgentSession` 用 `meta`/`inputs` 承载输入文件

输入文件是会话/工作区的一部分，不放在游离的 `state`：

```ts
interface AgentSessionMeta {
  model?: string | null;
  contextUsage?: ...;
  workspacePath?: string | null;
  currentStep?: string | null;
  inputs?: { path: string; name?: string }[];   // 会话输入文件（由平台从 workspace/DB 暴露）
}
```

`useAgentSession` 在打开会话时从 `api.openChatSession`/`getChatSession` 填充 `meta.inputs`；发起工作流时，surface 用 `actions.startWorkflow({ documents: inputs.map(i => i.path) })`。

### 改动 3：surface 本地交互态不进契约

`tab` / `selectedStep` / `reviewed` 保持为 `ContractAgentSurface` 内的 React 本地状态（`useState`），不进入 `AgentSurfaceProps`。契约不承载任何 surface 专属交互态。

## 边界与分工

```text
平台（模板/契约）
  AgentSurfaceProps 一律提供 agent/sessionId/mode/session/actions
  actions 只含平台级能力：newSession/openSession/startWorkflow/review/requestExport/chooseDocument
  session.meta.inputs 由平台暴露输入文件

合同审核 surface（自定义）
  消费 session.entries（deriveWorkflowTimeline/extractWorkflowResult 推导步骤与结果）
  session.meta.currentStep/status/inputs 驱动步骤条与原文
  actions.startWorkflow/review/requestExport/chooseDocument 驱动按钮
  tab/selectedStep/reviewed 为本地 useState，不回传
```

## 对偏差的承接

- **#3 统一会话流**：合同 surface 改为 `ContractAgentSurface(AgentSurfaceProps)`，从 `session` 推导一切；live 的 workflow/state 事件经 `useAgentSession` 汇入 `session.status/result`，history 经 `openChatSession` 汇入 `session.entries`。移除 App 侧游离 `state`/`workflow` 对 contract surface 的特判。
- **#4 App 仅按 manifest 解析**：App 渲染 `ContractAgentSurface` 时只传 `agent/sessionId/mode/session/actions`（统一契约），不再给 contract surface 传 `state/workflow` 专属 props；`ContractSurface` 旧入口仅作为向后兼容适配器。

## Testing

- `useAgentSession`：live `workflow`/`state` 事件正确汇入 `session.status/result`；history `openChatSession` 正确回放 `entries` 与 `meta.inputs`。
- `ContractAgentSurface`：仅凭 `session`/`actions` 渲染（步骤条、原文、报告、风险复核、导出），不依赖 `state`/`workflow` 专属 props。
- 回归：`contract-surface` 既有用例经 `ContractSurface` 适配器通过；`app-workflow`/`app-general` 全绿。
- 边界不变：agent surface 仍不 import `src/composer`/`src/workbench`。

## Non-Goals

- 不引入「自定义 surface 专属字段」进通用契约。
- 不为 `tab`/`selectedStep`/`reviewed` 这类纯交互态设计持久化/回传机制。
- 不改动通用智能体的 chat 收敛（该项仍为独立大改动，计划见 `plans/2026-09-02-agent-surface-followups.md` M-D）。

## Self-Review Notes

- 本 addendum 用「平台能力下沉 + 会话流承载」化解张力，避免把薄契约撑成厚契约；通用契约只增 `chooseDocument` 与 `meta.inputs` 两个平台级能力。
- surface 专属交互态明确留在 surface 本地，符合「Agent 可完全自定义页面」的原则。
- 为 M-B/M-C 指明了落点；M-D（通用 chat 收敛）作为独立大项保留。
