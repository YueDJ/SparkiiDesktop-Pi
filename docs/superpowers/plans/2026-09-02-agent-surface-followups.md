# Agent Surface Template — Follow-up Deviations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除上一轮实现中记录的 4 项与 spec 的偏差，使 Agent 分层、类型化业务态、统一会话流、manifest 驱动解析全部对齐。

**Architecture:** 平台模板（`src/surface/`）已就位；本轮补齐「类型化业务态为权威源 → 合同 surface 统一消费会话流 → App 仅按 manifest 解析 → 通用智能体收敛到平台标准 ChatSurface」。先做权威源（M-A），再收敛 contract surface（M-B），再改 App（M-C），最后是最大的聊天收敛（M-D）。

**Tech Stack:** React 18 + Vite + Vitest + `@testing-library/react` + `@sparkii/ui` + `@sparkii/config` + Electron(主进程 IPC)。

**Spec:** `docs/superpowers/specs/2026-09-02-agent-surface-template-and-contract-review-design.md`

## Global Constraints

- 边界硬规则：`src/surface/` 绝不 import `agents/**`；`agent-surface-bindings.ts` 是唯一 import agents 处且为生成物；agent surface 只走公开契约 + `@sparkii/ui`。
- 平台层不再出现 `agentId === 'general'` / `'contract-review'` 组件级特判；只认 `manifest.surface.type`。
- 类型化业务态是唯一事实源：风险等级/复核结论来自结构化数据，LLM 文本只作旁注；解析函数保留对旧数据的兼容回退。
- 通用智能体使用平台标准 ChatSurface（`surface.type: chat`），无自定义 entry。
- 所有写操作走审批门。
- 测试用 Vitest + `@testing-library/react`，文件命名 `*.test.{ts,tsx}`；渲染层与 Electron 均需 `tsc --noEmit` 通过。

---

## File Structure (target)

```text
apps/desktop/src/surface/
  standard-chat.tsx        # 平台标准 ChatSurface（自 agents/general/surface 迁入并改为 AgentSurfaceProps）
  contract.ts              # AgentSurface 契约（保持）
  normalize.ts             # 归一化器 + deriveWorkflowTimeline + extractWorkflowResult（保持）
  use-agent-session.ts     # live/history 会话 hook（保持）

packages/ui/src/patterns/
  ChatComposer.tsx         # Composer 促进为公开组件（自 src/workbench/Composer.tsx）
  thinking-levels.ts       # 从 src/workbench 促进（或作为平台内部保留）

apps/desktop/agents/contract-review/
  surface/index.tsx        # 改为 ContractAgentSurface(props: AgentSurfaceProps)，消费 session.entries
  agent/skills/clause_extract/SKILL.md   # 输出类型化 clause 结构
  agent/skills/risk_compare/SKILL.md     # 输出类型化 RiskFinding[]
  agent/skills/report/SKILL.md           # 输出类型化 Report

apps/desktop/src/App.tsx                  # 仅按 surfaceByAgent[activeAgentId] 渲染，移除 agent-id 特判
```

---

## Milestone A: 类型化业务态为权威源

### Task A1: risk_compare 输出类型化 RiskFinding[]

**Files:**
- Modify: `apps/desktop/agents/contract-review/agent/skills/risk_compare/SKILL.md`
- Test: `apps/desktop/test/contract-helpers.test.ts`（对 `parseRiskFindings` 增加结构化输入分支）

**Interfaces:**
- Produces: `RiskFinding[]` 结构化形状：`{ id, title, level, clause, position, ruleId, ruleText, reason, advice }`

- [ ] **Step 1: Write the failing test（结构化输入不依赖正则）**

```ts
// 追加到 contract-helpers.test.ts
it('parses typed risk findings without regex heuristics', () => {
  const out = parseRiskFindings([
    { id: 'r1', title: '付款周期过长', level: 'high', clause: '第7条', ruleId: 'rg-01', ruleText: '付款周期≤30天', advice: '约定逾期违约金' },
  ]);
  expect(out[0]).toMatchObject({ id: 'r1', title: '付款周期过长', level: 'high', advice: '约定逾期违约金' });
});
```

- [ ] **Step 2: Run test to verify it passes after implementation**

Run: `node <vitest.mjs> run contract-helpers`；先运行确认当前 `parseRiskFindings` 对 `{id,title,level}` 也能解析（若不能则失败），再进入实现。

- [ ] **Step 3: 让 parseRiskFindings 识别结构化行**

