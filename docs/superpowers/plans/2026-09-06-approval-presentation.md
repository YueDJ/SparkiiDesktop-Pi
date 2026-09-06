# Approval Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 审批弹出按平台契约展示：`summary` 原样当标题，可选 `preview.lines` 默认 5 行可展开，按钮「拒绝 / 允许」。审批 UI 不猜业务 payload。

**Architecture:** `Proposal` / `ProposalRequest` 增加可选 `preview`（不进 `payloadHash`）。提交端填契约。所有审批表面只调 `present()`。Gate / Executor 不解释 `preview`。

**Tech Stack:** TypeScript、Vitest、React Testing Library。`pilot.spec.ts` 按钮从「批准」改为「允许」。

**Spec:** `docs/superpowers/specs/2026-09-06-approval-presentation-design.md`

## Global Constraints

- 审批 UI / `present()` 不读 `payload.diff` / `command` / `sections`。
- 不按 `toolName` / `profileId` / agent id 做**卡片**模板。提交端可以为已知平台工具（`report.export`、`edit`/`write`）填契约。
- 不改审批频率、会话授权。例行到达仍自动开抽屉；高风险改走模态（壳层，不是降频）。
- 不改超时自动拒绝。例行不显示倒计时数字，但必须保留隐藏到期 → `onDecide(id, false, 'timeout')`。Main `gate.expire` 不推 renderer，本切片不新做 expire IPC。
- 不改只读白名单、导出保存对话框。
- 不新增依赖、不新包。
- 测试按新契约改，不放宽。安全不变量测试不改语义。

---

## File Structure

```text
packages/approval/src/proposal.ts
packages/approval/src/index.ts
packages/approval/test/proposal.test.ts

packages/agent-host/src/write-tool-presentation.ts   # 新建：report.export 等连接器写工具
packages/agent-host/test/write-tool-presentation.test.ts
packages/agent-host/src/coding-tools.ts
packages/agent-host/src/pi-runtime-tools.ts
packages/agent-host/test/coding-tools.test.ts
packages/agent-host/test/pi-runtime-tools.test.ts

apps/desktop/src/trust/present.ts                  # 新建
apps/desktop/test/approval-present.test.ts           # 新建
apps/desktop/src/trust/types.ts
apps/desktop/src/trust/ApprovalPanel.tsx
apps/desktop/src/trust/ApprovalModal.tsx
apps/desktop/src/trust/ApprovalCenter.tsx
apps/desktop/src/platform/HomeView.tsx
apps/desktop/src/App.tsx
packages/ui/src/patterns/ApprovalItem.tsx          # 保持哑组件

apps/desktop/electron/main/workflow.ts
apps/desktop/electron/main/ipc.ts
DESIGN.md
PRODUCT.md
```

测试还改：`approval-trust.test.tsx`、`approval-diff.test.tsx`、`home-view.test.tsx`、`ui-business-patterns.test.tsx`、`workflow-broker.test.ts`、`e2e/pilot.spec.ts`。

不改：`gate.ts` 决策、`executor.ts`、审计 schema、`ApprovalDialog.tsx`、Agent 包业务 UI、设置页「可批准」说明。

---

### Task 1: 契约类型 — `preview` 进提案、不进哈希

**Files:** `packages/approval/src/proposal.ts`、`index.ts`、`test/proposal.test.ts`

```ts
export type ApprovalPreviewKind = 'diff' | 'text';
export interface ApprovalPreview { kind: ApprovalPreviewKind; lines: string[]; }
```

`ProposalRequest` 与 `Proposal` 都加可选 `preview`。`createProposal` 原样拷贝 `preview`，**不要**写进 `payload`。`hashPayload` 仍只哈希 `payload`。

```ts
export function toPreviewLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
```

提交端用 `toPreviewLines`。UI **禁止**用它从 payload 切片。

- [ ] 测试：`createProposal` 保留 `preview`；同 payload 不同 preview → `payloadHash` 相同；`toPreviewLines('a\nb\n')` → `['a','b']`。
- [ ] 实现并跑 `pnpm --filter @sparkii/approval test`。

---

### Task 2: `present()` 纯函数

**Files:** `apps/desktop/src/trust/present.ts`、`test/approval-present.test.ts`

`PREVIEW_VISIBLE_LINES = 5`。只读 `summary` / `preview` / `risk`。非 `high-risk`（含 `write`、`read`）走 panel。

- [ ] 测试：原样 summary；空白 →「需要你确认」；无 preview → `none`；payload 有 `diff` 无 preview → 仍 `none`；8 行 → visible 5、hidden 3；high-risk → modal + 三 show*；write → panel 且 showCountdown **false**（隐藏到期是组件的事，不在 present 里造定时器）；按钮「拒绝」「允许」「再次确认允许」。
- [ ] 实现（无 React）。
- [ ] 跑 `pnpm exec vitest run apps/desktop/test/approval-present.test.ts`。

---

### Task 3: 审批表面改用 `present()`

**Files:** Panel / Modal / Center / HomeView / `types.ts`（`ApprovalProposalLike` 加可选 `preview`）

**`ApprovalItem`（packages/ui）保持哑：** `title` + 可选 `badge` / `countdown` / `meta` slot。**不要** `if (risk === 'high-risk')`。`ApprovalCenter` / `HomeView` 先 `present()`，再把算好的 chrome 传下去。

面板：

