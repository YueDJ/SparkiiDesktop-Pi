# Runtime Pool Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bottom status bar, runtime center, and runtime settings consume a real PiRuntimePool snapshot and allow stop/release/cancel operations.

**Architecture:** Extend `PiRuntimePool` with snapshot + subscription + queue cancellation + dynamic max agents. Add IPC/preload methods. Add a `RuntimeCenter` UI pattern consumed by `Shell`, and wire `App` to the new snapshot. Persist `maxAgents`/`queueEnabled` through settings.

**Tech Stack:** TypeScript, Electron IPC, React 19, Vitest, React Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-28-runtime-pool-management-design.md`

## Global Constraints

- Keep existing `data-testid` values where possible; update tests together with changed labels.
- No new third-party UI framework.
- `PiRuntimePool` must not expose API keys or filesystem paths in its snapshot.
- TDD: write the failing test, watch it fail, implement, watch it pass.
- Commit after each task.

---

### Task 1: Pool snapshot and queue lifecycle

**Files:**
- Create: `packages/agent-host/src/runtime-pool.ts`
- Modify: `packages/agent-host/src/pi-runtime-pool.ts`
- Modify: `packages/agent-host/src/index.ts`
- Test: `packages/agent-host/test/pi-runtime-pool.test.ts`

**Interfaces:**
- Produces:
  - `RuntimePoolSnapshot`, `RuntimeSlotView`, `RuntimeQueueItemView`, `RuntimeSessionStatus`
  - `PiRuntimePool.snapshot(): RuntimePoolSnapshot`
  - `PiRuntimePool.subscribe(fn: (s: RuntimePoolSnapshot) => void): () => void`
  - `PiRuntimePool.cancelPending(queueId: string): boolean`
  - `PiRuntimePool.setMaxAgents(maxAgents: number): void`
  - `AcquireOptions.meta?: RuntimeAcquireMeta`

- [ ] **Step 1: Write the failing pool snapshot test**

Append to `packages/agent-host/test/pi-runtime-pool.test.ts`:

```ts
import type { RuntimePoolSnapshot } from "../src/runtime-pool.js";

it("emits a snapshot after acquire, release and rename", async () => {
  const handle = new FakeHandle();
  const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
  const snapshots: RuntimePoolSnapshot[] = [];
  pool.subscribe((s) => snapshots.push(s));

  await pool.acquire("a", { meta: { profileId: "general", profileName: "通用智能体", label: "会话#1" } });
  handle.ready();

  expect(pool.snapshot()).toMatchObject({ active: 1, queued: 0, maxAgents: 1 });
  expect(pool.snapshot().slots[0]).toMatchObject({ sessionId: "a", profileId: "general", profileName: "通用智能体", label: "会话#1" });
  expect(snapshots.length).toBeGreaterThan(0);

  await pool.release("a");
  expect(pool.snapshot()).toMatchObject({ active: 0, queued: 0 });
});
```

- [ ] **Step 2: Run the failing test**

Run: `pnpm vitest run packages/agent-host/test/pi-runtime-pool.test.ts`
Expected: FAIL because `runtime-pool.js` does not exist / snapshot method is missing.

- [ ] **Step 3: Implement runtime pool types and pool changes**

Create `packages/agent-host/src/runtime-pool.ts`:

```ts
export type RuntimeSessionStatus = "starting" | "streaming" | "waiting-approval" | "occupied-idle";

export interface RuntimeAcquireMeta {
  profileId: string;
  profileName?: string;
  label?: string;
}

export interface RuntimeSlotView {
  slotId: string;
  sessionId: string;
  profileId: string;
  profileName: string;
  label: string;
  status: RuntimeSessionStatus;
  startedAt: number;
}

export interface RuntimeQueueItemView {
  queueId: string;
  profileId: string;
  profileName: string;
  label: string;
  position: number;
}

