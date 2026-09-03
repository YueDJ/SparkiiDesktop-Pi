# Contract Review JSONL Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让合同审核的 live 与 history 都只消费 Pi JSONL（`type: "custom"` 行 + 聊天行），实时通过与 `pi.appendEntry` 相同的 `entry_appended` 回声更新。

**Architecture:** 适配层在 `appendCustomEntry` 后发出 SDK 同款 `entry_appended`；`normalizeEvent` 与 surface 归一化器认 Pi 的 custom 形状并保持原顺序；`runWorkflow` 先返回 sessionId 并 `pipeSessionEvents`，workflow 会话不做聊天 idle-release；停发 `sparkii:event:workflow`；运行池管理与显示全部不动；清掉平台生产代码里的 agent-id 分支。Contract Surface 从 `session.entries` 纯投影。通用聊天实现不动。

**Tech Stack:** React 18 + Vite + Vitest + `@testing-library/react` + Pi SDK `appendCustomEntry` + 现有 `chat-event` 管道。

**Spec:** `docs/superpowers/specs/2026-09-03-contract-review-jsonl-display-design.md`

## Global Constraints

- 不新增 IPC、不新增事件通道、不让 Electron 伪造另一种 chat-event 类型。
- 写入形状必须是 Pi SDK 的 `{ type: "custom", customType, data, id, parentId, timestamp }`。
- `src/surface/` 不 import `agents/**`；agent surface 不 import `src/composer` / `src/workbench`。
- 平台不写合同专用 `{ stepId: "report", action: "result" }`。
- 历史会话可写：有 `sessionId` 就订阅 `chat-event`。
- workflow `kind` 会话禁止 `agent_settled → scheduleIdleRelease`。
- **运行池冻结：** 不改 pool 实现、queue、`runtime-pool` 事件、RuntimeCenter、底栏右侧按钮、App 的 `mapRuntimePool` / `onStopSession` / `onReleaseSession` / `onCancelQueuedSession`。
- **通用聊天冻结：** 不改 `standard-chat`、general surface、聊天队列/模型/会话实现。
- 平台生产代码不按 `'general'` / `'contract-review'` 分支。
- 测试用 Vitest；renderer 与 electron `tsc --noEmit` 必须通过。
- 本机 node：`C:\Users\YDJ\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`。沙箱跑测试/提交需提权。

---

## File Structure

```text
packages/agent-host/src/pi-sdk-runtime.ts     # appendCustomEntry + emit entry_appended
packages/agent-host/src/rpc-client.ts         # normalizeEvent 透传 custom
packages/agent-host/src/types.ts              # NormalizedEvent 保持 entry_appended
packages/agent-host/test/pi-runtime-append-entry.test.ts
packages/agent-host/test/rpc-client.test.ts

apps/desktop/src/surface/contract.ts          # CustomSessionEntry
apps/desktop/src/surface/normalize.ts         # Pi custom 形状 + 原顺序 + merge output
apps/desktop/src/surface/use-agent-session.ts # 有 sessionId 就订阅
apps/desktop/electron/main/workflow.ts        # 先返回 id；step_end 带 output
apps/desktop/electron/main/ipc.ts             # pipeSessionEvents；workflow 跳过 idle-release
apps/desktop/src/App.tsx                      # 打开历史仍订阅；去掉 chat/dashboard 占位导航
packages/ui/src/patterns/Shell.tsx            # ScreenId 不再钉 agent-id
apps/desktop/electron/main/runtime.ts         # 去掉按 agent-id 的 surface/tools 兜底
apps/desktop/electron/main/ipc.ts             # 去掉 profileId ?? 'general'
apps/desktop/test/shell.test.tsx

apps/desktop/agents/contract-review/surface/index.tsx  # 纯投影；复核 payload 嵌套
apps/desktop/test/surface-normalize.test.ts
apps/desktop/test/use-agent-session.test.ts
apps/desktop/test/contract-surface.test.tsx
apps/desktop/test/workflow-broker.test.ts
```

---

### Task 1: 适配层对齐 `pi.appendEntry`

**Files:**
- Modify: `packages/agent-host/src/pi-sdk-runtime.ts`
- Test: `packages/agent-host/test/pi-runtime-append-entry.test.ts`