- 标题「需要你确认」；「N 处改动等你看」/「暂无待确认」。
- 只渲染壳层传入的**例行**提案。
- 预览默认 5 行；`hiddenCount > 0` →「还有 N 行 · 展开」；`kind === 'diff'` 用 `DiffView` 拼 `visibleLines.join('\n')`。
- 「技术细节」默认关 = payload JSON。
- 例行：不渲染倒计时数字、意见、中风险、工具名；按钮「拒绝」「允许」。
- **隐藏到期：** 继续用 `Countdown`（`aria-hidden` / 视觉隐藏）或等价 `useEffect`，`onExpire → onDecide(id, false, 'timeout')`。不得删除这条路径。

模态：高风险徽标 + 可见倒计时 + 意见；第一次「允许」→「再次确认允许」。

**反转 `approval-diff.test.tsx`：**

- 有 `payload.diff`、无 `preview` → **没有** `DiffView`
- 有 `preview.kind === 'diff'` → 默认可见 `DiffView`（不必点技术细节）

`ui-business-patterns.test.tsx` 改为断言哑 `ApprovalItem` 不再要求 toolName/UUID/例行 countdown。

- [ ] 改测试再改组件。
- [ ] 跑 `approval-trust` / `approval-diff` / `home-view` / `ui-business-patterns`。

---

### Task 4: 壳层按 `risk` 拆抽屉 / 模态

**Files:** `apps/desktop/src/App.tsx` + 审批壳层测试（扩 `approval-trust` 或小的 App 测试，**不要**指望现有 `app-*.test.tsx` 已覆盖）

```ts
const routine = pending.filter((p) => present(p).chrome.mode === 'panel');
const highRisk = pending.filter((p) => present(p).chrome.mode === 'modal');
```

必须覆盖：

1. 高风险到达 → `ApprovalModal`；`routine.length === 0` 时 **不开空抽屉**。
2. 例行 + 高风险：抽屉只有 write，模态叠 high-risk；决定仍逐条 `decideApproval`。
3. 审批中心点「详情」：高风险不推进 `ApprovalPanel`。
4. **关抽屉条件是 `routine.length === 0`**，不是 `pending.length === 0`（只剩高风险时不要空抽屉衬在模态后）。
5. 多条高风险：只展示 `highRisk[0]`，决定后再下一条。不做 batch。

例行 `approval` 事件仍 `setApprovalOpen(true)`。高风险事件不因此打开抽屉。

- [ ] 先写上述五条测试，再改 `App.tsx`。

---

### Task 5: 提交端填契约

**不变量：**

- Pi `coding-tools`：bash 填 summary+text preview；edit/write **只**填 summary（`修改 ${rel}` / `写入 ${rel}`），**不填 preview**。
- `broker.route`：仅当 `toolName === 'edit'|'write'` 且 `req.preview` 为空，用**自己刚算的** diff 字符串 `toPreviewLines(diff)`。已有 preview 不覆盖。禁止 `if (payload.diff|command|sections)` 泛扫描。
- 新智能体自己的 `propose()` 带齐字段；不要指望 broker 代填。
- 不要第三处再算 diff（present / Pi 都不要）。

**`writeToolPresentation(toolName, args)`**（`packages/agent-host`，无新包）：

- `report.export`：`title` 非空 → `导出《${title}》`，否则「导出报告」；`preview.lines` = 非空 heading。
- 其它写工具：`summary = toolName`，无 preview。禁止 `JSON.stringify(params)`。

`pi-runtime-tools`、`workflow.ts` `runTool`、`ipc.ts` `requestExportReport` **都走这个函数**。

- [ ] 失败测试：coding-tools summary/bash preview、edit 无 preview；broker 在 edit 上补 diff preview 且不覆盖已有 preview；hash 仍只盖 payload；三处 `report.export` 标题一致且 summary 不含 `{`。
- [ ] 实现。
- [ ] 跑 agent-host 与 `workflow-broker` 测试。

---

### Task 6: e2e 按钮文案

**Files:** `apps/desktop/e2e/pilot.spec.ts`：`name: '批准'` → `name: '允许'`。

Pilot 仍 `getByRole('dialog')`（抽屉也是 dialog）。例行导出仍走抽屉，不要改成只认 Modal。`general.spec.ts` 无审批，不动。

- [ ] 改 e2e。能跑则跑 `playwright test e2e/pilot.spec.ts`；跑不了在 PR 注明。

---

### Task 7: 文档与本 spec 对齐（很小）

**Files:** `DESIGN.md` Approval Ritual；`PRODUCT.md` 审批倒计时那句。

- 例行：标题、可选 5 行预览、技术细节、拒绝/允许；高风险才倒计时/意见/二次确认。
- PRODUCT：高风险倒计时可见；例行超时仍生效但不放主视觉。
- 不借机改会话授权或自动弹抽屉。

- [ ] 改两处文案，与 spec 一致即可。

---

## Self-Review

- Architect 已审：隐藏超时回调、edit/write preview 单点填写、`report.export` 三处共用、反转 payload.diff 测试、ApprovalItem 保持哑、关抽屉看 `routine.length`、Proposal.preview 显式拷贝。
- `preview` 不进哈希；Renderer 仍只 `decideApproval`。
- 无 TBD。`ApprovalDialog.tsx` 明确不改。
- 合同审核发现列表的「中风险」不是审批徽标，不在本计划。