export interface RuntimePoolSnapshot {
  maxAgents: number;
  active: number;
  queued: number;
  slots: RuntimeSlotView[];
  queue: RuntimeQueueItemView[];
}
```

Modify `pi-runtime-pool.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { RuntimeAcquireMeta, RuntimePoolSnapshot, RuntimeQueueItemView, RuntimeSessionStatus, RuntimeSlotView } from "./runtime-pool.js";

export interface AcquireOptions {
  resumeSessionFile?: string;
  saddle?: SessionSaddle;
  meta?: RuntimeAcquireMeta;
}

interface Slot {
  id: string;
  supervisor: PiRuntimeSupervisor;
  client: PiRuntimeClient;
  sessionId: string | null;
  meta?: RuntimeAcquireMeta;
  status: RuntimeSessionStatus;
  startedAt: number;
  offEvent?: () => void;
}

interface Pending {
  id: string;
  sessionId: string;
  options: AcquireOptions;
  resolve: (slot: PiRuntimeSlot) => void;
  reject: (e: Error) => void;
}
```

Add to class:

```ts
private listeners = new Set<(snapshot: RuntimePoolSnapshot) => void>();

subscribe(listener: (snapshot: RuntimePoolSnapshot) => void): () => void {
  this.listeners.add(listener);
  return () => this.listeners.delete(listener);
}

snapshot(): RuntimePoolSnapshot {
  return {
    maxAgents: this.opts.maxAgents,
    active: this.slots.filter((s) => s.sessionId !== null).length,
    queued: this.pending.length,
    slots: this.slots
      .filter((s) => s.sessionId !== null)
      .map((s) => ({
        slotId: s.id,
        sessionId: s.sessionId as string,
        profileId: s.meta?.profileId ?? "",
        profileName: s.meta?.profileName ?? s.meta?.profileId ?? "",
        label: s.meta?.label ?? (s.sessionId as string),
        status: s.status,
        startedAt: s.startedAt,
      })),
    queue: this.pending.map((p, i) => ({
      queueId: p.id,
      profileId: p.options.meta?.profileId ?? "",
      profileName: p.options.meta?.profileName ?? p.options.meta?.profileId ?? "",
      label: p.options.meta?.label ?? p.sessionId,
      position: i + 1,
    })),
  };
}

private emitSnapshot(): void {
  const next = this.snapshot();
  for (const listener of this.listeners) listener(next);
}

setMaxAgents(maxAgents: number): void {
  this.opts.maxAgents = Math.max(1, Math.floor(maxAgents));
  this.emitSnapshot();
}

cancelPending(queueId: string): boolean {
  const idx = this.pending.findIndex((p) => p.id === queueId);
  if (idx < 0) return false;
  const [pending] = this.pending.splice(idx, 1);
  pending.reject(new Error("RUNTIME_QUEUE_CANCELLED"));
  this.emitSnapshot();
  return true;
}
```

Change slot creation, bind, release, and event status:

```ts
async acquire(sessionId: string, opts: AcquireOptions = {}): Promise<PiRuntimeSlot> {
  const free = this.slots.find((s) => s.sessionId === null);
  if (free) return this.bind(free, sessionId, opts);
  if (this.slots.length < this.opts.maxAgents) {
    const supervisor = new PiRuntimeSupervisor(this.opts.makeSupervisor);
    const client = await supervisor.start();
    const slot: Slot = { id: randomUUID(), supervisor, client, sessionId: null, status: "occupied-idle", startedAt: 0 };
    slot.offEvent = client.onEvent((event) => this.applyEvent(slot, event));
    this.slots.push(slot);
    return this.bind(slot, sessionId, opts);
  }
  return new Promise<PiRuntimeSlot>((resolve, reject) => {
    this.pending.push({ id: randomUUID(), sessionId, options: opts, resolve, reject });
    this.emitSnapshot();
  });
}

