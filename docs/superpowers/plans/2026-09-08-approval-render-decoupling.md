# 审批渲染解耦 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把审批的「逻辑/事实源」与「渲染位置/形态」解耦：平台保留 gate + 收件箱 + 兜底抽屉 + 高风险弹窗，通用智能体经 `useSessionApprovals(sessionId)` 内联审批卡。

**Architecture:** renderer 内新增单一 `ApprovalInbox`（全量 pending 缓存 + `Set` 认领 + session 路由），`useSessionApprovals` 是它的派生视图。`Proposal` 增加必填 `requestId` 作为 gate↔JSONL↔ToolCard 的关联键。超时由 Main 权威推送 `expired`，renderer 只展示。`InlineApprovalCard` 挂载即认领，卸载即释放。

**Tech Stack:** TypeScript、React 19、Vitest、React Testing Library。

**Spec:** `docs/superpowers/specs/2026-09-08-approval-render-decoupling-design.md`

## Implementation Checklist（实现清单）

| # | 改动 | 文件 |
| --- | --- | --- |
| 1 | `ProposalRequest`/`Proposal` 增加必填 `requestId` | `packages/approval/src/proposal.ts` + 测试 |
| 2 | broker 透传 `requestId`，超时仅在真过期时推 `expired` | `apps/desktop/electron/main/workflow.ts` + 测试 |
| 3 | `ChatEntry` 工具项增加 `approvalRequestId?` | `packages/ui/src/patterns/pi-timeline.ts` |
| 4 | 投影时把 `requestId` 挂到对应工具卡 | `apps/desktop/agents/general/surface/approval-timeline.ts` + 测试 |
| 5 | 抽出纯展示 `ApprovalCard` | `apps/desktop/src/trust/ApprovalCard.tsx`（新） |
| 6 | 收件箱 store + `useSessionApprovals` | `apps/desktop/src/trust/ApprovalInbox.tsx`（新）+ 测试 |
| 7 | `InlineApprovalCard` = `ApprovalCard` + 自动认领 | `apps/desktop/src/trust/InlineApprovalCard.tsx`（新） |
| 8 | `ApprovalPanel` → `ApprovalDrawer`（只显示 unclaimed） | `apps/desktop/src/trust/` |
| 9 | `ApprovalModal` → `HighRiskApprovalDialog`（纯展示倒计时） | `apps/desktop/src/trust/` |
| 10 | `ApprovalCenter` 消费收件箱 | `apps/desktop/src/trust/ApprovalCenter.tsx` |
| 11 | `App.tsx` 包裹收件箱，删本地 pending/decide，接审计信号 | `apps/desktop/src/App.tsx` |
| 12 | 通用 surface + `StandardChatSurface` 内联渲染 | `agents/general/surface/*`、`src/surface/standard-chat.tsx` |

## Global Constraints

- `requestId` 必填、随 `Proposal` 透传、**不进 `payloadHash`**、**不进 09-06 展示契约**。
- 隔离是 renderer 封装边界，不是安全边界；Main 不新增 `sessionId` 过滤参数。
- `waiting` 只含 `status === 'pending' && risk !== 'high-risk' && sessionId` 匹配。
- 高风险永不认领、永不内联；恒走 `HighRiskApprovalDialog`。
- 同一提案同一时刻只有一张决策卡（内联或抽屉）。
- 超时只由 Main 权威推送；renderer 不再 `decide('timeout')`；`approved`/`executed` 不推、不 resolve。
- 不改 `ApprovalGate` 状态机 / RBAC / 审计语义（`requestId` 与超时推送除外）。
- 不改 09-06 JSONL 形状与 `present()` 展示契约。
- 合同审核智能体本轮零改动。

---

### Task 1: `Proposal` 增加必填 `requestId`

**Files:**
- Modify: `packages/approval/src/proposal.ts`
- Test: `packages/approval/test/proposal.test.ts`
- Test: `packages/approval/test/gate.test.ts`
- Test: `packages/approval/test/gate-multiprofile.test.ts`
- Test: `packages/approval/test/executor.test.ts`
- Test: `packages/approval/test/invariants.test.ts`

**Interfaces:**
- Consumes: 现有 `ProposalRequest` / `Proposal` / `createProposal`。
- Produces: `ProposalRequest.requestId: string`、`Proposal.requestId: string`，`createProposal` 复制 `req.requestId`。

- [ ] **Step 1: 改类型与 `createProposal`**

在 `packages/approval/src/proposal.ts`：