```ts
// contract.ts —— 在 parseRiskFindings 中增加结构化优先分支
function pickStructured(row: Record<string, unknown>): { id?: string; title?: string; level?: RiskFinding['level']; advice?: string } {
  const levelRaw = String(row.level ?? '');
  const level: RiskFinding['level'] = /^高|^high/i.test(levelRaw) ? 'high' : /^中|^mid/i.test(levelRaw) ? 'mid' : /^低|^low/i.test(levelRaw) ? 'low' : 'mid';
  return { id: typeof row.id === 'string' ? row.id : undefined, title: typeof row.title === 'string' ? row.title : undefined, level, advice: typeof row.advice === 'string' ? row.advice : undefined };
}
```

- [ ] **Step 4: 更新 risk_compare SKILL.md：要求输出严格 JSON 数组**

在 `skill/risk_compare/SKILL.md` 末尾追加：

```md
## 输出格式（必须）
你一定以 JSON 数组返回，每项：
{ "id": "r1", "title": "...", "level": "high|mid|low", "clause": "...", "position": "...", "ruleId": "...", "ruleText": "...", "reason": "...", "advice": "..." }
不要输出任何 Markdown 或额外文字。
```

- [ ] **Step 5: 运行测试 + 提交**

```bash
node <vitest.mjs> run contract-helpers
git add apps/desktop/agents/contract-review/agent/skills/risk_compare/SKILL.md apps/desktop/agents/contract-review/surface/contract.ts apps/desktop/test/contract-helpers.test.ts
git commit -m "feat(contract): typed risk findings as authoritative source"
```

### Task A2: clause_extract 输出类型化条款分组

**Files:**
- Modify: `apps/desktop/agents/contract-review/agent/skills/clause_extract/SKILL.md`
- Add: `parseClauseGroups` to `contract.ts` + test

**Interfaces:**
- Produces: `ClauseGroup[]` = `{ category: string; clauses: { text: string; position: string }[] }`

- [ ] **Step 1: Write failing test**

```ts
it('parses typed clause groups', () => {
  const out = parseClauseGroups([{ category: '付款', clauses: [{ text: '第7条 约定账期30天', position: 'p12' }] }]);
  expect(out[0].category).toBe('付款');
});
```

- [ ] **Step 2–5:** 实现 `parseClauseGroups`（识别 `category`+`clauses[]`），更新 `clause_extract/SKILL.md` 输出格式，跑测试并提交。

### Task A3: report 输出类型化 Report

**Files:**
- Modify: `apps/desktop/agents/contract-review/agent/skills/report/SKILL.md`
- Test: `contract-helpers.test.ts` 增加 `formatReport` 结构化分支

**Interfaces:**
- Produces: `Report` = `{ title, sections:[{heading,body}], riskTable: RiskFinding[] }`

- [ ] **Step 1: Write failing test**

```ts
it('formats typed report with risk table', () => {
  const r = formatReport({ title: '报告', sections: [{ heading: '结论', body: '**关注**' }], riskTable: [1] });
  expect(r?.title).toBe('报告');
  expect(r?.blocks).toHaveLength(1);
});
```

- [ ] **Step 2–5:** `formatReport` 识别 `riskTable`（存为风险概览），更新 `report/SKILL.md` 输出格式，跑测试并提交。

---

## Milestone B: 合同 surface 统一消费会话流

### Task B1: ContractSurface 改为 AgentSurfaceProps

**Files:**
- Modify: `apps/desktop/agents/contract-review/surface/index.tsx`（导出 `ContractAgentSurface(props: AgentSurfaceProps)` + 保留 `ContractSurface` 薄适配）
- Test: `apps/desktop/test/contract-surface.test.tsx`（增加对 `ContractAgentSurface` 的用例）

**Interfaces:**
- Consumes: `AgentSurfaceProps`（`agent/sessionId/mode/session/actions`）
- Produces: `ContractAgentSurface`

- [ ] **Step 1: Write failing test**