private async bind(slot: Slot, sessionId: string, opts: AcquireOptions): Promise<PiRuntimeSlot> {
  slot.sessionId = sessionId;
  slot.meta = opts.meta;
  slot.status = "starting";
  slot.startedAt = Date.now();
  this.bySession.set(sessionId, slot.client);
  this.emitSnapshot();
  try {
    if (opts.saddle) {
      const r = await slot.client.send({ type: "configure_session", saddle: opts.saddle });
      if (!r.success) throw new Error(`configure_session failed: ${r.error ?? "unknown"}`);
    }
    if (opts.resumeSessionFile) {
      const r = await slot.client.send({ type: "switch_session", sessionPath: opts.resumeSessionFile });
      if (!r.success) throw new Error(`switch_session failed: ${r.error ?? "unknown"}`);
    }
  } catch (e) {
    this.bySession.delete(sessionId);
    slot.sessionId = null;
    slot.meta = undefined;
    slot.status = "occupied-idle";
    slot.startedAt = 0;
    this.emitSnapshot();
    throw e;
  }
  slot.status = "occupied-idle";
  this.emitSnapshot();
  return { client: slot.client, supervisor: slot.supervisor };
}

private applyEvent(slot: Slot, event: { type: string }): void {
  const next: RuntimeSessionStatus =
    event.type === "agent_start" || event.type === "turn_start" || event.type === "compaction_start"
      ? "streaming"
      : event.type === "agent_end" || event.type === "agent_settled" || event.type === "turn_end" || event.type === "runtime_error" || event.type === "compaction_end"
        ? "occupied-idle"
        : slot.status;
  if (slot.sessionId !== null && next !== slot.status) {
    slot.status = next;
    this.emitSnapshot();
  }
}
```

Modify `release`:

```ts
async release(sessionId: string): Promise<void> {
  const slot = this.slots.find((s) => s.sessionId === sessionId);
  if (!slot) return;
  this.bySession.delete(sessionId);
  try { await slot.client.send({ type: "new_session" }); } catch { /* 子进程已退出则忽略 */ }
  slot.sessionId = null;
  slot.meta = undefined;
  slot.status = "occupied-idle";
  slot.startedAt = 0;
  const next = this.pending.shift();
  if (next) void this.bind(slot, next.sessionId, next.options).then(next.resolve, next.reject);
  this.emitSnapshot();
}
```

Export the new types in `index.ts`:

```ts
export * from "./runtime-pool.js";
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run packages/agent-host/test/pi-runtime-pool.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-host/src/runtime-pool.ts packages/agent-host/src/pi-runtime-pool.ts packages/agent-host/src/index.ts packages/agent-host/test/pi-runtime-pool.test.ts
git commit -m "feat(agent-host): expose runtime pool snapshots and queue lifecycle"
```

### Task 2: Preserve queued acquire options

**Files:**
- Modify: `packages/agent-host/test/pi-runtime-pool.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("wakes a queued session with its original saddle and meta", async () => {
  const handle = new FakeHandle();
  const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
  await pool.acquire("a");
  handle.ready();

  const pending = pool.acquire("b", {
    saddle: { tools: ["read"] },
    meta: { profileId: "general", profileName: "通用智能体", label: "会话#2" },
  });
  await pool.release("a");
  await pending;

  const configure = handle.sent.find((e) => "command" in e && (e as any).command?.type === "configure_session");
  expect((configure as any)?.command?.saddle).toEqual({ tools: ["read"] });
  expect(pool.snapshot().slots[0]).toMatchObject({ profileId: "general", profileName: "通用智能体", label: "会话#2" });
});
```

- [ ] **Step 2: Run to verify failure**

Expected: FAIL because released slot currently binds `next.sessionId` with empty options.

- [ ] **Step 3: Verify implementation already fixes this from Task 1**

Run the same test.
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-host/test/pi-runtime-pool.test.ts
git commit -m "test(agent-host): cover queued saddle and metadata preservation"
```

### Task 3: Runtime pool IPC and preload

**Files:**
- Modify: `apps/desktop/electron/main/settings.ts`
- Modify: `apps/desktop/electron/main/runtime.ts`
- Modify: `apps/desktop/electron/main/ipc.ts`
- Modify: `apps/desktop/electron/preload/api-types.ts`
- Modify: `apps/desktop/electron/preload/api.ts`
- Test: `apps/desktop/test/ipc.test.ts`