```ts
export interface ProposalRequest {
  requestId: string;           // 新增，必填关联键
  toolName: string;
  targetSystem: string;
  summary: string;
  preview?: ApprovalPreview;
  payload: unknown;
  risk: SideEffect;
}

export interface Proposal {
  id: string;
  requestId: string;           // 新增，必填
  profileId: string;
  sessionId: string;
  // ...其余不变
}

export function createProposal(req: ProposalRequest, meta: { profileId: string; sessionId: string }): Proposal {
  return {
    id: randomUUID(),
    requestId: req.requestId,   // 复制，不进 payloadHash
    ...meta,
    toolName: req.toolName,
    // ...其余不变
  };
}
```

- [ ] **Step 2: 更新测试夹具，补 `requestId`**

`proposal.test.ts` 中每个 `createProposal(...)` 的请求对象加 `requestId: 'r1'`。`gate.test.ts` / `gate-multiprofile.test.ts` / `executor.test.ts` / `invariants.test.ts` 中每个 `gate.submit({...})` 的请求对象同样加 `requestId: 'r1'`。并新增一条断言：

```ts
it('copies requestId onto the proposal without hashing it', () => {
  const payload = { path: 'a.txt' };
  const p = createProposal(
    { requestId: 'r42', toolName: 'write', targetSystem: 'general', summary: 'x', payload, risk: 'write' },
    { profileId: 'p', sessionId: 's' },
  );
  expect(p.requestId).toBe('r42');
  expect(p.payloadHash).toBe(hashPayload(payload));
});
```

- [ ] **Step 3: 跑测试确认失败/通过**

Run: `pnpm --filter @sparkii/approval test`
Expected: 通过（类型报错会先在 `pnpm --filter @sparkii/approval exec tsc --noEmit` 暴露，逐个补 `requestId`）。

- [ ] **Step 4: Commit**

```bash
git add packages/approval
git commit -m "feat(approval): add required requestId correlation key to proposals"
```

---

### Task 2: broker 透传 `requestId`，超时只在真过期时推 `expired`

**Files:**
- Modify: `apps/desktop/electron/main/workflow.ts`
- Test: `apps/desktop/test/workflow-broker.test.ts`

**Interfaces:**
- Consumes: `ProposalRequest.requestId`（Task 1）、`gate.expire` 返回 `expired`/原提案。
- Produces: `sparkii:event:approval` 在 `status === 'expired'` 时额外推送一次 `expired` 提案。

- [ ] **Step 1: 改超时回调**

`workflow.ts` 的 `broker.request` 定时器改为：

```ts
const timer = setTimeout(() => {
  void rt.gate.expire(p.id).then((expired) => {
    if (!expired) {
      resolvers.delete(p.id);
      resolve({ approved: false, proposalId: p.id, status: 'expired' });
      return;
    }
    if (expired.status === 'expired') {
      getWindow()?.webContents.send('sparkii:event:approval', expired);
      resolvers.delete(p.id);
      resolve({ approved: false, proposalId: p.id, status: 'expired' });
      return;
    }
    // approved/executed（长命令执行中）或仍未到期：不推、不 resolve，等 broker.decide 回真实结果
  });
}, rt.profileOf(meta.profileId).profile.security.approval.timeoutMs);
```

`request` 入参类型由 `ProposalRequest` 改为 `ProposalRequest & { requestId: string }`（Task 1 已把 `requestId` 并入 `ProposalRequest`，此处保持显式以明确 `route` 携带 requestId）。

- [ ] **Step 2: 加两条测试**

在 `workflow-broker.test.ts` 的 `broker approval timeout vs long-running execution` 中，`gateHarness` 的 `getWindow` 已有 `send` 探针。补：

```ts
it('pushes the expired proposal to the renderer only when truly expired', async () => {
  const { rt, gate, broker } = gateHarness(30);
  const sent: unknown[] = [];
  (broker as any).getWindow = () => ({ webContents: { send: (_c: string, p: unknown) => sent.push(p) } });
  const decision = broker.request({
    requestId: 'r3', toolName: 'bash', targetSystem: 'general', summary: 'sleep',
    payload: { command: 'sleep 1' }, risk: 'write',
  }, { sessionId: 's1', profileId: 'general' });
  await expect(decision).resolves.toEqual({ approved: false, proposalId: 'p1', status: 'expired' });
  expect(sent).toHaveLength(1);
  expect((sent[0] as any).status).toBe('expired');
});

it('does not push expired while an approved write is still executing', async () => {
  const timeoutMs = 30;
  const { rt, gate, broker } = gateHarness(timeoutMs);
  const sent: unknown[] = [];
  (broker as any).getWindow = () => ({ webContents: { send: (_c: string, p: unknown) => sent.push(p) } });
  const decision = broker.request({
    requestId: 'r4', toolName: 'bash', targetSystem: 'general', summary: 'pull',
    payload: { command: 'docker compose pull' }, risk: 'write',
  }, { sessionId: 's1', profileId: 'general' });
  await gate.decide('p1', rt.subject, true);
  await sleep(timeoutMs + 40);
  expect(sent).toHaveLength(0);
  broker.decide('p1', { approved: true, status: 'executed', result: { exitCode: 0 } });
  await expect(decision).resolves.toEqual({ approved: true, proposalId: 'p1', status: 'executed', result: { exitCode: 0 } });
});
```