**Interfaces:**
- Consumes: `session.sessionManager.appendCustomEntry(customType, data)`, `getEntry(id)`
- Produces: 写入后 `subscribe` 收到 `{ type: "entry_appended", entry }`，`entry.type === "custom"`

- [ ] **Step 1: Write the failing test**

在 `pi-runtime-append-entry.test.ts` 增加：

```ts
it('emits entry_appended after appendCustomEntry (pi.appendEntry shape)', async () => {
  const listeners = new Set<(e: unknown) => void>();
  let stored: { type: string; customType: string; data: unknown; id: string } | undefined;
  const session = fakeSession();
  session.subscribe = (cb) => { listeners.add(cb); return () => listeners.delete(cb); };
  (session as any).sessionManager = {
    appendCustomEntry: (customType: string, data: unknown) => {
      stored = { type: 'custom', customType, data, id: 'e1' };
      return 'e1';
    },
    getEntry: () => stored,
  };
  (session as any)._emit = (event: unknown) => listeners.forEach((cb) => cb(event));
  session.appendWorkflowEntry = async (customType: string, data: unknown) => {
    const id = session.sessionManager.appendCustomEntry(customType, data);
    const entry = session.sessionManager.getEntry(id);
    if (entry) session._emit({ type: 'entry_appended', entry });
  };

  const seen: unknown[] = [];
  session.subscribe((e) => seen.push(e));
  await session.appendWorkflowEntry!('workflow_step_start', { stepId: 'review' });
  expect(seen[0]).toMatchObject({
    type: 'entry_appended',
    entry: { type: 'custom', customType: 'workflow_step_start', data: { stepId: 'review' } },
  });
});
```

先把 `appendWorkflowEntry` 实现从测试里拿掉、改为走真实 `adapt` 导出函数时，本测试应失败（当前实现不 `_emit`）。

- [ ] **Step 2: Run test to verify it fails**

Run: 仓库根目录 vitest `pi-runtime-append-entry`。Expected: FAIL（无 emit 或新函数未导出）。

- [ ] **Step 3: Write minimal implementation**

在 `pi-sdk-runtime.ts` 抽出并在 `adaptSession().appendWorkflowEntry` 使用：

```ts
export function appendCustomEntryAndEmit(
  session: { sessionManager: { appendCustomEntry(type: string, data: unknown): string; getEntry(id: string): unknown }; _emit?(event: unknown): void },
  customType: string,
  data: unknown,
): void {
  const entryId = session.sessionManager.appendCustomEntry(customType, data);
  const entry = session.sessionManager.getEntry(entryId);
  if (entry) session._emit?.({ type: 'entry_appended', entry });
}
```

`appendWorkflowEntry: async (customType, data) => { appendCustomEntryAndEmit(session, customType, data); }`

事件形状必须与 SDK `pi.appendEntry` 一致，禁止改成别的 `type`。

- [ ] **Step 4: Run test to verify it passes**