**Interfaces:**
- Consumes: `rt.pool.snapshot()`, `rt.pool.subscribe()`, `rt.pool.cancelPending()`, `rt.pool.setMaxAgents()`
- Produces:
  - `getRuntimePool(): Promise<RuntimePoolSnapshot>`
  - `cancelQueuedSession(queueId: string): Promise<{ ok: boolean }>`
  - `releaseSessionSlot(sessionId: string): Promise<{ ok: boolean }>`
  - `runtime-pool` renderer event channel

- [ ] **Step 1: Write failing IPC tests**

In `apps/desktop/test/ipc.test.ts`, add:

```ts
it("getRuntimePool returns the pool snapshot", async () => {
  const { api } = await setup();
  (rt.pool as any).snapshot = () => ({ maxAgents: 4, active: 1, queued: 1, slots: [], queue: [] });
  await expect(api.getRuntimePool()).resolves.toMatchObject({ maxAgents: 4, active: 1, queued: 1 });
});
```

Use the existing test setup shape from the file; if `setup`/`api` differs, follow the file's existing helper.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/desktop/test/ipc.test.ts`
Expected: FAIL because `getRuntimePool` is not on the API.

- [ ] **Step 3: Implement settings fields and pool max**

Add to `AppSettings`:

```ts
queueEnabled?: boolean;
```

In `runtime.ts`, load settings before constructing the pool:

```ts
const settings = await loadSettings(opts.dataDir);
const maxAgents = Math.max(1, Math.floor(Number(settings.maxAgents ?? process.env.SPARKII_MAX_AGENTS ?? 4)));
const pool = new PiRuntimePool({
  maxAgents,
  makeSupervisor: ...
});
```

Import `loadSettings` from `./settings.js`.

- [ ] **Step 4: Implement IPC handlers**

In `registerIpc`, after `const broker`:

```ts
rt.pool.subscribe((snapshot) => {
  getWindow()?.webContents.send('sparkii:event:runtime-pool', snapshot);
});
```

Add handlers near the other IPC registrations:

```ts
ipcMain.handle('sparkii:getRuntimePool', () => rt.pool.snapshot());

ipcMain.handle('sparkii:cancelQueuedSession', (_e, queueId: string) => {
  if (!rt.pool.cancelPending(queueId)) throw new Error('queue item not found');
  return { ok: true };
});

ipcMain.handle('sparkii:releaseSessionSlot', async (_e, sessionId: string) => {
  if (!rt.pool.get(sessionId)) throw new Error('session is not occupying a runtime slot');
  const open = openSessions.get(sessionId);
  if (open) {
    const state = await open.slot.client.send({ type: 'get_state' });
    if ((state.data as { sessionFile?: string } | undefined)?.sessionFile) {
      rt.chatSessions.update(sessionId, { piSessionFile: (state.data as { sessionFile: string }).sessionFile });
    }
    open.offEvents?.();
    await rt.pool.release(sessionId);
    openSessions.delete(sessionId);
    appliedModelBySession.delete(sessionId);
  } else {
    await rt.pool.release(sessionId);
  }
  return { ok: true };
});
```

Modify `newChatSession` to use queue setting and pass meta:

```ts
const settings = await loadSettings(rt.dataDir);
const maxAgents = Math.max(1, Math.floor(Number(settings.maxAgents ?? process.env.SPARKII_MAX_AGENTS ?? 4)));
rt.pool.setMaxAgents(maxAgents);
if (rt.pool.activeCount() >= maxAgents && settings.queueEnabled === false) {
  throw new Error(`已达到最大并发会话数 ${maxAgents}，请先释放一个槽位`);
}
...
const slot = await rt.pool.acquire(tempKey, {
  saddle: buildProfileSaddle(...),
  meta: { profileId, profileName: rt.profileOf(profileId).profile.manifest.displayName ?? profileId, label: '新会话' },
});
```

Also pass `meta` in `ensureOpenSession`:

```ts
meta: { profileId: rec.profileId, profileName: rt.profileOf(rec.profileId).profile.manifest.displayName ?? rec.profileId, label: rec.id.slice(0, 8) },
```

- [ ] **Step 5: Implement preload methods and types**

In `api-types.ts`, import and extend:

```ts
import type { RuntimePoolSnapshot } from '@sparkii/agent-host';

getRuntimePool(): Promise<RuntimePoolSnapshot>;
cancelQueuedSession(queueId: string): Promise<{ ok: boolean }>;
releaseSessionSlot(sessionId: string): Promise<{ ok: boolean }>;
```

In `api.ts`:

```ts
getRuntimePool: () => invoke('getRuntimePool') as Promise<RuntimePoolSnapshot>,
cancelQueuedSession: (queueId) => invoke('cancelQueuedSession', queueId) as Promise<{ ok: boolean }>,
releaseSessionSlot: (sessionId) => invoke('releaseSessionSlot', sessionId) as Promise<{ ok: boolean }>,
```

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run apps/desktop/test/ipc.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/electron/main/settings.ts apps/desktop/electron/main/runtime.ts apps/desktop/electron/main/ipc.ts apps/desktop/electron/preload/api-types.ts apps/desktop/electron/preload/api.ts apps/desktop/test/ipc.test.ts
git commit -m "feat(desktop): add runtime pool snapshot and management IPC"
```

### Task 4: RuntimeCenter UI pattern

**Files:**
- Create: `packages/ui/src/patterns/RuntimeCenter.tsx`
- Modify: `packages/ui/src/patterns/StatusBar.tsx`
- Modify: `packages/ui/src/patterns/Shell.tsx`
- Modify: `packages/ui/src/index.ts`
- Test: `apps/desktop/test/ui-shell-patterns.test.tsx`

**Interfaces:**
- Produces:
  - `RuntimeCenterSession`, `RuntimeCenterQueueItem`, `RuntimePoolSummary`
  - `RuntimeCenter` component with `onStop`, `onRelease`, `onCancelQueue`
  - `ShellProps.runtimePool?`, `onStopSession?`, `onReleaseSession?`, `onCancelQueuedSession?`

- [ ] **Step 1: Write failing RuntimeCenter test**

Add to `apps/desktop/test/ui-shell-patterns.test.tsx`:

```tsx
import { RuntimeCenter } from '@sparkii/ui';