注：现有 `createBroker(rt, getWindow)` 把 `getWindow` 闭包在内。为可测试，把 `getWindow` 存入 broker 返回对象的一个内部字段（`(broker as any).getWindow`）或改用注入；实现时选最小改法。

- [ ] **Step 3: 跑测试**

Run: `pnpm exec vitest run apps/desktop/test/workflow-broker.test.ts`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/electron/main/workflow.ts apps/desktop/test/workflow-broker.test.ts
git commit -m "feat(desktop): push expired proposal to renderer without preempting long-running execution"
```

---

### Task 3: `ChatEntry` 工具项增加 `approvalRequestId?`

**Files:**
- Modify: `packages/ui/src/patterns/pi-timeline.ts`

**Interfaces:**
- Produces: `ChatEntry` 的 `tool` 分支多一个可选 `approvalRequestId?: string`。

- [ ] **Step 1: 加可选字段**

在 `packages/ui/src/patterns/pi-timeline.ts` 的 tool 分支加一行：

```ts
  | {
      kind: 'tool';
      id: string;
      toolName: string;
      input: unknown;
      partialResult?: unknown;
      result?: unknown;
      isError?: boolean;
      awaitingApproval?: boolean;
      toolCallId?: string;
      approvalRequestId?: string;   // 新增
    }
```

- [ ] **Step 2: 类型检查**

Run: `pnpm --filter @sparkii/ui exec tsc --noEmit`（若该包有 typecheck 脚本则 `pnpm --filter @sparkii/ui run typecheck`）
Expected: 通过。

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/patterns/pi-timeline.ts
git commit -m "feat(ui): carry approval request id on tool entries"
```

---

### Task 4: 投影时把 `requestId` 挂到工具卡

**Files:**
- Modify: `apps/desktop/agents/general/surface/approval-timeline.ts`
- Test: `apps/desktop/agents/general/surface/approval-timeline.test.ts`

**Interfaces:**
- Consumes: `ChatEntry.approvalRequestId`（Task 3）。
- Produces: 工具卡在绑定 `approval_required` 后带 `approvalRequestId`。

- [ ] **Step 1: 在绑定处写入 `approvalRequestId`**

`applyApprovalStatus` 的 `approval_required` 分支，在 `awaitingApproval: true` 之外再加：

```ts
if (entry.customType === 'approval_required') {
  const i = takeTool(toolName, toolCallId);
  if (i < 0 || !requestId) continue;
  byRequestId.set(requestId, i);
  const tool = next[i];
  if (tool.kind === 'tool') next[i] = { ...tool, awaitingApproval: true, approvalRequestId: requestId };
  continue;
}
```

- [ ] **Step 2: 加测试断言**

在 `approval-timeline.test.ts` 补一条：required 绑定到工具卡后，该卡 `approvalRequestId === 'r1'`。

```ts
it('carries approvalRequestId onto the bound tool card', () => {
  const entries: SessionEntry[] = [
    { kind: 'tool', id: 't1', toolName: 'write', input: {}, toolCallId: 'c1' },
    { kind: 'custom', id: 'e1', customType: 'approval_required', data: { requestId: 'r1', toolName: 'write', status: 'pending', toolCallId: 'c1' } },
  ];
  const out = applyApprovalStatus(entries);
  expect((out[0] as any).approvalRequestId).toBe('r1');
});
```

- [ ] **Step 3: 跑测试**

