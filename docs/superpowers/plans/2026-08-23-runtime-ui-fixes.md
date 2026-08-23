# Runtime UI Acceptance Bugfixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four clean-machine acceptance bugs so the packaged app behaves correctly: (1) chat user messages are echoed immediately and errors surface, (2) the selected document is shown in the UI, (3) the contract-review workflow completes after approval and shows progress, (4) the export actually writes a file.

**Architecture:** Keep the approval broker as a single shared instance between the IPC layer and the workflow runner so a human-step approval can resolve the workflow. Add a small `WorkflowStatus` renderer component fed by the existing `sparkii:event:workflow` stream. Make `FileUpload` render its bound state. Make `ChatWorkbench` echo user drafts locally and ignore runtime-echoed user messages to avoid duplicates.

**Tech Stack:** Electron + React 19, TypeScript, Vitest + @testing-library/react (jsdom), esbuild, pnpm workspace, @sparkii/agent-host / @sparkii/approval / @sparkii/connectors.

**Spec:** This plan is the spec. Root causes were confirmed by static trace and by inspecting the stale build artifacts. See the "Root Causes" section below.

## Root Causes (confirmed)

1. **Export writes no file** — stale installer. `apps/desktop/dist-electron/main/index.js` (built 21:52) contains no `registerConnectorHandlers`, and `apps/desktop/out/Sparkii Setup 0.1.0.exe` (21:53) predates the Task 12 commit (`d97f35c`, 22:00). Without registered handlers, `ConnectorExecutor.execute` finds no `report.export` handler and transitions the proposal to `failed`. HEAD code is correct; the fix is to rebuild the installer.
2. **Review never responds** — `runWorkflow` creates its own `createBroker`, while `decideApproval` uses a different broker instance created in `registerIpc`. The workflow's `human` step proposal is resolved only by the workflow broker's `resolvers`, but the approval decision resolves the IPC broker's `resolvers`, so the workflow hangs until `timeoutMs` (300000 ms). `sparkii:event:state` is never emitted, so the risk/report widgets never populate. The renderer also never subscribes to `sparkii:event:workflow`, so there is no progress or error feedback.
3. **Selected file not shown** — `FileUpload` in `apps/desktop/src/composer/registry.tsx` is a button that ignores its `bind`/`state`; nothing renders `state.documents`.
4. **First chat message slow + user message missing** — Pi runtime cold start (utilityProcess boot + SDK init) has no loading indicator; `ChatWorkbench` never echoes the user draft and swallows prompt errors. (The runtime does forward `message_end` for user messages, but the renderer should not depend on that; echo locally and ignore runtime user echoes to avoid duplication.)

## Global Constraints

- Node is not on PATH. Prepend: `C:\Users\YDJ\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin`.
- `pnpm` 11 is on PATH. Any `pnpm install` must add `--dangerously-allow-all-builds`.
- `.git` is read-only: `git add` / `git commit` require escalation.
- Sandbox denies reading `node_modules/.pnpm`: `vitest` / `pnpm` / `esbuild` / `electron` commands require escalation.
- Do not add new dependencies. `package.json` / `pnpm-lock.yaml` must stay unchanged.
- TDD per task: write failing test → run and confirm failure → minimal implementation → run and confirm pass → commit.
- Commit messages follow the existing conventional-commit style (scope: `desktop` or `agent-host`).

---

### Task 1: Share the approval broker between workflow and decideApproval

**Files:**
- Modify: `apps/desktop/electron/main/workflow.ts`
- Modify: `apps/desktop/electron/main/ipc.ts`
- Test: `apps/desktop/test/workflow-broker.test.ts`

**Interfaces:**
- Consumes: existing `createBroker(rt, getWindow)` and `runWorkflow(rt, getWindow, input)`.
- Produces: `runWorkflow(rt: Runtime, getWindow: () => BrowserWindow | null, input: Record<string, unknown>, broker: ReturnType<typeof createBroker>): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/workflow-broker.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createBroker, runWorkflow } from '../electron/main/workflow.js';

describe('runWorkflow broker sharing', () => {
  it('completes the human step when the shared broker decides approval', async () => {
    const send = vi.fn();
    const getWindow = () => ({ webContents: { send } }) as any;
    const rt = {
      profile: {
        manifest: { name: 'contract-review' },
        security: { approval: { timeoutMs: 50 } },
        agent: { workflow: { version: 1, engine: 'linear', steps: [{ id: 'review', type: 'human', inputs: { from: 'x' } }] } },
      },
      subject: { userId: 'admin' },
      gate: {
        submit: async (req: any) => ({ id: 'p1', ...req, status: 'pending', payloadHash: 'h', createdAt: Date.now() }),
        expire: async (id: string) => ({ id, status: 'expired' }),
      },
    } as any;

    const broker = createBroker(rt, getWindow);
    const running = runWorkflow(rt, getWindow, { documents: [] }, broker);
    await new Promise((r) => setTimeout(r, 0));

    expect(send).toHaveBeenCalledWith('sparkii:event:approval', expect.objectContaining({ id: 'p1' }));
    broker.decide('p1', { approved: true, status: 'approved', result: undefined });
    await running;

    expect(send).toHaveBeenCalledWith('sparkii:event:state', expect.objectContaining({
      workflow: { result: expect.objectContaining({ review: { proposalId: 'p1', status: 'approved' } }) },
    }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/desktop/test/workflow-broker.test.ts`