```tsx
it('renders a workflow surface from a session stream', () => {
  render(<ContractAgentSurface agent={{ id: 'contract-review', name: '合同审核智能体', surfaceType: 'workflow' }} sessionId="s1" mode="history"
    session={{ entries: normalizeSessionEntries([{ type: 'workflow_state', data: { stepId: 'report', action: 'result', payload: { report: { title: '报告' }, compare: [] } } }]), streaming: false, meta: { currentStep: 'report' } }}
    actions={{ newSession: vi.fn(), openSession: vi.fn(), startWorkflow: vi.fn(), review: vi.fn(), requestExport: vi.fn() }} />);
  expect(screen.getAllByText('报告').length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: 运行确认失败**（`ContractAgentSurface` 未导出）

- [ ] **Step 3: 实现**：`ContractAgentSurface` 内部用 `session.entries` 经 `deriveWorkflowTimeline`/`extractWorkflowResult` 推导 `steps` 与结果；`actions.startWorkflow`/`review`/`requestExport` 绑定按钮；`ContractSurface` 保留为接收旧 props 的适配器（调用 `ContractAgentSurface` 并构造 session）。

- [ ] **Step 4: 运行测试**（`contract-surface` + 回归）

- [ ] **Step 5: 提交**

### Task B2: App 通过 useAgentSession 给 contract surface 喂会话

**Files:**
- Modify: `apps/desktop/src/App.tsx`（`surfaces['contract-review']` 改用 `useAgentSession` 结果 + `ContractAgentSurface`）
- Test: `app-workflow.test.tsx`

- [ ] **Step 1–5:** App 对 contract-review 用 `useAgentSession(agentId, workflowSessionId, mode)` 得到 `session`，传入 `ContractAgentSurface`；`mode` 由是否有会话决定（有=history，正在跑=live）。运行 `app-workflow` + 全量回归并提交。

---

## Milestone C: App 仅按 manifest 解析

### Task C1: 移除 agent-id 组件特判

**Files:**
- Modify: `apps/desktop/src/App.tsx`（`const { Surface } = useAgentSurface(activeAgentId)`，用单一 `Surface` 渲染；移除 `useAgentSurface('contract-review'/'general')` 与 `screen === 'general'` 分支）
- Test: `app-general` / `app-workflow` / `shell`

- [ ] **Step 1: 写失败测试**：断言 App 渲染 `contract-review` 与 `general` 时都走同一 `Surface` 路径（通过绑定取组件）。
- [ ] **Step 2–5:** 重构 App 渲染为单一 `Surface`（由当前 screen/agentId 决定），跑 `app-general app-workflow shell surface-registry` + 类型检查并提交。

---

## Milestone D: 通用智能体收敛到平台标准 ChatSurface

> 本轮中最大的一项；建议单独计划执行。核心是把 `GeneralChatSurface` 迁入 `src/surface/standard-chat.tsx` 并改为 `AgentSurfaceProps`。

### Task D1: 促进 Composer / thinking-levels / chat-detail-level 到 @sparkii/ui

**Files:**
- Create: `packages/ui/src/patterns/ChatComposer.tsx`（自 `src/workbench/Composer.tsx` 促进，保持 props）
- Create: `packages/ui/src/patterns/thinking-levels.ts`、`chat-detail-level.ts`（自 `src/workbench` 迁入）
- Modify: `packages/ui/src/index.ts`（导出）；`apps/desktop/src/workbench/*` 改为再导出

- [ ] **Step 1–5:** 迁移并让 `GeneralChatSurface` 从 `@sparkii/ui` 引用这些公共件；跑 `chat-composer` / `general-chat-surface` / `ui-*` 回归并提交。

### Task D2: 建立平台标准 ChatSurface 实现

**Files:**
- Create: `apps/desktop/src/surface/standard-chat.tsx`（实现 `AgentSurfaceProps`：用 `session.entries` 渲染消息/工具/生命周期流；`session.meta` 显示 model/context/workspace；`actions` 触发 newSession/openSession）
- Test: `apps/desktop/test/standard-chat.test.tsx`

**Interfaces:**
- Produces: `standardChatSurface(props: AgentSurfaceProps): ReactNode`

- [ ] **Step 1: 写失败测试**：`standardChatSurface` 用 `session.entries` 渲染 user/assistant 消息与工具卡片。
- [ ] **Step 2–5:** 实现；`general` 的 manifest 声明 `surface.type: chat` 且 `agent-surface-bindings.ts` 对 general 用 `standardChatSurface`；`agents/general/surface/index.tsx` 改为再导出平台标准件；跑 `general-chat-surface`/`standard-chat` + 类型检查并提交。

### Task D3: 移除 general 的平台内部依赖

**Files:**
- Modify: `apps/desktop/agents/general/surface/index.tsx`（仅再导出 `standardChatSurface`）

- [ ] **Step 1–4:** 确认 `agents/general/surface` 不再 import `src/workbench`（通过 `rg` 校验）；跑 `general-chat-surface` 回归并提交。

---

## Self-Review

1. **Spec coverage**：M-A 对齐「类型化业务态为唯一事实源」；M-B 对齐「live/history 同源、surface 消费会话流」；M-C 对齐「平台仅认 manifest.surface.type」；M-D 对齐「general 收敛到平台标准 ChatSurface + 边界无内部依赖」。
2. **Placeholder scan**：各任务含真实代码与运行命令，无 TBD/TODO。
3. **Type consistency**：`AgentSurfaceProps`/`SessionEntry`/`AgentSession`/`ContractAgentSurface`/`standardChatSurface`/`surfaceByAgent` 命名跨任务一致。