Run: `pnpm exec vitest run apps/desktop/agents/general/surface/approval-timeline.test.ts`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/agents/general/surface/approval-timeline.ts apps/desktop/agents/general/surface/approval-timeline.test.ts
git commit -m "feat(general): attach approval request id to projected tool cards"
```

---

### Task 5: 抽出纯展示 `ApprovalCard`

**Files:**
- Create: `apps/desktop/src/trust/ApprovalCard.tsx`
- Modify: `apps/desktop/src/trust/ApprovalPanel.tsx`（本轮暂不改名，先抽出共用卡）

**Interfaces:**
- Produces: `ApprovalCard({ proposal, timeoutMs?, onDecide })` 纯展示，无认领、无自动打开。

- [ ] **Step 1: 建 `ApprovalCard`**

把现有 `ApprovalPanel.tsx` 的 `ApprovalQueueItem` 抽到 `ApprovalCard.tsx`，props 为 `proposal`、`onDecide`、`timeoutMs`。渲染 `present(proposal)` 的标题/预览/技术细节/按钮。**不内置倒计时 decide**（超时已由 Main 推送，展示层只做按钮）。

```tsx
import { useState } from 'react';
import { Button } from '@sparkii/ui';
import { present } from './present.js';
import { ApprovalPreviewBlock } from './ApprovalPreviewBlock.js';
import { payloadSummary, type ApprovalProposalLike } from './types.js';

