# Runtime Pilot Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the end-to-end contract-review pilot pass reliably: the workflow must not hang during Pi runtime cold start, the model must not autonomously trigger write approvals during workflow LLM steps, and the pilot must allow enough time for real DeepSeek calls.

**Architecture:** Add a readiness handshake and timeouts to the Pi runtime client so commands are only sent after the child process finishes booting and never hang forever. Add a `readOnly` prompt mode so workflow LLM steps run with only read tools (`document.read`, `knowledge.search`) and cannot trigger spurious write approvals, while the interactive chat assistant keeps all tools — including `report.export`, whose writes remain gated by user approval. Widen the pilot timeouts.

**Tech Stack:** TypeScript, Vitest, @sparkii/agent-host, Electron utilityProcess/fork transport, Playwright e2e.

**Spec:** This plan is the spec. Root causes are documented below.

## Root Causes (confirmed by the Task 5 pilot run)

1. **Workflow hangs at the first LLM step.** `PiRuntimeSupervisor.start()` spawns the utility process and returns immediately, but the child only registers its command handler inside `createPiRuntime` after `createPiSdkSessionHost` (slow boot) resolves. `PiRuntimeClientImpl.send()` posts a command and waits forever with no timeout, and child exit does not reject pending sends. A slow/lost boot therefore stalls `selectModel`/`sendPrompt` indefinitely (pilot run 2/3 stuck at `审核中：extract`, no session file created).
2. **Model autonomously calls `report.export` during workflow LLM steps.** `createPiSdkSessionHost` registers all three connectors as Pi tools, including the write tool `report.export`. During the workflow `report` LLM step the DeepSeek model calls `report.export`, which opens a write-approval dialog that competes with the `review` (human) approval; run 1 produced 9 spurious `report.export` proposals. Fix: workflow LLM steps use a `readOnly` prompt (only read tools, no write tool), while chat keeps write tools gated by approval.
3. **Pilot timeouts are too tight** for cold start + three real model calls + human approval (dialog 120s, test 180s).

## Global Constraints

- Node is not on PATH. Prepend: `C:\Users\YDJ\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin`.
- `pnpm` 11 is on PATH. No new dependencies; `pnpm install` is not needed and is network-restricted.
- `.git` is read-only: `git add` / `git commit` require escalation.
- Sandbox denies reading `node_modules/.pnpm`: `vitest` / `pnpm` / `esbuild` / `electron` / `playwright` / `electron-builder` commands require escalation.
- TDD per task. Commit messages use conventional-commit scope `agent-host` or `desktop`.
- Do not modify `package.json` / `pnpm-lock.yaml`.

---

### Task 6: Pi runtime readiness handshake + send timeout + exit rejection

**Files:**
- Modify: `packages/agent-host/src/pi-runtime-transport.ts`
- Modify: `packages/agent-host/src/pi-runtime.ts`
- Modify: `packages/agent-host/src/pi-runtime-supervisor.ts`
- Test: `packages/agent-host/test/pi-runtime-transport.test.ts`
- Test: `packages/agent-host/test/pi-runtime.test.ts`
- Test: `packages/agent-host/test/pi-runtime-supervisor.test.ts`

**Interfaces:**
- Consumes: existing `PiRuntimeEnvelope`, `PiRuntimeHostHandle`, `PiRuntimeClient`, `createPiRuntime`, `PiRuntimeSupervisor`.
- Produces:
  - `readyEnvelope(): PiRuntimeEnvelope` returning `{ direction: "runtime-to-main"; ready: true }`.
  - `PiRuntimeClient.send(command: RpcCommand): Promise<RpcResponse>` now waits for readiness (default 60s) and rejects on response timeout (default 300s) or child exit.

- [ ] **Step 1: Extend the transport envelope**

In `packages/agent-host/src/pi-runtime-transport.ts`, add the `ready` variant and helper:

```ts
export type PiRuntimeEnvelope =
  | { direction: "main-to-runtime"; id: string; command: RpcCommand }
  | { direction: "runtime-to-main"; id: string; response: RpcResponse }
  | { direction: "runtime-to-main"; event: NormalizedEvent }
  | { direction: "runtime-to-main"; ready: true }
  | { direction: "runtime-to-main"; proposal: ProposalRequest & { requestId: string } }
  | { direction: "main-to-runtime"; requestId: string; proposalDecision: ProposalDecision };

export function readyEnvelope(): PiRuntimeEnvelope {
  return { direction: "runtime-to-main", ready: true };
}
```

- [ ] **Step 2: Emit ready from the child after the command handler is registered**

In `packages/agent-host/src/pi-runtime.ts`, import `readyEnvelope`, and immediately after the `opts.transport.onMessage(...)` registration inside `createPiRuntime`, add:

```ts
opts.transport.postMessage(readyEnvelope());
```

- [ ] **Step 3: Write the failing transport test**

In `packages/agent-host/test/pi-runtime-transport.test.ts`, import `readyEnvelope` and add:

```ts
expect(readyEnvelope()).toMatchObject({ direction: "runtime-to-main", ready: true });
```

- [ ] **Step 4: Run to verify failure**

Run: `pnpm exec vitest run packages/agent-host/test/pi-runtime-transport.test.ts`
Expected: FAIL (missing export) before Steps 1-2 land; PASS after.

- [ ] **Step 5: Write the failing child-ready test**

In `packages/agent-host/test/pi-runtime.test.ts`, import `readyEnvelope` and in the first `createPiRuntime` test assert:

```ts
expect(sent).toContainEqual(readyEnvelope());
```

Run to confirm it fails before Step 2, passes after.

- [ ] **Step 6: Implement readiness + timeout + exit rejection in the supervisor**

In `packages/agent-host/src/pi-runtime-supervisor.ts`, replace `PiRuntimeClientImpl` with the version below, and update `PiRuntimeSupervisor` to hold a `PiRuntimeClientImpl`, pass timeouts, and reject pending sends on exit.

```ts
class PiRuntimeClientImpl implements PiRuntimeClient {
  private pending = new Map<string, {
    resolve: (r: RpcResponse) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private listeners = new Set<(event: NormalizedEvent) => void>();
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (e: Error) => void;

  constructor(
    private handle: PiRuntimeHostHandle,
    private onProposal: ProposalHandler,
    private sendTimeoutMs = 300_000,
    private readinessTimeoutMs = 60_000,
  ) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    handle.onMessage((envelope) => void this.consume(envelope));
  }

  async send(command: RpcCommand): Promise<RpcResponse> {
    await Promise.race([
      this.readyPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`runtime not ready after ${this.readinessTimeoutMs}ms`)), this.readinessTimeoutMs)),
    ]);
    const id = randomUUID();
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`command ${command.type} timed out after ${this.sendTimeoutMs}ms`));
      }, this.sendTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.handle.postMessage(commandEnvelope(id, command));
    });
  }

  onEvent(callback: (event: NormalizedEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  close(): void {
    this.failPending(new Error("runtime closed"));
    this.listeners.clear();
  }

  failPending(error: Error): void {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    this.rejectReady(error);
  }

  private async consume(envelope: PiRuntimeEnvelope): Promise<void> {
    if ("ready" in envelope) { this.resolveReady(); return; }
    if ("response" in envelope) {
      const key = envelope.response.id ?? envelope.id;
      const entry = this.pending.get(key);
      if (entry) { this.pending.delete(key); clearTimeout(entry.timer); entry.resolve(envelope.response); }
      return;
    }
    if ("event" in envelope) {
      for (const listener of this.listeners) listener(envelope.event);
      return;
    }
    if ("proposal" in envelope) {
      try {
        const decision = await this.onProposal(envelope.proposal);
        this.handle.postMessage(proposalDecisionEnvelope(envelope.proposal.requestId, decision));
      } catch {
        this.handle.postMessage(proposalDecisionEnvelope(envelope.proposal.requestId, {
          approved: false,
          proposalId: envelope.proposal.requestId,
          status: "denied",
        }));
      }
    }
  }
}
```

In `PiRuntimeSupervisor`, change the `client` field type to `PiRuntimeClientImpl`, accept an options object, and reject pending on exit:

```ts
export class PiRuntimeSupervisor {
  private client?: PiRuntimeClientImpl;
  private handle?: PiRuntimeHostHandle;
  private exitCbs = new Set<(code: number | null) => void>();
  private proposalCb: ProposalHandler = async () => ({
    approved: false,
    proposalId: "unhandled",
    status: "denied",
  });

  constructor(
    private makeHandle: () => PiRuntimeHostHandle,
    private opts: { sendTimeoutMs?: number; readinessTimeoutMs?: number } = {},
  ) {}

  async start(): Promise<PiRuntimeClient> {
    if (this.client) return this.client;
    const handle = this.makeHandle();
    this.handle = handle;
    this.client = new PiRuntimeClientImpl(
      handle,
      (request) => this.proposalCb(request),
      this.opts.sendTimeoutMs,
      this.opts.readinessTimeoutMs,
    );
    handle.onExit((code) => {
      this.client?.failPending(new Error(`runtime exited with code ${code}`));
      this.client = undefined;
      this.handle = undefined;
      for (const cb of this.exitCbs) cb(code);
    });
    return this.client;
  }
  // stop/onExit/onProposal bodies remain unchanged
}
```