it('runtime center renders running and queued items and invokes actions', () => {
  const onStop = vi.fn();
  render(
    <RuntimeCenter
      snapshot={{
        active: 1,
        queued: 1,
        maxAgents: 4,
        sessions: [{ sessionId: 's1', profileName: '通用智能体', label: '会话#1', status: 'running' }],
        queue: [{ queueId: 'q1', profileName: '合同审核', label: '新会话', position: 1 }],
      }}
      onStop={onStop}
      onRelease={vi.fn()}
      onCancelQueue={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByText('停止'));
  fireEvent.click(screen.getByText('确认停止'));
  expect(onStop).toHaveBeenCalledWith('s1');
  expect(screen.getByText('合同审核 · 新会话 · 第 1 位')).toBeTruthy();
});
```

The confirm button label may be finalized as `确认停止`; use the exact label in the component.

- [ ] **Step 2: Run to verify failure**

Expected: FAIL because `RuntimeCenter` is not exported.

- [ ] **Step 3: Implement RuntimeCenter**

Create `packages/ui/src/patterns/RuntimeCenter.tsx`:

```tsx
import { useState } from 'react';
import { Button } from '../primitives/Button.js';
import { Modal } from '../primitives/Modal.js';

export type RuntimeCenterStatus = 'running' | 'waiting-approval' | 'idle';

export interface RuntimeCenterSession {
  sessionId: string;
  profileName: string;
  label: string;
  status: RuntimeCenterStatus;
}

export interface RuntimeCenterQueueItem {
  queueId: string;
  profileName: string;
  label: string;
  position: number;
}

export interface RuntimePoolSummary {
  active: number;
  queued: number;
  maxAgents: number;
  sessions: RuntimeCenterSession[];
  queue: RuntimeCenterQueueItem[];
}

type ConfirmState = { kind: 'stop' | 'release'; sessionId: string } | null;

export function RuntimeCenter({
  snapshot,
  onStop,
  onRelease,
  onCancelQueue,
}: {
  snapshot: RuntimePoolSummary;
  onStop(sessionId: string): Promise<void> | void;
  onRelease(sessionId: string): Promise<void> | void;
  onCancelQueue(queueId: string): Promise<void> | void;
}) {
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const run = async (key: string, action: () => Promise<void> | void) => {
    setBusy(key);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const confirmAction = () => {
    if (!confirm) return;
    if (confirm.kind === 'stop') void run(`stop:${confirm.sessionId}`, () => onStop(confirm.sessionId));
    else void run(`release:${confirm.sessionId}`, () => onRelease(confirm.sessionId));
    setConfirm(null);
  };

  const statusLabel = (status: RuntimeCenterStatus) =>
    status === 'running' ? '生成中' : status === 'waiting-approval' ? '等待审批' : '空闲占用';

  return (
    <div className="ui-runtime-center">
      <div className="ui-runtime-summary">
        运行 {snapshot.active}/{snapshot.maxAgents} · 排队 {snapshot.queued} · 空闲 {Math.max(0, snapshot.maxAgents - snapshot.active)}
      </div>
      {error && <div className="ui-error" role="alert">{error}</div>}
      <div className="ui-rail-label">运行中</div>
      {snapshot.sessions.length === 0 ? <div className="ui-muted">暂无运行中的智能体</div> : snapshot.sessions.map((s) => (
        <div key={s.sessionId} className="ui-runtime-row">
          <div className="ui-runtime-main">
            <b>{s.profileName}</b>
            <span className="ui-muted">{s.label}</span>
            <span className={`ui-status-badge ui-status-badge--${s.status === 'waiting-approval' ? 'approval' : s.status === 'running' ? 'running' : 'ok'}`}>{statusLabel(s.status)}</span>
          </div>
          <div className="ui-runtime-actions">
            <Button size="sm" disabled={s.status === 'idle' || busy === `stop:${s.sessionId}`} onClick={() => setConfirm({ kind: 'stop', sessionId: s.sessionId })}>停止</Button>
            <Button size="sm" variant="danger" disabled={busy === `release:${s.sessionId}`} onClick={() => setConfirm({ kind: 'release', sessionId: s.sessionId })}>释放槽位</Button>
          </div>
        </div>
      ))}
      <div className="ui-rail-label">排队中</div>
      {snapshot.queue.length === 0 ? <div className="ui-muted">暂无排队任务</div> : snapshot.queue.map((q) => (
        <div key={q.queueId} className="ui-runtime-row">
          <div className="ui-runtime-main">
            <b>{q.profileName}</b>
            <span className="ui-muted">{q.label}</span>
            <span className="ui-status-badge ui-status-badge--queued">第 {q.position} 位</span>
          </div>
          <Button size="sm" disabled={busy === `cancel:${q.queueId}`} onClick={() => void run(`cancel:${q.queueId}`, () => onCancelQueue(q.queueId))}>取消排队</Button>
        </div>
      ))}
      <Modal open={confirm !== null} title={confirm?.kind === 'stop' ? '停止会话' : '释放槽位'} onClose={() => setConfirm(null)}>
        <p>{confirm?.kind === 'stop' ? '确认中断当前这一轮？会话和槽位会保留。' : '确认释放槽位？会话记录会保留，工作进程将被复用。'}</p>
        <Button variant={confirm?.kind === 'release' ? 'danger' : 'primary'} onClick={confirmAction}>确认{confirm?.kind === 'stop' ? '停止' : '释放'}</Button>
      </Modal>
    </div>
  );
}
```

Export it from `index.ts`.

- [ ] **Step 4: Update StatusBar**

Replace `StatusBar.tsx` with:

```tsx
import type { RuntimePoolSummary } from './RuntimeCenter.js';

export function StatusBar({ statusText, runtimePool, onOpenQueue }: { statusText: string; runtimePool?: RuntimePoolSummary; onOpenQueue(): void }) {
  const active = runtimePool?.active ?? 0;
  const queued = runtimePool?.queued ?? 0;
  const maxAgents = runtimePool?.maxAgents ?? 0;
  return <footer className="ui-statusbar"><span className="ui-statusbar-text">{statusText}</span><button type="button" className="ui-btn ui-btn--sm" onClick={onOpenQueue} aria-label={`打开运行中心，当前运行 ${active}/${maxAgents}，排队 ${queued}`}>运行 {active}/{maxAgents} · {queued} 排队</button><span className="ui-statusbar-tech">本机运行</span></footer>;
}
```

- [ ] **Step 5: Update Shell**

Modify `ShellProps`:

```ts
runtimePool?: RuntimePoolSummary;
onStopSession?(sessionId: string): Promise<void> | void;
onReleaseSession?(sessionId: string): Promise<void> | void;
onCancelQueuedSession?(queueId: string): Promise<void> | void;
```

Import `RuntimeCenter`, `RuntimePoolSummary`.
Replace the `queue` drawer contents with:

```tsx
<Drawer open={drawer === 'queue'} title="运行中心" onClose={closeDrawer}>
  <RuntimeCenter
    snapshot={runtimePool ?? { active: 0, queued: 0, maxAgents: MAX_AGENTS, sessions: [], queue: [] }}
    onStop={(id) => props.onStopSession?.(id) ?? Promise.resolve()}
    onRelease={(id) => props.onReleaseSession?.(id) ?? Promise.resolve()}
    onCancelQueue={(id) => props.onCancelQueuedSession?.(id) ?? Promise.resolve()}
  />
</Drawer>
```

Pass `runtimePool` to `StatusBar` instead of computed `runningCount`/`queueCount`. Keep the old computed values only if they are still used by left nav/HomeView; otherwise remove them.

- [ ] **Step 6: Run UI tests**

Run: `pnpm vitest run apps/desktop/test/ui-shell-patterns.test.tsx`
Expected: PASS after updating the old status-bar test to use `runtimePool`.

Update the old test:

```tsx
render(<StatusBar statusText="就绪" runtimePool={{ active: 1, queued: 2, maxAgents: 4, sessions: [], queue: [] }} onOpenQueue={vi.fn()} />);
```

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/patterns/RuntimeCenter.tsx packages/ui/src/patterns/StatusBar.tsx packages/ui/src/patterns/Shell.tsx packages/ui/src/index.ts apps/desktop/test/ui-shell-patterns.test.tsx
git commit -m "feat(ui): add runtime center and wire status bar summary"
```

### Task 5: Wire App and settings

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/shell/SettingsView.tsx`
- Modify: `apps/desktop/src/types/sparkii-api.ts`
- Test: `apps/desktop/test/app-workflow.test.tsx` or a new focused test

- [ ] **Step 1: Write a focused App runtime-pool test**

Use the existing `App` test setup if present; otherwise add:

```tsx
it('derives agent status from the runtime pool snapshot', () => {
  // Render App with a fake window.sparkii that emits a runtime-pool event.
  // Assert the status bar shows the snapshot count and the general agent nav shows queued.
});
```

If the existing test suite already covers `App` with a fake api, extend it.

- [ ] **Step 2: Run to verify failure**

Expected: FAIL because App does not subscribe to runtime pool.

- [ ] **Step 3: Wire App runtime state**

In `App.tsx`, add state:

```ts
const [runtimePool, setRuntimePool] = useState<RuntimePoolSummary>({ active: 0, queued: 0, maxAgents: 4, sessions: [], queue: [] });
```

Subscribe:

```ts
useEffect(() => {
  const off = api.on('runtime-pool', (p: any) => setRuntimePool(mapRuntimePool(p, pending)));
  api.getRuntimePool?.().then((p: any) => setRuntimePool(mapRuntimePool(p, pending))).catch(() => {});
  return off;
}, [api, pending]);
```

`mapRuntimePool` converts agent-host snapshot to `RuntimePoolSummary`:

```ts
function mapRuntimePool(raw: any, pendingApprovals: any[]): RuntimePoolSummary {
  const pendingSessionIds = new Set(pendingApprovals.map((p) => p.sessionId));
  return {
    active: raw.active,
    queued: raw.queued,
    maxAgents: raw.maxAgents,
    sessions: (raw.slots ?? []).map((s: any) => ({
      sessionId: s.sessionId,
      profileName: s.profileName || s.profileId,
      label: s.label || s.sessionId,
      status: pendingSessionIds.has(s.sessionId) ? 'waiting-approval' : s.status === 'streaming' || s.status === 'starting' ? 'running' : 'idle',
    })),
    queue: (raw.queue ?? []).map((q: any) => ({
      queueId: q.queueId,
      profileName: q.profileName || q.profileId,
      label: q.label || q.queueId,
      position: q.position,
    })),
  };
}
```

Derive agent statuses:

```ts
const profileIdFor = (id: ScreenId) => id === 'contract' ? 'contract-review' : id;
const derivedAgents = agents.map((a) => {
  const pid = profileIdFor(a.id);
  const running = runtimePool.sessions.some((s) => s.profileName === pid || s.sessionId.startsWith(pid));
  const queued = runtimePool.queue.some((q) => q.profileName === pid);
  return { ...a, status: running ? 'running' : queued ? 'queued' : 'idle' };
});
```

Pass to `Shell`:

```tsx
agents={derivedAgents}
runtimePool={runtimePool}
onStopSession={(id) => api.abortChat(id)}
onReleaseSession={(id) => api.releaseSessionSlot(id)}
onCancelQueuedSession={(id) => api.cancelQueuedSession(id)}
```

After release, clear active general session if needed:

```ts
const releaseSession = (id: string) => api.releaseSessionSlot(id).then(() => {
  if (id === activeGeneralSession) setActiveGeneralSession(null);
  refreshSessions('general');
});
```

Use `releaseSession` for `onReleaseSession`.

- [ ] **Step 4: Wire settings**

In `SettingsView.tsx` add state:

```ts
const [maxAgents, setMaxAgents] = useState(4);
const [queueEnabled, setQueueEnabled] = useState(true);
```

Load from `getSettings`:

```ts
if (typeof s.maxAgents === 'number') setMaxAgents(s.maxAgents);
if (typeof s.queueEnabled === 'boolean') setQueueEnabled(s.queueEnabled);
```

Save both:

```ts
await api.saveSettings({ activeProviderId: providerId, providers: nextCustom, defaultModel, defaultThinkingLevel, routes, apiKey, maxAgents, queueEnabled });
```

Replace runtime pane:

```tsx
<SettingsRow label="并行智能体上限">
  <Select value={String(maxAgents)} onChange={(e) => setMaxAgents(Number(e.target.value))}>
    {[1,2,3,4,5,6,7,8].map((n) => <option key={n} value={n}>{n}</option>)}
  </Select>
</SettingsRow>
<SettingsRow label="超出上限时排队"><Switch checked={queueEnabled} onCheckedChange={setQueueEnabled} label="超出上限时排队" /></SettingsRow>
```

Keep the other two settings rows as existing placeholders.

- [ ] **Step 5: Run focused and full UI tests**

Run: `pnpm vitest run apps/desktop/test/app-workflow.test.tsx apps/desktop/test/settings.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/App.tsx apps/desktop/src/shell/SettingsView.tsx apps/desktop/src/types/sparkii-api.ts
git commit -m "feat(desktop): consume runtime pool in app and wire settings"
```

### Task 6: Full verification and review

- [ ] Run `pnpm typecheck`
- [ ] Run `pnpm test`
- [ ] Run `pnpm lint`
- [ ] Inspect `git diff --stat`
- [ ] Use verification-before-completion to confirm all commands pass
- [ ] Commit any final fixes
