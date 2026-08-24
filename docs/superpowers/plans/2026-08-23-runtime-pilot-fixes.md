# Runtime Pilot Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the end-to-end contract-review pilot pass reliably: the workflow must not hang during Pi runtime cold start, and the pilot must allow enough time for real DeepSeek calls.

**Architecture:** Add a readiness handshake and timeouts to the Pi runtime client so commands are only sent after the child process finishes booting and never hang forever. Keep the agent's full tool set (writes gated by user approval). Widen the pilot timeouts.

**Tech Stack:** TypeScript, Vitest, @sparkii/agent-host, Electron utilityProcess/fork transport, Playwright e2e.

**Spec:** This plan is the spec. Root causes are documented below.

## Root Causes (confirmed by the Task 5 pilot run)

1. **Workflow hangs at the first LLM step.** `PiRuntimeSupervisor.start()` spawns the utility process and returns immediately, but the child only registers its command handler inside `createPiRuntime` after `createPiSdkSessionHost` (slow boot) resolves. `PiRuntimeClientImpl.send()` posts a command and waits forever with no timeout, and child exit does not reject pending sends. A slow/lost boot therefore stalls `selectModel`/`sendPrompt` indefinitely (pilot run 2/3 stuck at `审核中：extract`, no session file created).
2. **Pilot timeouts are too tight** for cold start + three real model calls + human approval (dialog 120s, test 180s).

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

### Task 7: Widen pilot timeouts and rebuild/verify

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

- **Spec coverage:** Hang (Task 6), pilot timeouts (Task 7). Both confirmed root causes are addressed.
- **Placeholder scan:** No TBD/TODO; `stop`/`onExit`/`onProposal` are referenced as unchanged to avoid duplicating verified code.
- **Type consistency:** `readyEnvelope()` matches the new `PiRuntimeEnvelope` variant; `send(command: RpcCommand)` matches the `PiRuntimeClient` interface.