- [ ] **Step 7: Update the existing supervisor tests for the ready signal**

In `packages/agent-host/test/pi-runtime-supervisor.test.ts`, in the first test emit `readyEnvelope()` before sending:

```ts
it("starts idempotently and sends commands", async () => {
  const handle = new FakeHandle();
  const sup = new PiRuntimeSupervisor(() => handle);
  const a = await sup.start();
  const b = await sup.start();
  expect(a).toBe(b);
  handle.emit(readyEnvelope());
  const p = a.send({ type: "abort" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const sent = handle.sent[0];
  expect(sent).toMatchObject({ direction: "main-to-runtime", command: { type: "abort" } });
  const id = "id" in sent ? sent.id : "";
  handle.emit(responseEnvelope(id, { id, type: "response", command: "abort", success: true }));
  await expect(p).resolves.toMatchObject({ success: true });
});
```

Add timeout/exit tests:

```ts
it("rejects send when no response arrives", async () => {
  const handle = new FakeHandle();
  const sup = new PiRuntimeSupervisor(() => handle, { readinessTimeoutMs: 1000, sendTimeoutMs: 100 });
  const client = await sup.start();
  handle.emit(readyEnvelope());
  await expect(client.send({ type: "abort" })).rejects.toThrow(/timed out/);
});

it("rejects pending sends when the child exits", async () => {
  const handle = new FakeHandle();
  const sup = new PiRuntimeSupervisor(() => handle, { readinessTimeoutMs: 1000, sendTimeoutMs: 5000 });
  const client = await sup.start();
  handle.emit(readyEnvelope());
  const p = client.send({ type: "abort" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  handle.kill();
  await expect(p).rejects.toThrow(/exited/);
});
```

- [ ] **Step 8: Run the agent-host tests**