export function ApprovalCard({ proposal, onDecide }: {
  proposal: ApprovalProposalLike;
  onDecide(id: string, approved: boolean, note?: string): void;
}) {
  const vm = present(proposal);
  const [showPayload, setShowPayload] = useState(false);
  return (
    <div className="ui-approval-queue-item" data-testid="approval-card">
      <div className="ui-approval-queue-item-title"><b>{vm.title}</b></div>
      <ApprovalPreviewBlock preview={vm.preview} />
      <button type="button" className="ui-btn ui-btn--sm ui-approval-queue-toggle" onClick={() => setShowPayload((v) => !v)}>
        技术细节 {showPayload ? '▾' : '▸'}
      </button>
      {showPayload && <pre className="ui-payload">{payloadSummary(proposal.payload)}</pre>}
      <div className="ui-panel-actions">
        <Button className="ui-panel-action" onClick={() => onDecide(proposal.id, false)}>{vm.actions.reject}</Button>
        <Button variant="primary" className="ui-panel-action" onClick={() => onDecide(proposal.id, true)}>{vm.actions.allow}</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 让 `ApprovalPanel` 复用**

`ApprovalPanel.tsx` 删除本地 `ApprovalQueueItem`，改用 `<ApprovalCard proposal={p} onDecide={onDecide} />`。保留现有 props 与分组逻辑，先不改变行为。

- [ ] **Step 3: 跑现有 trust 测试**

Run: `pnpm exec vitest run apps/desktop/test/approval-trust.test.tsx apps/desktop/test/approval.test.tsx apps/desktop/test/approval-shell.test.tsx`
Expected: 全绿（如 `data-testid` 由 `approval-queue-item` 改为 `approval-card` 需同步断言）。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/trust/ApprovalCard.tsx apps/desktop/src/trust/ApprovalPanel.tsx
git commit -m "refactor(desktop): extract pure ApprovalCard from drawer queue item"
```

---

### Task 6: `ApprovalInbox` + `useSessionApprovals`

**Files:**
- Create: `apps/desktop/src/trust/ApprovalInbox.tsx`
- Test: `apps/desktop/test/approval-inbox.test.tsx`

**Interfaces:**
- Consumes: `SparkiiApi.listPendingApprovals` / `decideApproval` / `on('approval')`；`Proposal`（带 `requestId`）。
- Produces:
  - `ApprovalInboxProvider({ children })`
  - `useSessionApprovals(sessionId): { waiting: Proposal[]; approve(id, opts?): Promise<ApprovalDecisionResult>; reject(id, opts?): Promise<ApprovalDecisionResult> }`
  - 内部 `useApprovalInbox(): { proposals; claimed; claim; release; decide; onDecided }`

- [ ] **Step 1: 写失败测试（隔离 + 认领 + 决定）**

```tsx
import { renderHook, act, waitFor } from '@testing-library/react';
import { ApprovalInboxProvider, useSessionApprovals, useApprovalInbox } from '../src/trust/ApprovalInbox.js';

function wrap(api: any, ui: ReactNode) { return <ApprovalInboxProvider api={api}>{ui}</ApprovalInboxProvider>; }

it('useSessionApprovals only returns own routine pending', async () => {
  const api = {
    listPendingApprovals: async () => [
      { id: 'a', requestId: 'ra', sessionId: 's1', risk: 'write', status: 'pending' },
      { id: 'b', requestId: 'rb', sessionId: 's2', risk: 'write', status: 'pending' },
      { id: 'c', requestId: 'rc', sessionId: 's1', risk: 'high-risk', status: 'pending' },
    ],
    on: () => () => {},
    decideApproval: async () => ({}),
  };
  const { result } = renderHook(() => useSessionApprovals('s1'), { wrapper: ({children}) => wrap(api, children) });
  await waitFor(() => expect(result.current.waiting.map(p => p.id)).toEqual(['a']));
});
```

- [ ] **Step 2: 实现 `ApprovalInbox`**

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Proposal } from '@sparkii/approval';
import type { SparkiiApi } from '../types/sparkii-api.js';

export type ApprovalDecisionResult =
  | { ok: true; status: 'approved' | 'denied' }
  | { ok: false; status: 'expired' | 'failed'; error: { code: string; message: string } };

interface InboxValue {
  proposals: ReadonlyMap<string, Proposal>;
  claimed: ReadonlySet<string>;
  claim(id: string): void;
  release(id: string): void;
  decide(id: string, approved: boolean, note?: string): Promise<ApprovalDecisionResult>;
  onDecided(cb: () => void): () => void;
}

const InboxContext = createContext<InboxValue | null>(null);

export function ApprovalInboxProvider({ api, children }: { api: SparkiiApi; children: ReactNode }) {
  const [proposals, setProposals] = useState<Map<string, Proposal>>(new Map());
  const [claimed, setClaimed] = useState<Set<string>>(new Set());
  const decidedCbs = useRef(new Set<() => void>());

  const refresh = useCallback(async () => {
    const list = (await api.listPendingApprovals()) as Proposal[];
    setProposals(new Map(list.filter(p => p.status === 'pending').map(p => [p.id, p])));
  }, [api]);

  useEffect(() => {
    void refresh();
    return api.on('approval', (raw: unknown) => {
      const p = raw as Proposal;
      setProposals(prev => {
        const next = new Map(prev);
        if (p.status === 'pending') next.set(p.id, p);
        else next.delete(p.id);
        return next;
      });
      setClaimed(prev => {
        if (p.status !== 'pending' && prev.has(p.id)) {
          const next = new Set(prev); next.delete(p.id); return next;
        }
        return prev;
      });
    });
  }, [refresh, api]);

  const claim = useCallback((id: string) => setClaimed(prev => new Set(prev).add(id)), []);
  const release = useCallback((id: string) => setClaimed(prev => {
    if (!prev.has(id)) return prev;
    const next = new Set(prev); next.delete(id); return next;
  }), []);

  const onDecided = useCallback((cb: () => void) => {
    decidedCbs.current.add(cb);
    return () => decidedCbs.current.delete(cb);
  }, []);

  const decide = useCallback(async (id: string, approved: boolean, note?: string) => {
    setProposals(prev => { const next = new Map(prev); next.delete(id); return next; });
    try {
      await api.decideApproval(id, approved, note);
      decidedCbs.current.forEach(cb => cb());
      return { ok: true, status: approved ? 'approved' : 'denied' } as const;
    } catch (e) {
      await refresh();
      return { ok: false, status: 'failed', error: { code: (e as Error).name, message: (e as Error).message } } as const;
    }
  }, [api, refresh]);

  const value = useMemo<InboxValue>(() => ({ proposals, claimed, claim, release, decide, onDecided }), [proposals, claimed, claim, release, decide, onDecided]);
  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>;
}

export function useApprovalInbox(): InboxValue {
  const v = useContext(InboxContext);
  if (!v) throw new Error('useApprovalInbox must be used within ApprovalInboxProvider');
  return v;
}

export function useSessionApprovals(sessionId: string | null) {
  const { proposals, decide } = useApprovalInbox();
  const waiting = useMemo(() => sessionId == null ? [] : [...proposals.values()].filter(p =>
    p.sessionId === sessionId && p.status === 'pending' && p.risk !== 'high-risk',
  ), [proposals, sessionId]);
  return {
    waiting,
    approve: (id: string, opts?: { note?: string }) => decide(id, true, opts?.note),
    reject: (id: string, opts?: { note?: string }) => decide(id, false, opts?.note),
  };
}
```

- [ ] **Step 3: 补认领/决定/回滚测试**

覆盖：`claim`/`release` 幂等；`decide` 乐观移除 + 失败 `refresh` 回滚；`onDecided` 在成功后被调用。

- [ ] **Step 4: 跑测试**

Run: `pnpm exec vitest run apps/desktop/test/approval-inbox.test.tsx`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/trust/ApprovalInbox.tsx apps/desktop/test/approval-inbox.test.tsx
git commit -m "feat(desktop): add approval inbox store and session-scoped hook"
```

---

### Task 7: `InlineApprovalCard`

**Files:**
- Create: `apps/desktop/src/trust/InlineApprovalCard.tsx`

**Interfaces:**
- Consumes: `ApprovalCard`（Task 5）、`useApprovalInbox`（Task 6）。
- Produces: `InlineApprovalCard({ proposal })` —— 挂载认领、卸载释放、`onDecide` 走 inbox。

- [ ] **Step 1: 实现**

```tsx
import { useEffect } from 'react';
import { ApprovalCard } from './ApprovalCard.js';
import { useApprovalInbox } from './ApprovalInbox.js';
import type { ApprovalProposalLike } from './types.js';

export function InlineApprovalCard({ proposal }: { proposal: ApprovalProposalLike }) {
  const { claim, release, decide } = useApprovalInbox();
  useEffect(() => {
    claim(proposal.id);
    return () => release(proposal.id);
  }, [proposal.id, claim, release]);
  return <ApprovalCard proposal={proposal} onDecide={(id, ok, note) => { void decide(id, ok, note); }} />;
}
```

- [ ] **Step 2: 加认领释放测试**

`render(<InlineApprovalCard proposal={...} />)` 后断言 inbox `claimed` 含该 id；`unmount()` 后不含。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/trust/InlineApprovalCard.tsx
git commit -m "feat(desktop): inline approval card claims on mount and releases on unmount"
```

---

### Task 8: `ApprovalPanel` → `ApprovalDrawer`

**Files:**
- Delete: `apps/desktop/src/trust/ApprovalPanel.tsx`
- Create: `apps/desktop/src/trust/ApprovalDrawer.tsx`
- Modify: 所有 import `ApprovalPanel` 的引用（`App.tsx`、`composer/registry.tsx`、相关测试）

**Interfaces:**
- Consumes: `useApprovalInbox().proposals` / `.claimed`。
- Produces: `ApprovalDrawer({ currentSessionId?, onClose })`，只渲染 `unclaimed` 例行。

- [ ] **Step 1: 实现 `ApprovalDrawer`**

```tsx
import { useMemo } from 'react';
import { Drawer } from '@sparkii/ui';
import { present } from './present.js';
import { ApprovalCard } from './ApprovalCard.js';
import { useApprovalInbox } from './ApprovalInbox.js';

export function ApprovalDrawer({ currentSessionId = null, onClose }: { currentSessionId?: string | null; onClose(): void }) {
  const { proposals, claimed, decide } = useApprovalInbox();
  const routine = useMemo(() => [...proposals.values()].filter(p => p.risk !== 'high-risk'), [proposals]);
  const unclaimed = routine.filter(p => !claimed.has(p.id));
  const current = unclaimed.filter(p => p.sessionId === currentSessionId);
  const others = unclaimed.filter(p => p.sessionId !== currentSessionId);
  return (
    <Drawer open fixed title="需要你确认" onClose={onClose} className="ui-approval-drawer">
      <div className="ui-approval-qhead"><b>{unclaimed.length ? `${unclaimed.length} 处改动等你看` : '暂无待确认'}</b></div>
      <div className="ui-approval-queue">
        {unclaimed.length === 0 ? <div className="ui-muted ui-approval-empty">没有待确认的事项</div> : (
          <>
            {current.length > 0 && <section className="ui-approval-group"><div className="ui-approval-group-title">当前会话</div>{current.map(p => <ApprovalCard key={p.id} proposal={p} onDecide={(id, ok, note) => { void decide(id, ok, note); }} />)}</section>}
            {others.length > 0 && <section className="ui-approval-group"><div className="ui-approval-group-title">其他会话</div>{others.map(p => <ApprovalCard key={p.id} proposal={p} onDecide={(id, ok, note) => { void decide(id, ok, note); }} />)}</section>}
          </>
        )}
      </div>
    </Drawer>
  );
}
```

- [ ] **Step 2: 更新引用与测试**

`rg "ApprovalPanel" apps/desktop` 全部改为 `ApprovalDrawer`；抽屉自动打开逻辑移到 `App.tsx`（Task 11）由 `unclaimed` 派生。

- [ ] **Step 3: 跑 trust 测试**

Run: `pnpm exec vitest run apps/desktop/test/approval-trust.test.tsx apps/desktop/test/approval-shell.test.tsx apps/desktop/test/approval.test.tsx`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/trust apps/desktop/test
git commit -m "refactor(desktop): rename ApprovalPanel to ApprovalDrawer consuming inbox unclaimed"
```

---

### Task 9: `ApprovalModal` → `HighRiskApprovalDialog`

**Files:**
- Delete: `apps/desktop/src/trust/ApprovalModal.tsx`
- Create: `apps/desktop/src/trust/HighRiskApprovalDialog.tsx`
- Modify: 引用处与测试

**Interfaces:**
- Consumes: `useApprovalInbox().proposals` 中的 high-risk；`decide`。
- Produces: `HighRiskApprovalDialog()` —— 强制，不认领，倒计时纯展示。

- [ ] **Step 1: 实现**

把 `ApprovalModal` 迁移为：从 inbox 取 `highRisk = [...proposals.values()].filter(p => p.risk === 'high-risk')[0]`。倒计时 `Countdown` 去掉 `onExpire`（超时由 Main 推送，卡片随 inbox 移除消失）。保留二次确认、审批意见、技术细节。

- [ ] **Step 2: 更新引用与测试**

`rg "ApprovalModal"` → `HighRiskApprovalDialog`；删除「倒计时触发 decide('timeout')」断言，改为「Main 推 expired 后对话框消失」。

- [ ] **Step 3: 跑 trust 测试**

Run: `pnpm exec vitest run apps/desktop/test/approval-trust.test.tsx apps/desktop/test/countdown.test.tsx`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/trust apps/desktop/test
git commit -m "refactor(desktop): rename ApprovalModal to HighRiskApprovalDialog with display-only countdown"
```

---

### Task 10: `ApprovalCenter` 消费收件箱

**Files:**
- Modify: `apps/desktop/src/trust/ApprovalCenter.tsx`

**Interfaces:**
- Consumes: `useApprovalInbox().proposals`（全量）。
- Produces: `ApprovalCenter({ onOpenDetail })`。

- [ ] **Step 1: 改为从 inbox 读全量**

删除 `proposals` prop，改为内部 `const { proposals } = useApprovalInbox()`，列表用 `[...proposals.values()]`。保留 `present()` 标题/风险徽标/倒计时（倒计时同样去掉 `onExpire`）。

- [ ] **Step 2: 更新 `App.tsx` 引用与测试**

同步 `App.tsx` 与 `approval-trust.test.tsx` 里 `ApprovalCenter` 的用法（不再传 `proposals`）。

- [ ] **Step 3: 跑测试**

Run: `pnpm exec vitest run apps/desktop/test/approval-trust.test.tsx apps/desktop/test/approval.test.tsx`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/trust/ApprovalCenter.tsx apps/desktop/src/App.tsx apps/desktop/test
git commit -m "refactor(desktop): ApprovalCenter reads from approval inbox"
```

---

### Task 11: `App.tsx` 集成收件箱

**Files:**
- Modify: `apps/desktop/src/App.tsx`

**Interfaces:**
- Consumes: `ApprovalInboxProvider`、`useApprovalInbox`、`ApprovalDrawer`、`HighRiskApprovalDialog`、`ApprovalCenter`。
- Produces: App 不再持有 `pending`/`decide`/`partitionApprovals`；抽屉自动打开由 `unclaimed` 派生；审计视图随 `onDecided` 刷新。

- [ ] **Step 1: 包裹 provider 并删除本地审批状态**

`App()` 中：`<ErrorProvider><ApprovalInboxProvider api={api}><AppShell /></ApprovalInboxProvider></ErrorProvider>`。

`AppShell` 删除 `pending`、`approvalOpen`、`refreshApprovals`、`decide`、`partitionApprovals` 及两处 `api.on('approval')`/`api.on('runtime-pool')` 里对 `pending` 的依赖。`runtimePool` 的 `waiting-approval` 状态改用 inbox 的 `proposals` 派生。

- [ ] **Step 2: 抽屉自动打开 + 审计信号**

用 inbox 内部派生：`const unclaimedRoutine = [...proposals.values()].filter(p => p.risk !== 'high-risk' && !claimed.has(p.id))`。`ApprovalDrawer` 的 `open` 条件改为 `unclaimedRoutine.length > 0 && !drawerDismissed`（`drawerDismissed` 在用户点关闭时置 true，新 unclaimed 到达时置 false）。

审计刷新：

```tsx
const { onDecided } = useApprovalInbox();
useEffect(() => onDecided(() => setAuditVersion(v => v + 1)), [onDecided]);
```

- [ ] **Step 3: 更新 HomeView/Shell 的 pending 计数来源**

`pendingApprovals` 改为 `proposals.size`（全量 pending，含已认领）；`HomeView` 与 `ApprovalCenter` 的传参同步。

- [ ] **Step 4: 跑 app 测试**

Run: `pnpm exec vitest run apps/desktop/test/app-general.test.tsx apps/desktop/test/app-workflow.test.tsx apps/desktop/test/approval-shell.test.tsx apps/desktop/test/home-view.test.tsx`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/App.tsx apps/desktop/test
git commit -m "refactor(desktop): move approval state into inbox and wire drawer/dialog/audit"
```

---

### Task 12: 通用 surface 内联渲染

**Files:**
- Modify: `apps/desktop/agents/general/surface/index.tsx`
- Modify: `apps/desktop/src/surface/standard-chat.tsx`
- Test: `apps/desktop/test/standard-chat.test.tsx`、`apps/desktop/test/general-surface.test.tsx`

**Interfaces:**
- Consumes: `useSessionApprovals(sessionId)`（Task 6）、`approvalRequestId`（Task 4）、`InlineApprovalCard`（Task 7）。
- Produces: `StandardChatProps.renderApprovalCard?`；通用 surface 传入 `approve/reject` 与 proposal。

- [ ] **Step 1: 扩展 `StandardChatProps` 并渲染**

`standard-chat.tsx` 增加：

```ts
export type StandardChatProps = AgentSurfaceProps & {
  api?: SparkiiApi;
  active?: boolean;
  draft?: boolean;
  onSessionCreated?(sessionId: string, userText: string): void;
  renderApprovalCard?(entry: Extract<SessionEntry, { kind: 'tool' }>): ReactNode;
};
```

在 `ToolCard` 渲染后：

```tsx
{e.kind === 'tool' && e.awaitingApproval && renderApprovalCard ? renderApprovalCard(e) : null}
```

- [ ] **Step 2: 通用 surface 接线**

`index.tsx`：

```tsx
const { waiting } = useSessionApprovals(sessionId);
const byRequestId = useMemo(() => new Map(waiting.map(p => [p.requestId, p])), [waiting]);
const renderApprovalCard = (entry: Extract<SessionEntry, { kind: 'tool' }>) => {
  const rid = (entry as any).approvalRequestId as string | undefined;
  const proposal = rid ? byRequestId.get(rid) : undefined;
  if (!proposal) return null;
  return <InlineApprovalCard proposal={proposal} />;
};
```

把 `renderApprovalCard` 传给 `StandardChatSurface`。

- [ ] **Step 3: 加测试**

`general-surface.test.tsx` 补：给定 sessionId 的 waiting 中含 `requestId` 对应 proposal，投影后的工具卡带 `approvalRequestId`，渲染出 `InlineApprovalCard`（`data-testid="approval-card"`）。`standard-chat.test.tsx` 断言 `renderApprovalCard` 在 awaiting 工具卡后被调用。

- [ ] **Step 4: 跑测试**

Run: `pnpm exec vitest run apps/desktop/test/standard-chat.test.tsx apps/desktop/test/general-surface.test.tsx`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/agents/general/surface apps/desktop/src/surface/standard-chat.tsx apps/desktop/test
git commit -m "feat(general): render inline approval card under awaiting tool card"
```

---

### Task 13: 全量验证

- [ ] **Step 1: 类型检查**

Run: `pnpm typecheck`
Expected: 通过（`packages/approval`、`apps/desktop` 两处 tsconfig）。

- [ ] **Step 2: 全量测试**

Run: `pnpm test`
Expected: 全绿。

- [ ] **Step 3: lint**

Run: `pnpm lint`
Expected: 通过。

- [ ] **Step 4: Commit（如有遗漏）**

```bash
git add -A
git commit -m "chore: finalize approval render decoupling"
```

## 完成定义

- 通用聊天中，本会话例行写操作在工具卡下出现内联审批卡，可就地允许/拒绝。
- 右侧抽屉只显示未认领的例行审批；认领项不重复出现在抽屉。
- 切会话/切页面后认领释放，审批回到抽屉「其他会话」分组。
- 高风险恒走居中弹窗，永不被内联/认领。
- 允许/拒绝后工具卡经 JSONL 变成完成/已拒绝；失败时 inbox 回滚。
- 超时由 Main 推 `expired`，长命令执行中不被误报取消。
- 合同审核导出审批仍走抽屉，业务复核不受影响。
- 审批中心仍列全量 pending；全局角标 = 全量 pending。