Run: vitest `pi-runtime-append-entry`。Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/agent-host/src/pi-sdk-runtime.ts packages/agent-host/test/pi-runtime-append-entry.test.ts
git commit -m "fix(agent-host): emit entry_appended after custom JSONL append"
```

---

### Task 2: `normalizeEvent` 透传 custom 行

**Files:**
- Modify: `packages/agent-host/src/rpc-client.ts`
- Test: `packages/agent-host/test/rpc-client.test.ts`

**Interfaces:**
- Consumes: `{ type: "entry_appended", entry: { type: "custom", customType, data, id } }`
- Produces: `{ type: "entry_appended", entry }`（不丢成 `unknown`）

- [ ] **Step 1: Write the failing test**

```ts
it("passes through custom entry_appended rows", () => {
  expect(normalizeEvent({
    type: "entry_appended",
    entry: { type: "custom", customType: "workflow_step_end", data: { stepId: "review", status: "completed" }, id: "e1" },
  })).toEqual({
    type: "entry_appended",
    entry: { type: "custom", customType: "workflow_step_end", data: { stepId: "review", status: "completed" }, id: "e1" },
  });
});
```

保留现有「user entry_appended → user message」用例。

- [ ] **Step 2: Run test to verify it fails**

Run: vitest `rpc-client`。Expected: FAIL（当前返回 `{ type: "unknown", raw }`）。

- [ ] **Step 3: Write minimal implementation**

在 `normalizeEvent` 的 `entry_appended` 分支、`custom_message` 判断之后增加：

```ts
if (raw.entry?.type === "custom") {
  return { type: "entry_appended", entry: raw.entry };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: vitest `rpc-client`。Expected: PASS，原用户消息用例仍绿。

- [ ] **Step 5: Commit**

```bash
git add packages/agent-host/src/rpc-client.ts packages/agent-host/test/rpc-client.test.ts
git commit -m "fix(agent-host): forward custom entry_appended events"
```

---

### Task 3: Surface 归一化认 Pi custom 形状

**Files:**
- Modify: `apps/desktop/src/surface/contract.ts`
- Modify: `apps/desktop/src/surface/normalize.ts`
- Test: `apps/desktop/test/surface-normalize.test.ts`

**Interfaces:**
- Produces: `CustomSessionEntry { kind: "custom"; id: string; customType: string; data: Record<string, unknown>; timestamp?: number }`
- `SessionEntry = ChatEntry | CustomSessionEntry`
- `deriveWorkflowTimeline` 只认 `customType` 为 `workflow_step_start` / `workflow_step_end`
- `extractWorkflowResult(entries)` 返回 `{ [stepId]: output }`（来自各步 `workflow_step_end.data.output`）

- [ ] **Step 1: Write the failing tests**

```ts
it('keeps Pi custom entries in JSONL order with chat messages', () => {
  const out = normalizeSessionEntries([
    { type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text: '开始' }] } },
    { type: 'custom', id: 'c1', customType: 'workflow_step_start', data: { stepId: 'review' }, timestamp: '2026-09-03T00:00:00Z' },
    { type: 'message', id: 'm2', message: { role: 'assistant', content: [{ type: 'text', text: '{}' }] } },
    { type: 'custom', id: 'c2', customType: 'workflow_step_end', data: { stepId: 'review', status: 'completed', output: { riskFindings: [] } } },
  ]);
  expect(out.map((e) => e.kind)).toEqual(['message', 'custom', 'message', 'custom']);
  expect(out[1]).toMatchObject({ kind: 'custom', id: 'c1', customType: 'workflow_step_start' });
});

it('applies live entry_appended the same as a JSONL custom row', () => {
  const next = applySurfaceEvent([], {
    type: 'entry_appended',
    entry: { type: 'custom', id: 'c1', customType: 'workflow_step_start', data: { stepId: 'load' } },
  });
  expect(next[0]).toMatchObject({ kind: 'custom', customType: 'workflow_step_start', data: { stepId: 'load' } });
});

it('merges step outputs by stepId', () => {
  const entries = normalizeSessionEntries([
    { type: 'custom', id: 'c1', customType: 'workflow_step_end', data: { stepId: 'review', status: 'completed', output: { riskFindings: [{ id: 'r1' }] } } },
    { type: 'custom', id: 'c2', customType: 'workflow_step_end', data: { stepId: 'report', status: 'completed', output: { title: '报告' } } },
  ]);
  expect(extractWorkflowResult(entries)).toEqual({
    review: { riskFindings: [{ id: 'r1' }] },
    report: { title: '报告' },
  });
});
```

把旧测试里 `{ type: 'workflow_step_start', data: ... }` 改为 Pi 的 `{ type: 'custom', customType: 'workflow_step_start', data: ... }`。

- [ ] **Step 2: Run test to verify it fails**

Run: vitest `surface-normalize`。Expected: FAIL（当前前置 workflow、认错 type、extract 只认 `action: result`）。

- [ ] **Step 3: Write minimal implementation**

`contract.ts` 用 `CustomSessionEntry` 替换 `WorkflowStepEntry` / `WorkflowStateEntry`。

`normalize.ts`：

```ts
function customFrom(raw: unknown): CustomSessionEntry | null {
  const rec = asRecord(raw);
  const entry = rec.type === 'entry_appended' ? asRecord(rec.entry) : rec;
  if (String(entry.type) !== 'custom') return null;
  return {
    kind: 'custom',
    id: String(entry.id ?? ''),
    customType: String(entry.customType ?? ''),
    data: asRecord(entry.data),
    timestamp: typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : undefined,
  };
}

export function normalizeSessionEntries(entries: unknown[]): SessionEntry[] {
  const out: SessionEntry[] = [];
  const chatBuf: unknown[] = [];
  const flushChat = () => {
    if (!chatBuf.length) return;
    out.push(...uiNormalizeSessionEntries(chatBuf));
    chatBuf.length = 0;
  };
  for (const e of entries) {
    const c = customFrom(e);
    if (c) { flushChat(); out.push(c); }
    else chatBuf.push(e);
  }
  flushChat();
  return out;
}

export function extractWorkflowResult(entries: SessionEntry[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const e of entries) {
    if (e.kind !== 'custom' || e.customType !== 'workflow_step_end') continue;
    const stepId = String(e.data.stepId ?? '');
    if (stepId && 'output' in e.data) result[stepId] = e.data.output;
  }
  return result;
}
```

`deriveWorkflowTimeline` 改为看 `kind === 'custom'` 且 `customType` 为 start/end。`applySurfaceEvent`：先 `customFrom(ev)`，命中则 append（id 已存在则跳过）。

- [ ] **Step 4: Run test to verify it passes**

Run: vitest `surface-normalize`。Expected: PASS。修复所有因类型改名而红的引用（`contract-surface`、`App.tsx` 的 `extractWorkflowResult`）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/surface/contract.ts apps/desktop/src/surface/normalize.ts apps/desktop/test/surface-normalize.test.ts
git commit -m "fix(surface): normalize Pi custom JSONL rows in order"
```

---

### Task 4: `useAgentSession` 始终订阅；result 从 entries 推导

**Files:**
- Modify: `apps/desktop/src/surface/use-agent-session.ts`
- Modify: `apps/desktop/src/App.tsx`（打开历史不要靠 `mode` 切断订阅）
- Test: `apps/desktop/test/use-agent-session.test.ts`

**Interfaces:**
- 有 `sessionId` 即 `openChatSession` + `chat-event`
- `session.result` = `extractWorkflowResult(entries)`（或与 live 增量 merge 等价）
- `session.status` / `meta.currentStep` 来自 `deriveWorkflowTimeline(entries)`
- 删除对 `workflow` / `state` 的监听；App 传给 Shell 的 `statusText` 为 `''`（底栏左侧不再显示「正在执行:…」；右侧运行池按钮不动）

- [ ] **Step 1: Write the failing test**

```ts
it('applies chat-event custom rows even when mode is history', async () => {
  const on = vi.fn().mockReturnValue(() => {});
  (globalThis as any).window = {
    sparkii: {
      openChatSession: vi.fn().mockResolvedValue({ entries: [] }),
      on,
    },
  };
  const { result } = renderHook(() => useAgentSession('contract-review', 's1', 'history'));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const chatCb = on.mock.calls.find((c: any[]) => c[0] === 'chat-event')?.[1];
  await act(async () => {
    chatCb({
      sessionId: 's1',
      type: 'entry_appended',
      entry: { type: 'custom', id: 'c1', customType: 'workflow_step_end', data: { stepId: 'review', status: 'completed', output: { ok: true } } },
    });
  });
  expect(result.current.entries).toHaveLength(1);
  expect(result.current.result).toMatchObject({ review: { ok: true } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: vitest `use-agent-session`。Expected: FAIL（`mode !== 'live'` 直接 return）。

- [ ] **Step 3: Write minimal implementation**

去掉 `mode !== 'live'` 守卫，并删除 `on('workflow')` / `on('state')`。`applySurfaceEvent` 之后：

```ts
const timeline = deriveWorkflowTimeline(entries);
return {
  ...s,
  entries,
  streaming,
  status: timeline.status,
  result: extractWorkflowResult(entries),
  meta: { ...s.meta, currentStep: timeline.step ?? s.meta.currentStep },
};
```

打开 JSONL 快照时同样用 timeline + extract 填 `status`/`result`。`state` 事件监听可留着但不覆盖 entries 推导出的 result。

App：`onOpenSession` 对 workflow 仍设 `sessionId`；`mode` 可继续标 `history`，但 hook 不再用它切断订阅。

- [ ] **Step 4: Run test to verify it passes**

Run: vitest `use-agent-session`。Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/surface/use-agent-session.ts apps/desktop/src/App.tsx apps/desktop/test/use-agent-session.test.ts
git commit -m "fix(surface): keep JSONL subscription for history sessions"
```

---

### Task 5: `runWorkflow` 先返回 sessionId，并接入同一事件管

**Files:**
- Modify: `apps/desktop/electron/main/workflow.ts`
- Modify: `apps/desktop/electron/main/ipc.ts`
- Test: `apps/desktop/test/workflow-broker.test.ts`

**Interfaces:**
- `runWorkflow` 在 `chatSessions.create` + 可选 `onReady(sessionId, slot)` 之后返回 `sessionId`；runner 后台继续
- `step_completed` → `customType: "workflow_step_end"`, `data: { stepId, status: "completed", finishedAt, output }`
- 失败 → `status: "failed"`, `error`
- 不再写 `{ customType: "workflow_state", data: { stepId: "report", action: "result", ... } }`
- `kind === "workflow"` 的会话：`agent_settled` **不** `scheduleIdleRelease`
- slot 在后台 loop 的 `finally` 里 `pool.release`，不能在返回 id 时释放
- **不再** `webContents.send('sparkii:event:workflow')` 或为灌画面而 `send('sparkii:event:state', { workflow: { result } })`

- [ ] **Step 1: Write the failing tests**

```ts
it('returns the session id before the runner finishes', async () => {
  let finishStep!: () => void;
  const gate = new Promise<void>((resolve) => { finishStep = resolve; });
  // mock LinearRunner / sendPrompt 卡在第一步直到 finishStep()
  const started = runWorkflow(rt, getWindow, { documents: [] }, broker, 'contract-review');
  const id = await started;
  expect(id).toBe('pi-workflow-1');
  finishStep();
});

it('persists step output on workflow_step_end and does not write a report-named result blob', async () => {
  const appends: Array<{ customType: string; data: unknown }> = [];
  // mock client.send 收集 append_workflow_entry
  await /* wait for background loop */;
  expect(appends.some((a) => a.customType === 'workflow_step_end' && (a.data as any).output)).toBe(true);
  expect(appends.some((a) => a.customType === 'workflow_state' && (a.data as any).stepId === 'report')).toBe(false);
});
```

ipc 侧：给 `kind: 'workflow'` 会话喂 `agent_settled`，断言 **未** 调用 idle-release / `releaseSessionSlot`。

- [ ] **Step 2: Run test to verify it fails**

Run: vitest `workflow-broker` `ipc`。Expected: FAIL（当前 await 整段 loop；最终仍写 report result；idle-release 不区分 kind）。

- [ ] **Step 3: Write minimal implementation**

`workflow.ts` 结构：

```ts
rt.pool.renameSession(tempKey, sessionId);
rt.chatSessions.create({ ..., kind: 'workflow', ... });
opts.onReady?.(sessionId, slot);

void (async () => {
  try {
    for await (const e of new LinearRunner().run(def, ctx)) {
      if (e.type === 'step_started') { /* append workflow_step_start */ }
      if (e.type === 'step_completed') {
        await slot.client.send({
          type: 'append_workflow_entry',
          customType: 'workflow_step_end',
          data: { stepId: e.stepId, status: 'completed', finishedAt: new Date().toISOString(), output: e.output },
        });
      }
      if (e.type === 'workflow_failed') {
        await slot.client.send({
          type: 'append_workflow_entry',
          customType: 'workflow_step_end',
          data: { stepId: e.stepId, status: 'failed', error: e.error, finishedAt: new Date().toISOString() },
        });
      }
    }
  } finally {
    await rt.pool.release(sessionId);
  }
})();

return sessionId;
```

`ipc.ts` `runWorkflow` handler：session 就绪时 `pipeSessionEvents(sessionId, { slot, profileId })`（经 `onReady`）。

```ts
if (ev.type === 'agent_settled') {
  const rec = rt.chatSessions.get(sessionId);
  if (rec?.kind !== 'workflow') scheduleIdleRelease(sessionId);
}
```

不要 `webContents.send` 一条自制的 custom chat-event。

- [ ] **Step 4: Run test to verify it passes**

Run: vitest `workflow-broker` 以及相关 `ipc`。Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/workflow.ts apps/desktop/electron/main/ipc.ts apps/desktop/test/workflow-broker.test.ts
git commit -m "fix(workflow): return session id first and persist opaque step output"
```

---

### Task 6: 合同 Surface 纯投影 + 可写历史

**Files:**
- Modify: `apps/desktop/agents/contract-review/surface/index.tsx`
- Test: `apps/desktop/test/contract-surface.test.tsx`
- 若 `App.tsx` 的 `review` 把 payload 摊平导致读不到 `payload.riskId`，只改展开方式使 Agent 传入的 `{ stepId, payload }` 原样进入 `updateWorkflowState` 的 `data`

**Interfaces:**
- 画面只从 `session.entries` + `extractWorkflowResult` / `deriveWorkflowTimeline` 来
- `reviewed` / `notes` / `reportMerged` 每帧从 customType `workflow_state` 的 `data` 推导，禁止 `useEffect(..., [session.entries])` 整表重置
- `actions.review('risk_confirmed', { stepId: 'review', payload: { riskId } })`

- [ ] **Step 1: Write the failing tests**

```tsx
it('shows risk cards after a review step_end output without session.result', () => {
  const entries = normalizeSessionEntries([
    { type: 'custom', id: 'c1', customType: 'workflow_step_start', data: { stepId: 'review' } },
    { type: 'custom', id: 'c2', customType: 'workflow_step_end', data: { stepId: 'review', status: 'completed', output: { riskFindings: [{ id: 'r1', title: '付款周期过长', level: 'high' }] } } },
  ]);
  render(<ContractAgentSurface agent={agent} sessionId="s1" mode="history"
    session={{ entries, streaming: false, result: extractWorkflowResult(entries), meta: { currentStep: 'review' } }}
    actions={makeActions()} />);
  expect(screen.getAllByText('付款周期过长').length).toBeGreaterThan(0);
});

it('keeps confirmation after a later custom row arrives', () => {
  const actions = makeActions();
  const first = normalizeSessionEntries([
    { type: 'custom', id: 'c2', customType: 'workflow_step_end', data: { stepId: 'review', status: 'completed', output: { riskFindings: [{ id: 'r1', title: '付款周期过长', level: 'high' }] } } },
  ]);
  const { rerender } = render(<ContractAgentSurface ... session={{ entries: first, ... }} actions={actions} />);
  fireEvent.click(screen.getAllByText('确认')[0]);
  expect(actions.review).toHaveBeenCalledWith('risk_confirmed', { stepId: 'review', payload: { riskId: 'r1' } });
  const second = [...first, { kind: 'custom' as const, id: 'w1', customType: 'workflow_state', data: { stepId: 'review', action: 'risk_confirmed', payload: { riskId: 'r1' } } }];
  rerender(<ContractAgentSurface ... session={{ entries: second, result: extractWorkflowResult(second), ... }} />);
  expect(screen.getAllByText('已确认').length).toBeGreaterThan(0);
});
```

旧的 `workflow_state action: result` 夹具改为 `workflow_step_end` + `output`。

- [ ] **Step 2: Run test to verify it fails**

Run: vitest `contract-surface`。Expected: FAIL（仍依赖 `action: result` / entries 变化重置 reviewed）。

- [ ] **Step 3: Write minimal implementation**

从 entries 收集 `customType === 'workflow_state'` 得到复核 map。`parseRiskFindings(result.review ?? result.compare)`。删除对 `session.entries` 的重置 `useEffect`。idle 选文件仍用本地 state。

阶段映射：`load|search|review` → 审核；`report` → 报告。running 且无 output 时显示骨架文案（已有 empty 可改为「审核中…」）。

App `review`：

```ts
api.updateWorkflowState(sid, { action, ...payload })
```

在 Agent 传入 `{ stepId, payload: { riskId } }` 时，JSONL `data` 即为 `{ action, stepId, payload: { riskId } }`，与读取一致。不要再把 `riskId` 提到 `data` 顶层。

- [ ] **Step 4: Run tests**

Run: vitest `contract-surface` `app-workflow` `app-general` `surface-normalize` `use-agent-session`。Expected: PASS。然后 `apps/desktop` 下 `tsc --noEmit`（`tsconfig.json` 与 `tsconfig.electron.json`）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/agents/contract-review/surface/index.tsx apps/desktop/src/App.tsx apps/desktop/test/contract-surface.test.tsx
git commit -m "fix(contract): derive workbench from JSONL custom entries"
```

---

### Task 7: 清掉平台生产代码里的 agent-id 分支和占位屏

**Files:**
- Modify: `packages/ui/src/patterns/Shell.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/electron/main/runtime.ts`
- Modify: `apps/desktop/electron/main/ipc.ts`
- Test: `apps/desktop/test/shell.test.tsx`

**Interfaces:**
- `ScreenId` 只含平台屏；`ShellAgent.id: string`
- `navigate`：在 `agents` 列表里 → 打开该 agent；否则当平台屏。删除 `if (s === 'chat' || s === 'dashboard')`
- `runtime.assemble` 的 `manifest.surface` / `capabilities` 只来自已加载的 profile，禁止 `id === 'general'|'contract-review'`，禁止 import `agents/general` / `agents/contract-review`
- ipc 新建会话、`getModelOptions`、`ensureSessionRecord` 不再 `?? 'general'`；缺 profileId/agentId 则失败或跳过
- 删除未使用的 `isChatSurface`
- **禁止**改运行池；**禁止**改通用聊天实现

- [ ] **Step 1: Write the failing tests**

`shell.test.tsx`：夹具 agent id 用字符串即可（可继续用仓库里的真实 id 当夹具）。断言导航把 agent id 原样交给 `onNavigate`。

`runtime`：给一个**没有** `id === 'general'` 的假 profile（manifest 已带 `surface` 与 `capabilities.tools`），`assemble` 后 surface/tools 仍来自 manifest；源码不再 import 具体 agents。

ipc：`getModelOptions` 不传 agentId 时不得 silently 落到 general（应失败或返回无 requirements，由现有测试锁定所选行为）。

- [ ] **Step 2: Run test to verify it fails**

Run: vitest `shell`。Expected: 当前 `ScreenId` 仍钉着 `'chat' | 'dashboard' | 'general' | 'contract-review'`。

- [ ] **Step 3: Write minimal implementation**

```ts
export type PlatformScreen = 'home' | 'approvals' | 'audit' | 'settings';
export type ScreenId = PlatformScreen | string;

export interface ShellAgent {
  id: string;
  name: string;
  status: AgentStatus;
  surfaceType?: string;
  queuePosition?: number;
}
```

`runtime.ts`：`surface = manifest.surface`（缺则默认 `{ type: 'chat' }`，按 **type** 缺省，不按 id）；`capabilities = manifest.capabilities ?? { tools: [] }`。删掉 `generalAgentTools` / `contractReviewAgentTools` import。

`ipc.ts`：`const profileId = context.profileId;` 若空则 throw；`getModelOptions` 无 agentId 则 `requirements = { requires: ['chat'] }` 或要求调用方传入，不要 `agentOf('general')`。

`App.navigate` 只保留「是 agent → setScreen + refreshSessions，否则 setScreen」。不要动 `runtimePool` 及相关 handlers。

- [ ] **Step 4: Run tests**

Run: vitest `shell` `app-general` `app-workflow` `ui-shell-patterns` 以及涉及 `runtime`/`ipc` 缺省 general 的用例。Expected: PASS。然后 `apps/desktop` `tsc --noEmit`。

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/patterns/Shell.tsx apps/desktop/src/App.tsx apps/desktop/electron/main/runtime.ts apps/desktop/electron/main/ipc.ts apps/desktop/test/shell.test.tsx
git commit -m "refactor(platform): stop branching on hardcoded agent ids"
```

---

## Self-Review

1. **Spec coverage:** Task 1–2 覆盖 SDK emit + normalizeEvent；Task 3–4 覆盖 JSONL 形状、顺序、始终订阅、去掉 workflow/state 监听与底栏步骤文案；Task 5 覆盖 early sessionId、idle-release、opaque output、停发 workflow IPC、删除 report blob；Task 6 覆盖 Agent 投影与可写历史；Task 7 覆盖平台生产代码里的 agent-id 分支和占位屏。运行池管理与显示、通用聊天实现、PDF 预览、AgentSurfaceActions 方法集均不在改动范围内。
2. **Placeholder scan:** 无 TBD；idle-release 与 `_emit` 路径已写明。
3. **Type consistency:** `CustomSessionEntry.customType` / `data` 与 Pi `{ type: "custom", customType, data }` 一致；`extractWorkflowResult` 全任务均为 stepId → output。