Run: `pnpm exec vitest run packages/agent-host/test`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add packages/agent-host/src/pi-runtime-transport.ts packages/agent-host/src/pi-runtime.ts packages/agent-host/src/pi-runtime-supervisor.ts packages/agent-host/test/pi-runtime-transport.test.ts packages/agent-host/test/pi-runtime.test.ts packages/agent-host/test/pi-runtime-supervisor.test.ts
git commit -m "feat(agent-host): add Pi runtime readiness and send timeouts"
```

---

### Task 7: Read-only prompt for workflow LLM steps (chat keeps write tools)

**Files:**
- Modify: `packages/agent-host/src/types.ts`
- Modify: `packages/agent-host/src/pi-runtime.ts`
- Modify: `packages/agent-host/src/pi-sdk-runtime.ts`
- Modify: `apps/desktop/electron/main/workflow.ts`
- Test: `packages/agent-host/test/pi-runtime.test.ts`

**Interfaces:**
- Consumes: existing `RpcCommand`, `PiRuntimeSession`, `createPiRuntime`, `sendPrompt`.
- Produces:
  - `RpcCommand` prompt variant gains `readOnly?: boolean`.
  - `PiRuntimeSession.prompt(text, options?: { streamingBehavior?: "steer" | "followUp"; readOnly?: boolean })`.
  - The session host builds two tool sets — full `piTools` and a read-only `readPiTools` (only `sideEffect === "read"` tools). `adaptSession.prompt` sets `session.agent.state.tools = readPiTools` when `readOnly`, otherwise `piTools` (chat keeps `report.export`, still gated by approval).
  - `workflow.ts` `sendPrompt` sends `{ type: "prompt", message: text, readOnly: true }`.

- [ ] **Step 1: Write the failing test**

In `packages/agent-host/test/pi-runtime.test.ts`, add a case asserting the `readOnly` flag flows through to the session:

```ts
it("passes readOnly flag to the session prompt", async () => {
  const session = fakeSession();
  const host: PiRuntimeSessionHost = { current: () => session, newSession: vi.fn(async () => {}), switchSession: vi.fn(async () => {}) };
  const sent: PiRuntimeEnvelope[] = [];
  const transport = {
    postMessage: (env: PiRuntimeEnvelope) => sent.push(env),
    onMessage: (cb: (env: PiRuntimeEnvelope) => void) => { (transport as any).emit = cb; return () => {}; },
  } as any;
  createPiRuntime({ host, transport });
  transport.emit(commandEnvelope("r1", { type: "prompt", message: "hi", readOnly: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(session.prompt).toHaveBeenCalledWith("hi", { streamingBehavior: undefined, readOnly: true });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run packages/agent-host/test/pi-runtime.test.ts`
Expected: FAIL — the session is currently called with `{ streamingBehavior: undefined }` (no `readOnly`).

- [ ] **Step 3: Implement the `readOnly` flag plumbing**

In `packages/agent-host/src/types.ts`, change the prompt variant:

```ts
| { type: 'prompt'; message: string; streamingBehavior?: 'steer' | 'followUp'; readOnly?: boolean }
```

In `packages/agent-host/src/pi-runtime.ts`, widen `PiRuntimeSession.prompt`:

```ts
prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp"; readOnly?: boolean }): Promise<void>;
```

And in `handleCommand`:

```ts
case "prompt":
  await session.prompt(command.message, { streamingBehavior: command.streamingBehavior, readOnly: command.readOnly });
  return;
```

- [ ] **Step 4: Build a read-only tool set and apply it**

In `packages/agent-host/src/pi-sdk-runtime.ts`, extract the `propose` callback and build both tool sets:

```ts
const propose = async (request: ProposalRequest & { requestId: string }) =>
  new Promise<ProposalDecision>((resolve, reject) => {
    pendingProposals.set(request.requestId, { resolve, reject });
    options.transport.postMessage(proposalEnvelope(request));
  });

const piTools = buildPiRuntimeTools({ tools, propose }).map((tool) => defineTool(tool as any));

const readPiTools = buildPiRuntimeTools({
  tools: tools.filter((t) => t.sideEffect === "read"),
  propose,
}).map((tool) => defineTool(tool as any));
```

Then change `adaptSession().prompt`:

```ts
prompt: (text, promptOptions) => {
  session.agent.state.tools = promptOptions?.readOnly ? readPiTools : piTools;
  const { readOnly: _readOnly, ...sdkOptions } = promptOptions ?? {};
  return session.prompt(text, sdkOptions);
},
```

(Keep the existing `session.agent.state.tools = piTools;` line at the top of `adaptSession` unchanged, and remove the old inline `propose` that is now extracted.)

- [ ] **Step 5: Route workflow LLM steps as read-only**

In `apps/desktop/electron/main/workflow.ts`, in `sendPrompt`, change the prompt send to:

```ts
const resp = await client.send({ type: 'prompt', message: text, readOnly: true });
```

- [ ] **Step 6: Run to verify pass**

Run: `pnpm exec vitest run packages/agent-host/test`
Expected: PASS (the new test plus all existing agent-host tests).

- [ ] **Step 7: Commit**

```bash
git add packages/agent-host/src/types.ts packages/agent-host/src/pi-runtime.ts packages/agent-host/src/pi-sdk-runtime.ts apps/desktop/electron/main/workflow.ts packages/agent-host/test/pi-runtime.test.ts
git commit -m "feat(agent-host): add read-only prompt for workflow LLM steps"
```

---

### Task 8: Widen pilot timeouts and rebuild/verify

**Files:**
- Modify: `apps/desktop/e2e/pilot.spec.ts`

- [ ] **Step 1: Widen the pilot timeouts**

In `apps/desktop/e2e/pilot.spec.ts`:

```ts
test.setTimeout(360_000);
await expect(page.getByRole('dialog')).toBeVisible({ timeout: 300000 });
await expect(page.getByText('审核完成')).toBeVisible({ timeout: 300000 });
```

- [ ] **Step 2: Run full unit tests + type check**

```powershell
$env:Path = "C:\Users\YDJ\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;" + $env:Path
pnpm test
pnpm --filter @sparkii/desktop run build:main:check
```

Expected: all pass, tsc exit 0.

- [ ] **Step 3: Rebuild renderer + main**

```powershell
pnpm --filter @sparkii/desktop run build:renderer
pnpm --filter @sparkii/desktop run build:main
```

- [ ] **Step 4: Run the e2e pilot**

```powershell
pnpm --filter @sparkii/desktop exec playwright test e2e/pilot.spec.ts
```

Expected: 1 passed. If it still hangs, capture `SPARKII_DATA_DIR` logs and report the exact step + any child exit code; do not fake success.

- [ ] **Step 5: Commit the pilot change**

```bash
git add apps/desktop/e2e/pilot.spec.ts
git commit -m "test(desktop): widen pilot timeouts for live model calls"
```

---

## Self-Review

- **Spec coverage:** Hang (Task 6), spurious write approvals via read-only workflow prompts while chat keeps write tools (Task 7), pilot timeouts (Task 8). All three root causes are addressed.
- **Placeholder scan:** No TBD/TODO; `stop`/`onExit`/`onProposal` are referenced as unchanged to avoid duplicating verified code.
- **Type consistency:** `readOnly?: boolean` appears in `RpcCommand`, `PiRuntimeSession.prompt`, and `handleCommand`; `readPiTools` is derived from `tools.filter((t) => t.sideEffect === "read")`; `readyEnvelope()` matches the new `PiRuntimeEnvelope` variant; `send(command: RpcCommand)` matches the `PiRuntimeClient` interface.