Expected: FAIL — the workflow resolves with `review.status` `"denied"` (or times out at 50ms), not `"approved"`.

- [ ] **Step 3: Write minimal implementation**

In `apps/desktop/electron/main/workflow.ts`, change the signature and remove the local broker:

```ts
export async function runWorkflow(
  rt: Runtime,
  getWindow: () => BrowserWindow | null,
  input: Record<string, unknown>,
  broker: ReturnType<typeof createBroker>,
): Promise<void> {
  const def = rt.profile.agent.workflow as unknown as WorkflowDef;
  const ctx: RunContext = {
    profileId: rt.profile.manifest.name, sessionId: 'default', actor: rt.subject?.userId ?? 'agent', input,
    sendPrompt: (text, task) => sendPrompt(rt, text, (task as ModelTask) ?? 'default'),
    runTool: (name, args) => runTool(rt, broker, name, args, 'default'),
    requestApproval: async (req) => {
      const d = await broker.request(req, 'default');
      return { id: d.proposalId, status: d.approved ? 'approved' : 'denied' } as any;
    },
  };
  const win = getWindow();
  let finalState: Record<string, unknown> = {};
  for await (const e of new LinearRunner().run(def, ctx)) {
    win?.webContents.send('sparkii:event:workflow', e);
    if (e.type === 'workflow_completed') finalState = e.result as Record<string, unknown>;
  }
  win?.webContents.send('sparkii:event:state', { workflow: { result: finalState } });
}
```

Delete the line `const broker = createBroker(rt, getWindow);` that was inside `runWorkflow`.

In `apps/desktop/electron/main/ipc.ts`, pass the existing broker:

```ts
ipcMain.handle('sparkii:runWorkflow', async (_e, _id: string, input: Record<string, unknown>) => {
  await runWorkflow(rt, getWindow, input, broker);
  return { ok: true };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run apps/desktop/test/workflow-broker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/workflow.ts apps/desktop/electron/main/ipc.ts apps/desktop/test/workflow-broker.test.ts
git commit -m "fix(desktop): share approval broker between workflow and decide"
```

---

### Task 2: Show workflow progress and errors in the renderer

**Files:**
- Create: `apps/desktop/src/workbench/WorkflowStatus.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Test: `apps/desktop/test/workflow-status.test.tsx`
- Test: `apps/desktop/test/app-workflow.test.tsx`

**Interfaces:**
- Consumes: `api.on('workflow', cb)` which maps to the `sparkii:event:workflow` events emitted by `runWorkflow` (`step_started`, `workflow_completed`, `workflow_failed`, …).
- Produces: `WorkflowStatus` component with prop `state: { status: 'idle'|'running'|'done'|'failed'; step?: string; error?: string }`.

- [ ] **Step 1: Write the failing component test**

Create `apps/desktop/test/workflow-status.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkflowStatus } from '../src/workbench/WorkflowStatus.js';

describe('WorkflowStatus', () => {
  it('renders running with step', () => {
    render(<WorkflowStatus state={{ status: 'running', step: 'load' }} />);
    expect(screen.getByText('审核中：load')).toBeTruthy();
  });
  it('renders failure with error', () => {
    render(<WorkflowStatus state={{ status: 'failed', error: 'boom' }} />);
    expect(screen.getByText('审核失败：boom')).toBeTruthy();
  });
  it('renders nothing when idle', () => {
    const { container } = render(<WorkflowStatus state={{ status: 'idle' }} />);
    expect(container.querySelector('[data-testid="workflow-status"]')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/desktop/test/workflow-status.test.tsx`
Expected: FAIL with module-not-found (component does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/workbench/WorkflowStatus.tsx`:

```tsx
export type WorkflowStatusState = {
  status: 'idle' | 'running' | 'done' | 'failed';
  step?: string;
  error?: string;
};

export function WorkflowStatus(props: { state: WorkflowStatusState }) {
  const { status, step, error } = props.state;
  if (status === 'idle') return null;
  if (status === 'running') return <div data-testid="workflow-status">审核中：{step ?? '…'}</div>;
  if (status === 'failed') return <div data-testid="workflow-status">审核失败：{error ?? '未知错误'}</div>;
  return <div data-testid="workflow-status">审核完成</div>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run apps/desktop/test/workflow-status.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing App wiring test**

Create `apps/desktop/test/app-workflow.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { App } from '../src/App.js';

const HOME = {
  page: 'contract-review/home',
  layout: { type: 'grid', columns: 2 },
  widgets: [
    { id: 'upload', type: 'file-upload', bind: 'documents' },
    { id: 'review', type: 'action-button', action: 'run-workflow:contract-review' },
    { id: 'risk', type: 'table', bind: 'workflow.result.compare' },
    { id: 'report', type: 'doc-preview', bind: 'workflow.result.report' },
    { id: 'export', type: 'action-button', action: 'export-report' },
  ],
};

function makeApi() {
  const channels: Record<string, (p: any) => void> = {};
  const api = {
    on: vi.fn((channel: string, cb: any) => { channels[channel] = cb; return () => {}; }),
    login: vi.fn().mockResolvedValue({ userId: 'admin', roles: ['admin'] }),
    getProfile: vi.fn().mockResolvedValue({ pages: { home: HOME } }),
    listPendingApprovals: vi.fn().mockResolvedValue([]),
    chooseDocument: vi.fn(),
    runWorkflow: vi.fn().mockResolvedValue({ ok: true }),
    exportReport: vi.fn(),
    prompt: vi.fn().mockResolvedValue({ ok: true }),
    decideApproval: vi.fn(),
    queryAudit: vi.fn().mockResolvedValue([]),
  };
  (window as any).sparkii = api;
  return { api, channels };
}

describe('App workflow feedback', () => {
  it('shows workflow status from workflow events', async () => {
    const { api, channels } = makeApi();
    render(<App />);
    fireEvent.change(screen.getByPlaceholderText('用户名'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: 'admin123' } });
    fireEvent.click(screen.getByText('登录'));
    await screen.findByTestId('review');
    fireEvent.click(screen.getByTestId('review'));
    expect(api.runWorkflow).toHaveBeenCalledWith('contract-review', { documents: [] });
    act(() => channels['workflow']({ type: 'step_started', stepId: 'load' }));
    expect(screen.getByText('审核中：load')).toBeTruthy();
    act(() => channels['workflow']({ type: 'workflow_completed' }));
    expect(screen.getByText('审核完成')).toBeTruthy();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm exec vitest run apps/desktop/test/app-workflow.test.tsx`
Expected: FAIL — clicking review never renders `审核中：load` (App does not subscribe to `workflow` yet).

- [ ] **Step 7: Wire WorkflowStatus into App.tsx**

In `apps/desktop/src/App.tsx`, add the import:

```tsx
import { WorkflowStatus, type WorkflowStatusState } from './workbench/WorkflowStatus.js';
```

Add state and subscription alongside the existing `state`/`approval` subscriptions:

```tsx
const [workflow, setWorkflow] = useState<WorkflowStatusState>({ status: 'idle' });
useEffect(() => api.on('workflow', (e: any) => {
  if (e.type === 'step_started') setWorkflow({ status: 'running', step: e.stepId });
  else if (e.type === 'workflow_completed') setWorkflow({ status: 'done' });
  else if (e.type === 'workflow_failed') setWorkflow({ status: 'failed', error: e.error?.message });
}), [api]);
```

In `onAction`, set running state when review is clicked:

```tsx
if (action === 'run-workflow:contract-review') {
  setWorkflow({ status: 'running' });
  api.runWorkflow('contract-review', { documents: state.documents });
}
```

Render the status at the top of the authed layout:

```tsx
<div>
  <WorkflowStatus state={workflow} />
  {page && validatePageSchema(page).ok ? <PageComposer schema={page} state={state} onAction={onAction} /> : null}
  <ChatWorkbench api={api} />
  ...
</div>
```

- [ ] **Step 8: Run both tests to verify they pass**

Run: `pnpm exec vitest run apps/desktop/test/workflow-status.test.tsx apps/desktop/test/app-workflow.test.tsx`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/workbench/WorkflowStatus.tsx apps/desktop/src/App.tsx apps/desktop/test/workflow-status.test.tsx apps/desktop/test/app-workflow.test.tsx
git commit -m "feat(desktop): show workflow progress and errors in renderer"
```

---

### Task 3: Display the selected document in the file-upload widget

**Files:**
- Modify: `apps/desktop/src/composer/registry.tsx`
- Test: `apps/desktop/test/file-upload.test.tsx`

**Interfaces:**
- Consumes: `WidgetProps` (`id`, `bind?`, `state`, `onAction`).
- Produces: `FileUpload` renders each value at `state[bind]` under `data-testid="<id>-selected"`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/file-upload.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { widgetRegistry } from '../src/composer/registry.js';

describe('FileUpload widget', () => {
  it('shows the selected document path', () => {
    const FileUpload = widgetRegistry['file-upload'];
    render(<FileUpload id="upload" bind="documents" state={{ documents: ['C:/tmp/contract.pdf'] }} onAction={() => {}} />);
    expect(screen.getByText('C:/tmp/contract.pdf')).toBeTruthy();
  });
  it('shows nothing when no document selected', () => {
    const FileUpload = widgetRegistry['file-upload'];
    const { container } = render(<FileUpload id="upload" bind="documents" state={{ documents: [] }} onAction={() => {}} />);
    expect(container.querySelector('[data-testid="upload-selected"]')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/desktop/test/file-upload.test.tsx`
Expected: FAIL — the path is not rendered.

- [ ] **Step 3: Write minimal implementation**

In `apps/desktop/src/composer/registry.tsx`, replace the `FileUpload` component:

```tsx
function FileUpload(props: WidgetProps) {
  const value = getByPath(props.state, props.bind);
  const files = Array.isArray(value) ? value : value != null ? [value] : [];
  return (
    <div>
      <button data-testid={props.id} onClick={() => props.onAction('documents.upload')}>选择合同</button>
      {files.map((f, i) => <span key={i} data-testid={`${props.id}-selected`}>{String(f)}</span>)}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run apps/desktop/test/file-upload.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composer/registry.tsx apps/desktop/test/file-upload.test.tsx
git commit -m "feat(desktop): display selected document in file-upload widget"
```

---

### Task 4: Echo chat drafts, surface errors, and avoid duplicate user messages

**Files:**
- Modify: `apps/desktop/src/workbench/ChatWorkbench.tsx`
- Test: `apps/desktop/test/chat-workbench.test.tsx`

**Interfaces:**
- Consumes: `props.api.on('chat-event', cb)` and `props.api.prompt(text)`.
- Produces: user drafts are appended locally on send; runtime `role === 'user'` messages are ignored; prompt rejection is shown in a `role="alert"` element; the send button shows `发送中…` while busy.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/chat-workbench.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ChatWorkbench } from '../src/workbench/ChatWorkbench.js';

function makeApi(promptImpl: () => Promise<unknown> = () => Promise.resolve({ ok: true })) {
  const channels: Record<string, (p: any) => void> = {};
  const api = {
    on: vi.fn((channel: string, cb: any) => { channels[channel] = cb; return () => {}; }),
    prompt: vi.fn(promptImpl),
  };
  return { api: api as any, channels };
}

describe('ChatWorkbench', () => {
  it('echoes the user draft immediately and does not duplicate runtime user echo', () => {
    const { api, channels } = makeApi();
    render(<ChatWorkbench api={api} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByText('发送'));
    expect(api.prompt).toHaveBeenCalledWith('hello');
    expect(screen.getByText('user: hello')).toBeTruthy();
    act(() => channels['chat-event']({ type: 'message', role: 'user', text: 'hello' }));
    expect(screen.getAllByText('user: hello')).toHaveLength(1);
    act(() => channels['chat-event']({ type: 'message', role: 'assistant', delta: 'Hi' }));
    expect(screen.getByText('assistant: Hi')).toBeTruthy();
  });

  it('shows an error when prompt rejects', async () => {
    const { api } = makeApi(() => Promise.reject(new Error('prompt timeout')));
    render(<ChatWorkbench api={api} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText(/prompt timeout/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/desktop/test/chat-workbench.test.tsx`
Expected: FAIL — no echoed `user: hello` and no `role="alert"` on rejection.

- [ ] **Step 3: Write minimal implementation**

Replace `apps/desktop/src/workbench/ChatWorkbench.tsx` with:

```tsx
import { useEffect, useState } from 'react';
import type { SparkiiApi } from '../types/sparkii-api.js';

type Msg = { role: string; text: string; streaming: boolean };

export function ChatWorkbench(props: { api: SparkiiApi }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => props.api.on('chat-event', (p: any) => {
    if (p?.type !== 'message') return;
    const role = p.role ?? 'assistant';
    if (role === 'user') return; // user messages are echoed locally
    if (typeof p.delta === 'string') {
      setMsgs((xs) => {
        const last = xs[xs.length - 1];
        if (last && last.role === role && last.streaming) return [...xs.slice(0, -1), { ...last, text: last.text + p.delta }];
        return [...xs, { role, text: p.delta, streaming: true }];
      });
    } else if (typeof p.text === 'string') {
      setMsgs((xs) => {
        const last = xs[xs.length - 1];
        if (last && last.role === role && last.streaming) return [...xs.slice(0, -1), { role, text: p.text, streaming: false }];
        return [...xs, { role, text: p.text, streaming: false }];
      });
    }
  }), [props.api]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setMsgs((xs) => [...xs, { role: 'user', text, streaming: false }]);
    setDraft('');
    setBusy(true);
    setError('');
    props.api.prompt(text).catch((e: any) => setError(String(e?.message ?? e))).finally(() => setBusy(false));
  };

  return (
    <div>
      <div>{msgs.map((m, i) => <div key={i}>{m.role}: {m.text}</div>)}</div>
      {error && <div role="alert">{error}</div>}
      <input value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button onClick={send} disabled={busy}>{busy ? '发送中…' : '发送'}</button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run apps/desktop/test/chat-workbench.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/workbench/ChatWorkbench.tsx apps/desktop/test/chat-workbench.test.tsx
git commit -m "feat(desktop): echo chat drafts and surface prompt errors"
```

---

### Task 5: Tighten the pilot test and rebuild/verify

**Files:**
- Modify: `apps/desktop/e2e/pilot.spec.ts`
- (No new source files; verification only.)

- [ ] **Step 1: Close the pilot blind spot**

In `apps/desktop/e2e/pilot.spec.ts`, after clicking `批准`, also assert the workflow actually completes:

```ts
await page.getByRole('button', { name: '批准' }).click();
await expect(page.getByText(/proposal.approved/)).toBeVisible();
await expect(page.getByText('审核完成')).toBeVisible({ timeout: 120000 });
```

- [ ] **Step 2: Run the full test suite and type check**

Run (escalated):

```powershell
$env:Path = "C:\Users\YDJ\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;" + $env:Path
pnpm test
pnpm --filter @sparkii/desktop run build:main:check
```

Expected: all tests pass; type check exits 0.

- [ ] **Step 3: Rebuild renderer + main**

Run (escalated):

```powershell
pnpm --filter @sparkii/desktop run build:renderer
pnpm --filter @sparkii/desktop run build:main
```

- [ ] **Step 4: Verify the new bundle includes the fixes**

```powershell
rg -n "registerConnectorHandlers|审核完成|WorkflowStatus" apps/desktop/dist-electron/main/index.js apps/desktop/dist/index.html apps/desktop/dist/assets -g '!*.map'
```

Expected: `registerConnectorHandlers` appears in `dist-electron/main/index.js`; the status strings are bundled into the renderer assets.

- [ ] **Step 5: Run the e2e pilot**

Run (escalated):

```powershell
pnpm --filter @sparkii/desktop exec playwright test e2e/pilot.spec.ts
```

Expected: 1 passed (including the new `审核完成` assertion).

- [ ] **Step 6: Build the Windows installer**

Run (escalated):

```powershell
pnpm --filter @sparkii/desktop run dist
```

Expected: NSIS + AppX artifacts produced under `apps/desktop/out/`.

- [ ] **Step 7: Commit the pilot test change**

```bash
git add apps/desktop/e2e/pilot.spec.ts
git commit -m "test(desktop): assert workflow completion in pilot"
```

---

## Self-Review

- **Spec coverage:** Export (Task 5 rebuild + existing `registerConnectorHandlers`), Review hang (Task 1), Review progress (Task 2), selected-file display (Task 3), chat echo/error (Task 4). All four reported symptoms are covered.
- **Placeholder scan:** No TBD/TODO; all code blocks are concrete.
- **Type consistency:** `runWorkflow` 4th param `ReturnType<typeof createBroker>` matches the `createBroker` import in the test; `WorkflowStatusState` is defined in Task 2 and imported by App; `FileUpload` uses existing `getByPath`/`WidgetProps` from `registry.tsx`.
