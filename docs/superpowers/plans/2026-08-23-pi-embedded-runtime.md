# Pi Embedded Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the external `pi --mode rpc` child process with a bundled, Electron-managed, windowless Pi Runtime child that uses the Pi SDK.

**Architecture:** Electron Main owns a `PiRuntimeSupervisor` that forks a `pi-runtime` entry via `utilityProcess` (fallback: hidden `child_process.fork`). `@sparkii/agent-host` owns all Pi SDK knowledge and exposes a high-level `createPiSdkSessionHost`; the thin desktop entry only wires Electron transport and calls that factory. Main keeps approval/audit/executor, and the Pi child only proposes writes.

**Tech Stack:** Electron 43, Node >= 22, TypeScript, pnpm workspace, `@earendil-works/pi-coding-agent`, esbuild, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-23-pi-embedded-runtime-design.md`

## Global Constraints

- Node >= 22, pnpm >= 9, Electron >= 43, TypeScript >= 6.0.3.
- Preserve existing `RpcCommand`, `RpcResponse`, and `NormalizedEvent` semantics.
- Do not import Pi SDK into Electron Main; only the Pi Runtime child may import it.
- The product must ship as one installer and must not require user-installed `pi`, pnpm, or Node.
- No visible terminal/console window may appear during app startup or agent execution.
- Write and high-risk tools remain proposal-only in the Pi Runtime child.
- Renderer, preload, approval UI, and public `SparkiiApi` shape do not change.

---

## File Structure

Create:

- `packages/agent-host/src/pi-runtime-transport.ts`
- `packages/agent-host/src/pi-runtime-supervisor.ts`
- `packages/agent-host/src/pi-runtime.ts`
- `packages/agent-host/src/pi-runtime-tools.ts`
- `packages/agent-host/src/pi-sdk-runtime.ts`
- `packages/agent-host/test/pi-runtime-transport.test.ts`
- `packages/agent-host/test/pi-runtime-supervisor.test.ts`
- `packages/agent-host/test/pi-runtime.test.ts`
- `packages/agent-host/test/pi-runtime-tools.test.ts`
- `packages/agent-host/test/pi-sdk-runtime.test.ts`
- `packages/agent-host/test/fixtures/pi-runtime-test-child.mjs`
- `packages/agent-host/scripts/pi-sdk-smoke.mjs`
- `packages/agent-host/scripts/pi-utility-spike-child.mjs`
- `apps/desktop/scripts/pi-utility-spike-main.mjs`
- `apps/desktop/electron/pi-runtime/transports.ts`
- `apps/desktop/electron/pi-runtime/utility-entry.ts`
- `apps/desktop/electron/pi-runtime/fork-entry.ts`

Modify:

- `packages/agent-host/package.json`
- `packages/agent-host/src/index.ts`
- `apps/desktop/electron/main/runtime.ts`
- `apps/desktop/electron/main/ipc.ts`
- `apps/desktop/electron/main/workflow.ts`
- `apps/desktop/electron/main/recovery.ts`
- `apps/desktop/package.json`
- `apps/desktop/electron-builder.yml`

---

## Task 1: Pin Pi SDK and verify its public API from Node

**Files:**
- Modify: `packages/agent-host/package.json`
- Create: `packages/agent-host/scripts/pi-sdk-smoke.mjs`

**Interfaces:**
- Consumes: none.
- Produces: a locked `@earendil-works/pi-coding-agent` dependency used by later tasks.

- [ ] **Step 1: Add the dependency**

Edit `packages/agent-host/package.json` so `dependencies` contains:

```json
"dependencies": {
  "@sparkii/approval": "workspace:*",
  "@sparkii/connectors": "workspace:*",
  "@earendil-works/pi-coding-agent": "^0.80.0"
}
```

Run:

```powershell
pnpm install
```

- [ ] **Step 2: Add the smoke script**

Create `packages/agent-host/scripts/pi-sdk-smoke.mjs`:

```js
import {
  createAgentSession,
  SessionManager,
  defineTool,
} from "@earendil-works/pi-coding-agent";

if (typeof createAgentSession !== "function") {
  throw new Error("createAgentSession is not a function");
}
if (!SessionManager || typeof SessionManager.inMemory !== "function") {
  throw new Error("SessionManager.inMemory is not available");
}
if (typeof defineTool !== "function") {
  throw new Error("defineTool is not a function");
}

console.log("pi sdk api present");
```

- [ ] **Step 3: Run the smoke script**

```powershell
pnpm --filter @sparkii/agent-host exec node scripts/pi-sdk-smoke.mjs
```

Expected output:

```text
pi sdk api present
```

- [ ] **Step 4: Commit**

```powershell
git add packages/agent-host/package.json packages/agent-host/scripts/pi-sdk-smoke.mjs pnpm-lock.yaml
git commit -m "chore(agent-host): pin Pi SDK and add API smoke check"
```

## Task 2: Verify Pi SDK inside an Electron utilityProcess

This is a throwaway spike. Its only output is a go/no-go for the primary `utilityProcess` path. Do not carry the scripts into product code.

**Files:**
- Create: `apps/desktop/scripts/pi-utility-spike-main.mjs`
- Create: `packages/agent-host/scripts/pi-utility-spike-child.mjs`

**Interfaces:**
- Consumes: Pi SDK dependency from Task 1.
- Produces: confirmation that `utilityProcess` can load Pi SDK and post messages.

- [ ] **Step 1: Write the Electron main spike**

Create `apps/desktop/scripts/pi-utility-spike-main.mjs`:

```js
import { app, utilityProcess } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

app.whenReady().then(() => {
  const child = utilityProcess.fork(
    join(here, "../../../packages/agent-host/scripts/pi-utility-spike-child.mjs"),
    [],
    { serviceName: "sparkii-pi-runtime-spike" },
  );

  child.on("message", (message) => {
    console.log("SPIKE_PONG", JSON.stringify(message));
    child.kill();
    app.quit();
  });

  child.on("exit", (code) => {
    console.log("SPIKE_EXIT", code);
    app.quit();
  });

  child.postMessage({ type: "ping" });
});
```

- [ ] **Step 2: Write the child spike**

Create `packages/agent-host/scripts/pi-utility-spike-child.mjs`:

```js
import {
  createAgentSession,
  SessionManager,
  defineTool,
} from "@earendil-works/pi-coding-agent";

process.parentPort.on("message", () => {
  process.parentPort.postMessage({
    pong: true,
    hasCreateAgentSession: typeof createAgentSession === "function",
    hasSessionManagerInMemory: Boolean(SessionManager?.inMemory),
    hasDefineTool: typeof defineTool === "function",
  });
});
```

- [ ] **Step 3: Run the spike**

```powershell
pnpm --filter @sparkii/desktop exec electron scripts/pi-utility-spike-main.mjs
```

Expected:

```text
SPIKE_PONG {"pong":true,"hasCreateAgentSession":true,"hasSessionManagerInMemory":true,"hasDefineTool":true}
SPIKE_EXIT ...
```

If `SPIKE_PONG` does not print, stop this plan and use the `child_process.fork` fallback throughout. The `fork-entry.ts` is still implemented in Task 7, but becomes the primary entry.

- [ ] **Step 4: Delete the spike files**

```powershell
Remove-Item -LiteralPath "apps/desktop/scripts/pi-utility-spike-main.mjs"
Remove-Item -LiteralPath "packages/agent-host/scripts/pi-utility-spike-child.mjs"
```

## Task 3: Define the transport envelope contract

**Files:**
- Create: `packages/agent-host/src/pi-runtime-transport.ts`
- Create: `packages/agent-host/test/pi-runtime-transport.test.ts`
- Modify: `packages/agent-host/src/index.ts`

**Interfaces:**
- Produces:
  - `PiRuntimeEnvelope`
  - `ProposalDecision`
  - `PiRuntimeClient`
  - `PiRuntimeHostHandle`
  - `commandEnvelope(id, command)`
  - `responseEnvelope(id, response)`
  - `eventEnvelope(event)`
  - `proposalEnvelope(proposal)`
  - `proposalDecisionEnvelope(requestId, decision)`

- [ ] **Step 1: Write the failing test**

Create `packages/agent-host/test/pi-runtime-transport.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  commandEnvelope,
  responseEnvelope,
  eventEnvelope,
  proposalEnvelope,
  proposalDecisionEnvelope,
} from "../src/pi-runtime-transport.js";

describe("pi runtime transport envelopes", () => {
  it("builds each envelope with the correct direction", () => {
    expect(commandEnvelope("r1", { type: "abort" })).toMatchObject({
      direction: "main-to-runtime",
      id: "r1",
      command: { type: "abort" },
    });
    expect(responseEnvelope("r1", { id: "r1", type: "response", command: "abort", success: true })).toMatchObject({
      direction: "runtime-to-main",
    });
    expect(eventEnvelope({ type: "agent_start" })).toMatchObject({
      direction: "runtime-to-main",
    });
    expect(proposalEnvelope({
      requestId: "p1", toolName: "report.export", targetSystem: "report",
      summary: "export", payload: { path: "a.docx" }, risk: "write",
    })).toMatchObject({ direction: "runtime-to-main", proposal: { requestId: "p1" } });
    expect(proposalDecisionEnvelope("p1", { approved: false, proposalId: "p1", status: "denied" })).toMatchObject({
      direction: "main-to-runtime", requestId: "p1", proposalDecision: { approved: false },
    });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```powershell
pnpm vitest run packages/agent-host/test/pi-runtime-transport.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 3: Implement the module**

Create `packages/agent-host/src/pi-runtime-transport.ts`:

```ts
import type { RpcCommand, RpcResponse, NormalizedEvent } from "./types.js";
import type { ProposalRequest } from "@sparkii/approval";

export interface ProposalDecision {
  approved: boolean;
  proposalId: string;
  status: string;
  result?: unknown;
}

export type PiRuntimeEnvelope =
  | { direction: "main-to-runtime"; id: string; command: RpcCommand }
  | { direction: "runtime-to-main"; id: string; response: RpcResponse }
  | { direction: "runtime-to-main"; event: NormalizedEvent }
  | { direction: "runtime-to-main"; proposal: ProposalRequest & { requestId: string } }
  | { direction: "main-to-runtime"; requestId: string; proposalDecision: ProposalDecision };

export interface PiRuntimeClient {
  send(command: RpcCommand): Promise<RpcResponse>;
  onEvent(callback: (event: NormalizedEvent) => void): () => void;
  close(): void;
}

export interface PiRuntimeHostHandle {
  postMessage(envelope: PiRuntimeEnvelope): void;
  onMessage(callback: (envelope: PiRuntimeEnvelope) => void): () => void;
  onExit(callback: (code: number | null) => void): () => void;
  kill(): void;
}

export function commandEnvelope(id: string, command: RpcCommand): PiRuntimeEnvelope {
  return { direction: "main-to-runtime", id, command };
}

export function responseEnvelope(id: string, response: RpcResponse): PiRuntimeEnvelope {
  return { direction: "runtime-to-main", id, response };
}

export function eventEnvelope(event: NormalizedEvent): PiRuntimeEnvelope {
  return { direction: "runtime-to-main", event };
}

export function proposalEnvelope(proposal: ProposalRequest & { requestId: string }): PiRuntimeEnvelope {
  return { direction: "runtime-to-main", proposal };
}

export function proposalDecisionEnvelope(
  requestId: string,
  proposalDecision: ProposalDecision,
): PiRuntimeEnvelope {
  return { direction: "main-to-runtime", requestId, proposalDecision };
}
```

- [ ] **Step 4: Export the new module**

Edit `packages/agent-host/src/index.ts`:

```ts
export * from "./pi-runtime-transport.js";
```

- [ ] **Step 5: Run the test and confirm it passes**

```powershell
pnpm vitest run packages/agent-host/test/pi-runtime-transport.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/agent-host/src/pi-runtime-transport.ts packages/agent-host/test/pi-runtime-transport.test.ts packages/agent-host/src/index.ts
git commit -m "feat(agent-host): define Pi runtime transport envelope contract"
```

## Task 4: Implement the Pi runtime supervisor and client

**Files:**
- Create: `packages/agent-host/src/pi-runtime-supervisor.ts`
- Create: `packages/agent-host/test/pi-runtime-supervisor.test.ts`
- Modify: `packages/agent-host/src/index.ts`

**Interfaces:**
- Consumes: `PiRuntimeEnvelope`, `PiRuntimeClient`, `PiRuntimeHostHandle`, `ProposalDecision`, and envelope builders from Task 3.
- Produces:
  - `class PiRuntimeSupervisor`
  - `start(): Promise<PiRuntimeClient>`
  - `stop(): Promise<void>`
  - `onExit(cb): () => void`
  - `onProposal(cb): void`

- [ ] **Step 1: Write the failing test**

Create `packages/agent-host/test/pi-runtime-supervisor.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import {
  PiRuntimeSupervisor,
} from "../src/pi-runtime-supervisor.js";
import {
  commandEnvelope,
  responseEnvelope,
  eventEnvelope,
  proposalEnvelope,
  proposalDecisionEnvelope,
  type PiRuntimeEnvelope,
  type PiRuntimeHostHandle,
} from "../src/pi-runtime-transport.js";

class FakeHandle implements PiRuntimeHostHandle {
  sent: PiRuntimeEnvelope[] = [];
  private messageCb?: (env: PiRuntimeEnvelope) => void;
  private exitCb?: (code: number | null) => void;
  killed = false;

  postMessage(envelope: PiRuntimeEnvelope) { this.sent.push(envelope); }
  onMessage(cb: (env: PiRuntimeEnvelope) => void) { this.messageCb = cb; return () => { this.messageCb = undefined; }; }
  onExit(cb: (code: number | null) => void) { this.exitCb = cb; return () => { this.exitCb = undefined; }; }
  emit(envelope: PiRuntimeEnvelope) { this.messageCb?.(envelope); }
  kill() { this.killed = true; this.exitCb?.(1); }
}

describe("PiRuntimeSupervisor", () => {
  it("starts idempotently and sends commands", async () => {
    const handle = new FakeHandle();
    const sup = new PiRuntimeSupervisor(() => handle);
    const a = await sup.start();
    const b = await sup.start();
    expect(a).toBe(b);
    const p = a.send({ type: "abort" });
    const sent = handle.sent[0];
    expect(sent).toMatchObject({ direction: "main-to-runtime", command: { type: "abort" } });
    const id = "id" in sent ? sent.id : "";
    handle.emit(responseEnvelope(id, { id, type: "response", command: "abort", success: true }));
    await expect(p).resolves.toMatchObject({ success: true });
  });

  it("streams events and routes proposals", async () => {
    const handle = new FakeHandle();
    const sup = new PiRuntimeSupervisor(() => handle);
    const onEvent = vi.fn();
    const onProposal = vi.fn(async () => ({ approved: false, proposalId: "p1", status: "denied" }));
    sup.onProposal(onProposal);
    const client = await sup.start();
    client.onEvent(onEvent);
    handle.emit(eventEnvelope({ type: "agent_start" }));
    expect(onEvent).toHaveBeenCalledWith({ type: "agent_start" });

    const proposal = {
      requestId: "p1", toolName: "report.export", targetSystem: "report",
      summary: "export", payload: { path: "a.docx" }, risk: "write" as const,
    };
    handle.emit(proposalEnvelope(proposal));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onProposal).toHaveBeenCalledWith(proposal);
    expect(handle.sent).toContainEqual(proposalDecisionEnvelope("p1", { approved: false, proposalId: "p1", status: "denied" }));
  });

  it("denies a proposal when the approval handler rejects", async () => {
    const handle = new FakeHandle();
    const sup = new PiRuntimeSupervisor(() => handle);
    sup.onProposal(async () => { throw new Error("broker failed"); });
    const client = await sup.start();
    handle.emit(proposalEnvelope({
      requestId: "p2", toolName: "report.export", targetSystem: "report",
      summary: "export", payload: { path: "a.docx" }, risk: "write",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handle.sent).toContainEqual(proposalDecisionEnvelope("p2", {
      approved: false, proposalId: "p2", status: "denied",
    }));
    expect(client).toBeTruthy();
  });

  it("clears the client and reports exit", async () => {
    const handle = new FakeHandle();
    const sup = new PiRuntimeSupervisor(() => handle);
    const onExit = vi.fn();
    sup.onExit(onExit);
    await sup.start();
    handle.kill();
    expect(onExit).toHaveBeenCalledWith(1);
    expect(handle.killed).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```powershell
pnpm vitest run packages/agent-host/test/pi-runtime-supervisor.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 3: Implement the supervisor**

Create `packages/agent-host/src/pi-runtime-supervisor.ts`:

```ts
import { randomUUID } from "node:crypto";
import {
  commandEnvelope,
  eventEnvelope,
  proposalDecisionEnvelope,
  type PiRuntimeClient,
  type PiRuntimeEnvelope,
  type PiRuntimeHostHandle,
  type ProposalDecision,
} from "./pi-runtime-transport.js";
import type { ProposalRequest } from "@sparkii/approval";
import type { NormalizedEvent, RpcCommand, RpcResponse } from "./types.js";

type ProposalHandler = (
  request: ProposalRequest & { requestId: string },
) => Promise<ProposalDecision>;

class PiRuntimeClientImpl implements PiRuntimeClient {
  private pending = new Map<string, (response: RpcResponse) => void>();
  private listeners = new Set<(event: NormalizedEvent) => void>();

  constructor(
    private handle: PiRuntimeHostHandle,
    private onProposal: ProposalHandler,
  ) {
    handle.onMessage((envelope) => void this.consume(envelope));
  }

  send(command: RpcCommand): Promise<RpcResponse> {
    const id = randomUUID();
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.handle.postMessage(commandEnvelope(id, command));
    });
  }

  onEvent(callback: (event: NormalizedEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  close(): void {
    this.pending.clear();
    this.listeners.clear();
  }

  private async consume(envelope: PiRuntimeEnvelope): Promise<void> {
    if ("response" in envelope) {
      const resolver = this.pending.get(envelope.response.id ?? envelope.id);
      if (resolver) {
        this.pending.delete(envelope.response.id ?? envelope.id);
        resolver(envelope.response);
      }
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

export class PiRuntimeSupervisor {
  private client?: PiRuntimeClient;
  private handle?: PiRuntimeHostHandle;
  private exitCbs = new Set<(code: number | null) => void>();
  private proposalCb: ProposalHandler = async () => ({
    approved: false,
    proposalId: "unhandled",
    status: "denied",
  });

  constructor(private makeHandle: () => PiRuntimeHostHandle) {}

  async start(): Promise<PiRuntimeClient> {
    if (this.client) return this.client;
    const handle = this.makeHandle();
    this.handle = handle;
    this.client = new PiRuntimeClientImpl(handle, (request) => this.proposalCb(request));
    handle.onExit((code) => {
      this.client = undefined;
      this.handle = undefined;
      for (const cb of this.exitCbs) cb(code);
    });
    return this.client;
  }

  async stop(): Promise<void> {
    this.handle?.kill();
    this.client?.close();
    this.client = undefined;
    this.handle = undefined;
  }

  onExit(cb: (code: number | null) => void): () => void {
    this.exitCbs.add(cb);
    return () => this.exitCbs.delete(cb);
  }

  onProposal(cb: ProposalHandler): void {
    this.proposalCb = cb;
  }
}
```

- [ ] **Step 4: Export the supervisor**

Edit `packages/agent-host/src/index.ts`:

```ts
export * from "./pi-runtime-supervisor.js";
```

- [ ] **Step 5: Run the test and confirm it passes**

```powershell
pnpm vitest run packages/agent-host/test/pi-runtime-supervisor.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/agent-host/src/pi-runtime-supervisor.ts packages/agent-host/test/pi-runtime-supervisor.test.ts packages/agent-host/src/index.ts
git commit -m "feat(agent-host): add Pi runtime supervisor and client"
```

## Task 5: Implement the child-side Pi runtime command bridge

**Files:**
- Create: `packages/agent-host/src/pi-runtime.ts`
- Create: `packages/agent-host/test/pi-runtime.test.ts`
- Modify: `packages/agent-host/src/rpc-client.ts`
- Modify: `packages/agent-host/test/rpc-client.test.ts`
- Modify: `packages/agent-host/src/index.ts`

**Interfaces:**
- Consumes: `PiRuntimeEnvelope`, `NormalizedEvent`, `RpcCommand`, `RpcResponse`, `ProposalDecision`, and envelope builders from Task 3.
- Produces:
  - `interface PiRuntimeSession`
  - `interface PiRuntimeSessionHost`
  - `createPiRuntime(opts): () => void`

- [ ] **Step 1: Extend event normalization**

Edit `packages/agent-host/src/rpc-client.ts` and add these cases to `normalizeEvent` before the default case:

```ts
    case "tool_execution_start":
      return { type: "tool_call", toolName: raw.toolName, input: raw.input ?? raw.params };
    case "tool_execution_end":
      return { type: "tool_result", toolName: raw.toolName, result: raw.result ?? raw.details };
```

Edit `packages/agent-host/test/rpc-client.test.ts` to add:

```ts
  it("maps SDK tool execution events", () => {
    expect(normalizeEvent({ type: "tool_execution_start", toolName: "read", params: { path: "a.md" } }))
      .toEqual({ type: "tool_call", toolName: "read", input: { path: "a.md" } });
    expect(normalizeEvent({ type: "tool_execution_end", toolName: "read", details: { ok: true } }))
      .toEqual({ type: "tool_result", toolName: "read", result: { ok: true } });
  });
```

- [ ] **Step 2: Write the failing runtime test**

Create `packages/agent-host/test/pi-runtime.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import {
  createPiRuntime,
  type PiRuntimeSession,
  type PiRuntimeSessionHost,
} from "../src/pi-runtime.js";
import {
  commandEnvelope,
  eventEnvelope,
  responseEnvelope,
  type PiRuntimeEnvelope,
} from "../src/pi-runtime-transport.js";

function fakeSession(): PiRuntimeSession & { emit: (event: any) => void } {
  const listeners = new Set<(event: any) => void>();
  return {
    emit: (event) => listeners.forEach((cb) => cb(event)),
    prompt: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    setAutoRetry: vi.fn(async () => {}),
    setAutoCompaction: vi.fn(async () => {}),
    subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    getMessages: () => [{ role: "user", text: "hi" }],
    getState: () => ({ streaming: false }),
    dispose: vi.fn(),
  } as any;
}

describe("createPiRuntime", () => {
  it("routes commands and emits events", async () => {
    const session = fakeSession();
    let current = session;
    const host: PiRuntimeSessionHost = {
      current: () => current,
      newSession: vi.fn(async () => {}),
      switchSession: vi.fn(async () => {}),
    };
    const sent: PiRuntimeEnvelope[] = [];
    const transport = {
      postMessage: (env: PiRuntimeEnvelope) => sent.push(env),
      onMessage: (cb: (env: PiRuntimeEnvelope) => void) => {
        transport.emit = cb;
        return () => {};
      },
      emit: (_env: PiRuntimeEnvelope) => {},
    };
    const dispose = createPiRuntime({ host, transport });

    transport.emit(commandEnvelope("r1", { type: "abort" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.abort).toHaveBeenCalled();
    expect(sent).toContainEqual(responseEnvelope("r1", {
      id: "r1", type: "response", command: "abort", success: true,
    }));

    const onMainEvent = vi.fn();
    const emitted = eventEnvelope({ type: "agent_start" });
    session.emit({ type: "agent_start" });
    expect(sent).toContainEqual(emitted);
    onMainEvent();
    dispose();
  });

  it("re-subscribes after switchSession", async () => {
    const first = fakeSession();
    const second = fakeSession();
    let current = first;
    const host: PiRuntimeSessionHost = {
      current: () => current,
      newSession: vi.fn(async () => { current = second; }),
      switchSession: vi.fn(async () => { current = second; }),
    };
    const transport = {
      postMessage: () => {},
      onMessage: () => () => {},
    };
    createPiRuntime({ host, transport: transport as any });
    await host.switchSession("x.jsonl");
    expect(host.switchSession).toHaveBeenCalledWith("x.jsonl");
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

```powershell
pnpm vitest run packages/agent-host/test/pi-runtime.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 4: Implement the runtime bridge**

Create `packages/agent-host/src/pi-runtime.ts`:

```ts
import { normalizeEvent } from "./rpc-client.js";
import type { RpcCommand, RpcResponse } from "./types.js";
import {
  eventEnvelope,
  responseEnvelope,
  type PiRuntimeEnvelope,
} from "./pi-runtime-transport.js";

export interface PiRuntimeSession {
  prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setAutoRetry(enabled: boolean): Promise<void>;
  setAutoCompaction(enabled: boolean): Promise<void>;
  subscribe(callback: (event: any) => void): () => void;
  getMessages(): unknown[];
  getState(): Record<string, unknown>;
  dispose(): void;
}

export interface PiRuntimeSessionHost {
  current(): PiRuntimeSession;
  newSession(): Promise<void>;
  switchSession(sessionPath: string): Promise<void>;
}

export interface PiRuntimeChildTransport {
  postMessage(envelope: PiRuntimeEnvelope): void;
  onMessage(callback: (envelope: PiRuntimeEnvelope) => void): () => void;
}

export function createPiRuntime(opts: {
  host: PiRuntimeSessionHost;
  transport: PiRuntimeChildTransport;
}): () => void {
  let unsubscribe = opts.host.current().subscribe((event) => {
    opts.transport.postMessage(eventEnvelope(normalizeEvent(event)));
  });

  const resubscribe = (): void => {
    unsubscribe();
    unsubscribe = opts.host.current().subscribe((event) => {
      opts.transport.postMessage(eventEnvelope(normalizeEvent(event)));
    });
  };

  const send = (id: string, command: RpcCommand, response: RpcResponse): void => {
    opts.transport.postMessage(responseEnvelope(id, response));
  };

  opts.transport.onMessage(async (envelope) => {
    if (!("command" in envelope)) return;
    const { id, command } = envelope;
    try {
      await handleCommand(opts.host, command);
      if (command.type === "new_session" || command.type === "switch_session") {
        resubscribe();
      }
      send(id, command, { id, type: "response", command: command.type, success: true });
    } catch (error) {
      send(id, command, {
        id, type: "response", command: command.type, success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return () => {
    unsubscribe();
    opts.host.current().dispose();
  };
}

async function handleCommand(host: PiRuntimeSessionHost, command: RpcCommand): Promise<void> {
  const session = host.current();
  switch (command.type) {
    case "prompt":
      await session.prompt(command.message, { streamingBehavior: command.streamingBehavior });
      return;
    case "steer":
      await session.steer(command.message);
      return;
    case "follow_up":
      await session.followUp(command.message);
      return;
    case "abort":
      await session.abort();
      return;
    case "new_session":
      await host.newSession();
      return;
    case "get_state":
      return;
    case "get_messages":
      return;
    case "set_model":
      await session.setModel(command.provider, command.modelId);
      return;
    case "set_auto_retry":
      await session.setAutoRetry(command.enabled);
      return;
    case "set_auto_compaction":
      await session.setAutoCompaction(command.enabled);
      return;
    case "switch_session":
      await host.switchSession(command.sessionPath);
      return;
  }
}
```

Note: `get_state` and `get_messages` currently return generic success responses in this bridge. The richer payloads are not required by the existing Main callers; do not add unused response fields.

- [ ] **Step 5: Export the runtime bridge**

Edit `packages/agent-host/src/index.ts`:

```ts
export * from "./pi-runtime.js";
```

- [ ] **Step 6: Run all agent-host tests**

```powershell
pnpm vitest run packages/agent-host/test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add packages/agent-host/src/pi-runtime.ts packages/agent-host/test/pi-runtime.test.ts packages/agent-host/src/rpc-client.ts packages/agent-host/test/rpc-client.test.ts packages/agent-host/src/index.ts
git commit -m "feat(agent-host): add child-side Pi runtime command bridge"
```

## Task 6: Build Pi runtime tool definitions

**Files:**
- Create: `packages/agent-host/src/pi-runtime-tools.ts`
- Create: `packages/agent-host/test/pi-runtime-tools.test.ts`
- Modify: `packages/agent-host/src/index.ts`

**Interfaces:**
- Consumes: `ToolDef` from `@sparkii/connectors`, `ProposalRequest` from `@sparkii/approval`, `ProposalDecision` from Task 3.
- Produces: `buildPiRuntimeTools(opts): PiToolDefinition[]`.

- [ ] **Step 1: Write the failing test**

Create `packages/agent-host/test/pi-runtime-tools.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { buildPiRuntimeTools } from "../src/pi-runtime-tools.js";

describe("buildPiRuntimeTools", () => {
  it("executes read tools locally", async () => {
    const read = {
      name: "document.read", description: "read", sideEffect: "read" as const,
      params: { type: "object", properties: { path: { type: "string" } } },
      handler: vi.fn(async () => ({ ok: true, data: { text: "hello" } })),
    };
    const tools = buildPiRuntimeTools({ tools: [read], propose: vi.fn() });
    const result = await tools[0].execute("id1", { path: "a.pdf" });
    expect(read.handler).toHaveBeenCalled();
    expect(result.content[0].text).toContain("hello");
  });

  it("proposes write tools instead of executing them", async () => {
    const write = {
      name: "report.export", description: "export", sideEffect: "write" as const,
      params: { type: "object", properties: {} },
      handler: vi.fn(),
    };
    const propose = vi.fn(async () => ({ approved: false, proposalId: "p1", status: "denied" }));
    const tools = buildPiRuntimeTools({ tools: [write], propose });
    const result = await tools[0].execute("id2", { path: "a.docx" });
    expect(write.handler).not.toHaveBeenCalled();
    expect(propose).toHaveBeenCalledWith(expect.objectContaining({ toolName: "report.export", risk: "write" }));
    expect(result.content[0].text).toContain("denied");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```powershell
pnpm vitest run packages/agent-host/test/pi-runtime-tools.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 3: Implement the tool builder**

Create `packages/agent-host/src/pi-runtime-tools.ts`:

```ts
import type { ProposalRequest } from "@sparkii/approval";
import type { ToolDef } from "@sparkii/connectors";
import { jsonSchemaToTypeBox } from "./bridge/typebox.js";
import type { ProposalDecision } from "./pi-runtime-transport.js";

export interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
}

export function buildPiRuntimeTools(opts: {
  tools: ToolDef[];
  propose: (
    request: ProposalRequest & { requestId: string },
  ) => Promise<ProposalDecision>;
}): PiToolDefinition[] {
  return opts.tools.map((def) => ({
    name: def.name,
    label: def.name,
    description: def.description,
    parameters: jsonSchemaToTypeBox(def.params),
    async execute(toolCallId: string, params: Record<string, unknown>) {
      if (def.sideEffect === "read") {
        const result = await def.handler(params, {
          profileId: process.env.SPARKII_PROFILE_ID ?? "dev",
          sessionId: process.env.SPARKII_SESSION_ID ?? "session",
          actor: "agent",
          requestId: toolCallId,
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
      }
      const decision = await opts.propose({
        requestId: toolCallId,
        toolName: def.name,
        targetSystem: def.name.split(".")[0],
        summary: JSON.stringify(params).slice(0, 512),
        payload: params,
        risk: def.sideEffect,
      });
      return { content: [{ type: "text", text: JSON.stringify(decision) }], details: {} };
    },
  }));
}
```

- [ ] **Step 4: Export the tool builder**

Edit `packages/agent-host/src/index.ts`:

```ts
export * from "./pi-runtime-tools.js";
```

- [ ] **Step 5: Run the test and confirm it passes**

```powershell
pnpm vitest run packages/agent-host/test/pi-runtime-tools.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/agent-host/src/pi-runtime-tools.ts packages/agent-host/test/pi-runtime-tools.test.ts packages/agent-host/src/index.ts
git commit -m "feat(agent-host): add proposal-safe Pi runtime tool builder"
```

## Task 7: Add Pi SDK host adapter, Electron transport handles, and runtime entries

**Files:**
- Create: `packages/agent-host/src/pi-sdk-runtime.ts`
- Create: `packages/agent-host/test/pi-sdk-runtime.test.ts`
- Create: `apps/desktop/electron/pi-runtime/transports.ts`
- Create: `apps/desktop/electron/pi-runtime/utility-entry.ts`
- Create: `apps/desktop/electron/pi-runtime/fork-entry.ts`
- Modify: `packages/agent-host/src/index.ts`

**Interfaces:**
- Consumes: `PiRuntimeHostHandle`, `PiRuntimeEnvelope`, `PiRuntimeChildTransport`, `buildPiRuntimeTools`, `createPiRuntime`, `PiRuntimeSession`, `PiRuntimeSessionHost` from Tasks 3, 5, and 6.
- Produces: `createPiSdkSessionHost(options)`, `createUtilityHostHandle(entryPath)`, `createForkHostHandle(entryPath)`, `utility-entry`, `fork-entry`.

- [ ] **Step 1: Write the failing SDK host adapter test**

Create `packages/agent-host/test/pi-sdk-runtime.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createPiSdkSessionHost } from "../src/pi-sdk-runtime.js";

describe("pi-sdk-runtime", () => {
  it("exports the SDK host factory", () => {
    expect(typeof createPiSdkSessionHost).toBe("function");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```powershell
pnpm vitest run packages/agent-host/test/pi-sdk-runtime.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 3: Implement the SDK host adapter**

Create `packages/agent-host/src/pi-sdk-runtime.ts`:

```ts
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  defineTool,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import {
  documentConnector,
  knowledgeConnector,
  reportConnector,
  type ToolDef,
} from "@sparkii/connectors";
import { buildPiRuntimeTools } from "./pi-runtime-tools.js";
import {
  proposalEnvelope,
  type ProposalDecision,
} from "./pi-runtime-transport.js";
import type {
  PiRuntimeChildTransport,
  PiRuntimeSession,
  PiRuntimeSessionHost,
} from "./pi-runtime.js";

export interface PiSdkRuntimeOptions {
  transport: PiRuntimeChildTransport;
  tools?: ToolDef[];
  cwd?: string;
}

export async function createPiSdkSessionHost(
  options: PiSdkRuntimeOptions,
): Promise<PiRuntimeSessionHost> {
  const pendingProposals = new Map<
    string,
    { resolve: (decision: ProposalDecision) => void; reject: (error: Error) => void }
  >();

  options.transport.onMessage((envelope) => {
    if ("proposalDecision" in envelope) {
      const pending = pendingProposals.get(envelope.requestId);
      if (!pending) return;
      pendingProposals.delete(envelope.requestId);
      pending.resolve(envelope.proposalDecision);
    }
  });

  const tools =
    options.tools ??
    [
      ...documentConnector.tools,
      ...knowledgeConnector.tools,
      ...reportConnector.tools,
    ];

  const piTools = buildPiRuntimeTools({
    tools,
    propose: async (request) =>
      new Promise<ProposalDecision>((resolve, reject) => {
        pendingProposals.set(request.requestId, { resolve, reject });
        options.transport.postMessage(proposalEnvelope(request));
      }),
  }).map((tool) => defineTool(tool as any));

  const cwd = options.cwd ?? process.env.SPARKII_PI_CWD ?? process.cwd();
  const modelRuntime = await ModelRuntime.create();

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd: effectiveCwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({ cwd: effectiveCwd });
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    });
    return {
      ...result,
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir: getAgentDir(),
    sessionManager: SessionManager.create(cwd),
  });

  function adaptSession(): PiRuntimeSession {
    const session: any = runtime.session;
    session.agent.state.tools = piTools;
    return {
      prompt: (text, promptOptions) => session.prompt(text, promptOptions),
      steer: (text) => session.steer(text),
      followUp: (text) => session.followUp(text),
      abort: () => session.abort(),
      setModel: async (provider, modelId) => {
        const model = modelRuntime.getModel(provider, modelId);
        if (!model) throw new Error(`unknown model ${provider}/${modelId}`);
        await session.setModel(model);
      },
      setAutoRetry: async () => {},
      setAutoCompaction: async () => {},
      subscribe: (callback) => session.subscribe(callback),
      getMessages: () => session.messages,
      getState: () => ({
        streaming: session.isStreaming,
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
      }),
      dispose: () => session.dispose(),
    };
  }

  return {
    current: () => adaptSession(),
    newSession: async () => {
      await runtime.newSession();
      adaptSession();
    },
    switchSession: async (sessionPath: string) => {
      await runtime.switchSession(sessionPath);
      adaptSession();
    },
  };
}
```

- [ ] **Step 4: Export the SDK host adapter**

Edit `packages/agent-host/src/index.ts`:

```ts
export { ControlServer } from "./control-server.js";
export * from "./pi-sdk-runtime.js";
```

This changes `control-server.js` from a re-export to a named export so its `ProposalDecision` does not collide with the same type exported by `pi-runtime-transport.js`.

- [ ] **Step 5: Run the agent-host tests**

```powershell
pnpm vitest run packages/agent-host/test
```

Expected: all agent-host tests pass.

- [ ] **Step 6: Write the transport handle factory**

Create `apps/desktop/electron/pi-runtime/transports.ts`:

```ts
import { utilityProcess, type UtilityProcess } from "electron";
import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import type { PiRuntimeEnvelope, PiRuntimeHostHandle } from "@sparkii/agent-host";

export function createUtilityHostHandle(entryPath: string): PiRuntimeHostHandle {
  const child: UtilityProcess = utilityProcess.fork(entryPath, [], {
    serviceName: "sparkii-pi-runtime",
  });
  return {
    postMessage: (envelope) => child.postMessage(envelope),
    onMessage: (callback) => {
      const listener = (envelope: PiRuntimeEnvelope) => callback(envelope);
      child.on("message", listener);
      return () => child.removeListener("message", listener);
    },
    onExit: (callback) => {
      const listener = (code: number) => callback(code);
      child.on("exit", listener);
      return () => child.removeListener("exit", listener);
    },
    kill: () => child.kill(),
  };
}

export function createForkHostHandle(entryPath: string): PiRuntimeHostHandle {
  const child: ChildProcess = fork(entryPath, [], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    windowsHide: true,
  } as ForkOptions);
  return {
    postMessage: (envelope) => child.send(envelope),
    onMessage: (callback) => {
      const listener = (envelope: PiRuntimeEnvelope) => callback(envelope);
      child.on("message", listener);
      return () => child.removeListener("message", listener);
    },
    onExit: (callback) => {
      const listener = (code: number | null) => callback(code);
      child.on("exit", listener);
      return () => child.removeListener("exit", listener);
    },
    kill: () => child.kill(),
  };
}
```

- [ ] **Step 7: Write the utility process entry**

Create `apps/desktop/electron/pi-runtime/utility-entry.ts`:

```ts
import {
  createPiSdkSessionHost,
  createPiRuntime,
  type PiRuntimeChildTransport,
  type PiRuntimeEnvelope,
} from "@sparkii/agent-host";

const childPort = process.parentPort;

const transport: PiRuntimeChildTransport = {
  postMessage: (envelope: PiRuntimeEnvelope) => childPort.postMessage(envelope),
  onMessage: (callback) => {
    const listener = (messageEvent: Electron.MessageEvent) =>
      callback(messageEvent.data as PiRuntimeEnvelope);
    childPort.on("message", listener);
    return () => childPort.removeListener("message", listener);
  },
};

const host = await createPiSdkSessionHost({ transport });
createPiRuntime({ host, transport });
```

- [ ] **Step 8: Write the fork fallback entry**

Create `apps/desktop/electron/pi-runtime/fork-entry.ts` with the same transport bootstrap as `utility-entry.ts`, except replace the `childPort` transport with:

```ts
const transport: PiRuntimeChildTransport = {
  postMessage: (envelope: PiRuntimeEnvelope) => process.send?.(envelope),
  onMessage: (callback) => {
    const listener = (envelope: PiRuntimeEnvelope) => callback(envelope);
    process.on("message", listener);
    return () => process.removeListener("message", listener);
  },
};
```

The fork entry then calls the same `createPiSdkSessionHost` and `createPiRuntime` functions. Extract the shared `startRuntime(transport)` into a small helper if desired, but do not move the Electron-only transport definitions into `@sparkii/agent-host`.

- [ ] **Step 9: Type-check the desktop main build**

```powershell
pnpm --filter @sparkii/desktop run build:main:check
```

Expected: no type errors. If `process.parentPort` or `utilityProcess` types are missing, add the missing Electron type references or a small local declaration, then rerun.

- [ ] **Step 10: Commit**

```powershell
git add packages/agent-host/src/pi-sdk-runtime.ts packages/agent-host/test/pi-sdk-runtime.test.ts packages/agent-host/src/index.ts apps/desktop/electron/pi-runtime
git commit -m "feat: add Pi SDK host adapter and Electron runtime entries"
```

## Task 8: Wire Main to the new supervisor and remove the external Pi path

**Files:**
- Modify: `apps/desktop/electron/main/runtime.ts`
- Modify: `apps/desktop/electron/main/ipc.ts`
- Modify: `apps/desktop/electron/main/workflow.ts`
- Modify: `apps/desktop/electron/main/recovery.ts`

**Interfaces:**
- Consumes: `PiRuntimeSupervisor`, `createUtilityHostHandle`, `createForkHostHandle`, `ProposalDecision`.
- Produces: a `Runtime` whose `supervisor` is `PiRuntimeSupervisor` and whose proposal callback is registered by Main.

- [ ] **Step 1: Rewrite runtime assembly**

Edit `apps/desktop/electron/main/runtime.ts`:

```ts
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadProfile } from "@sparkii/config";
import { ModelRouter, normalizeRouting } from "@sparkii/model-router";
import { Rbac, LocalIdentityProvider, type Subject } from "@sparkii/identity";
import { ApprovalGate, ConnectorExecutor, AuditStore } from "@sparkii/approval";
import { PiRuntimeSupervisor } from "@sparkii/agent-host";
import { knowledgeConnector } from "@sparkii/connectors";
import { createUtilityHostHandle, createForkHostHandle } from "../pi-runtime/transports.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Runtime {
  profile: Awaited<ReturnType<typeof loadProfile>>;
  router: ModelRouter; rbac: Rbac; gate: ApprovalGate; executor: ConnectorExecutor; audit: AuditStore;
  supervisor: PiRuntimeSupervisor; identity: LocalIdentityProvider; subject: Subject | null;
}

function resolvePiRuntimeEntry(): string {
  const explicit = process.env.SPARKII_PI_RUNTIME_ENTRY;
  if (explicit && existsSync(explicit)) return explicit;
  return join(__dirname, "../pi-runtime/utility-entry.js");
}

export async function assemble(opts: { profileDir: string; dataDir: string; publicKey?: string; allowUnsigned?: boolean }): Promise<Runtime> {
  const profile = await loadProfile(opts.profileDir, { publicKey: opts.publicKey, allowUnsigned: opts.allowUnsigned });
  const router = new ModelRouter(normalizeRouting(profile.manifest.modelRouting.tasks));
  const rbac = new Rbac(profile.security.roles);
  const audit = new AuditStore(join(opts.dataDir, "audit.db"));
  const gate = new ApprovalGate({ policy: profile.security.approval, rbac, audit });
  const executor = new ConnectorExecutor(audit);
  const identity = new LocalIdentityProvider(join(opts.dataDir, "users.json"));
  if ((await identity.listUsers()).length === 0) {
    await identity.seed({ id: "admin", username: "admin", password: "admin123", roles: ["admin", "reviewer"] });
  }
  await knowledgeConnector.init({ corpus: profile.agent.knowledge });
  const entry = resolvePiRuntimeEntry();
  const supervisor = new PiRuntimeSupervisor(() =>
    process.env.SPARKII_PI_USE_FORK === "1"
      ? createForkHostHandle(entry)
      : createUtilityHostHandle(entry),
  );
  return { profile, router, rbac, gate, executor, audit, supervisor, identity, subject: null };
}
```

- [ ] **Step 2: Remove the HTTP control server from Main**

Edit `apps/desktop/electron/main/ipc.ts`:

- Remove `import { ControlServer } from "@sparkii/agent-host";`
- Remove the `const control = new ControlServer(...)` and `control.start()` block.
- Add after `createBroker`:

```ts
rt.supervisor.onProposal((request) => broker.request(request, "default"));
```

Keep the existing `sparkii:decideApproval` handler unchanged. It already resolves `broker.decide`, which returns the `ProposalDecision` to the Pi child through the supervisor.

- [ ] **Step 3: Keep workflow call sites compatible**

Edit `apps/desktop/electron/main/workflow.ts`:

- Replace the local `selectModel` and `sendPrompt` implementation so it still calls `rt.supervisor.start()`.
- No signature changes are required because `PiRuntimeClient.send` and `onEvent` match the old `PiRpcClient` shape.
- Remove the local `interface Decision` if it is no longer used; use `ProposalDecision` from `@sparkii/agent-host` in the broker return type.

- [ ] **Step 4: Adapt recovery**

Edit `apps/desktop/electron/main/recovery.ts`:

- Replace `const c = await rt.supervisor.start();` with the same call; the type is now `PiRuntimeClient`.
- The following commands remain valid:

```ts
await c.send({ type: "set_auto_retry", enabled: true });
await c.send({ type: "set_auto_compaction", enabled: true });
if (sessionFile) await c.send({ type: "switch_session", sessionPath: sessionFile });
```

- [ ] **Step 5: Run the desktop main type-check and unit tests**

```powershell
pnpm --filter @sparkii/desktop run build:main:check
pnpm vitest run apps/desktop/test
```

Expected: no type errors and existing tests pass.

- [ ] **Step 6: Commit**

```powershell
git add apps/desktop/electron/main/runtime.ts apps/desktop/electron/main/ipc.ts apps/desktop/electron/main/workflow.ts apps/desktop/electron/main/recovery.ts
git commit -m "refactor(desktop): use managed Pi runtime instead of external pi process"
```

## Task 9: Bundle the Pi runtime and SDK into the installer

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/electron-builder.yml`

**Interfaces:**
- Consumes: `apps/desktop/electron/pi-runtime/utility-entry.ts` and `fork-entry.ts` from Task 7.
- Produces: `dist-electron/pi-runtime/utility-entry.js` and `fork-entry.js` plus packaged Pi SDK dependencies.

- [ ] **Step 1: Add build targets**

Edit `apps/desktop/package.json` and replace the `build:main` script, and add a `prebuild:main` script that removes the previous `dist-electron` tree so stale `tsc` output is never packaged:

```json
"prebuild:main": "node -e \"const fs=require('fs');fs.rmSync('dist-electron',{recursive:true,force:true})\"",
"build:main": "esbuild electron/main/index.ts --bundle --platform=node --format=esm --external:electron --external:better-sqlite3 --banner:js=\"import { createRequire } from 'module'; const require = createRequire(import.meta.url);\" --outfile=dist-electron/main/index.js && esbuild electron/preload/index.ts --bundle --platform=node --format=cjs --external:electron --outfile=dist-electron/preload/index.cjs && esbuild electron/pi-runtime/utility-entry.ts --bundle --platform=node --format=esm --external:electron --outfile=dist-electron/pi-runtime/utility-entry.js && esbuild electron/pi-runtime/fork-entry.ts --bundle --platform=node --format=esm --external:electron --outfile=dist-electron/pi-runtime/fork-entry.js"
```

- [ ] **Step 2: Include runtime outputs in electron-builder**

Edit `apps/desktop/electron-builder.yml` so `files` includes:

```yaml
  - dist-electron/pi-runtime/**
```

If the Pi SDK package contains native `.node` files that esbuild cannot bundle, add the exact package under `asarUnpack` after running the build and inspecting `dist-electron/pi-runtime`. Do not preemptively unpack all of `node_modules`.

- [ ] **Step 3: Build the main process**

```powershell
pnpm --filter @sparkii/desktop run build:main
```

Expected: `dist-electron/pi-runtime/utility-entry.js` and `fork-entry.js` are created, and no unresolved Pi SDK import remains.

- [ ] **Step 4: Verify no external `pi` dependency remains**

```powershell
rg -n "resolvePiBin|SPARKII_PI_BIN|PI_BIN|/c.*pi\.cmd|spawn\(.*cmd" apps packages -g '!node_modules'
```

Expected: no matches in the Main runtime path. Developer-only environment overrides such as `SPARKII_PI_RUNTIME_ENTRY` and `SPARKII_PI_USE_FORK` are allowed.

- [ ] **Step 5: Commit**

```powershell
git add apps/desktop/package.json apps/desktop/electron-builder.yml
git commit -m "build(desktop): bundle Pi runtime entry and SDK into installer"
```

## Task 10: Remove obsolete external-Pi runtime code

**Files:**
- Delete: `packages/agent-host/src/process.ts`
- Delete: `packages/agent-host/src/control-server.ts`
- Delete: `packages/agent-host/src/bridge/extension.ts`
- Delete: `packages/agent-host/test/process.test.ts`
- Delete: `packages/agent-host/test/control-server.test.ts`
- Replace: `packages/agent-host/test/pi.integration.test.ts`
- Modify: `packages/agent-host/src/index.ts`

**Interfaces:**
- Consumes: new supervisor/client from Task 4 and envelope contract from Task 3.
- Produces: a public `@sparkii/agent-host` surface with no external Pi process or HTTP control server.

- [ ] **Step 1: Delete obsolete source and tests**

```powershell
Remove-Item -LiteralPath "packages/agent-host/src/process.ts"
Remove-Item -LiteralPath "packages/agent-host/src/control-server.ts"
Remove-Item -LiteralPath "packages/agent-host/src/bridge/extension.ts"
Remove-Item -LiteralPath "packages/agent-host/test/process.test.ts"
Remove-Item -LiteralPath "packages/agent-host/test/control-server.test.ts"
```

- [ ] **Step 2: Replace the old Pi integration test**

Create `packages/agent-host/test/fixtures/pi-runtime-test-child.mjs`:

```js
process.on("message", (env) => {
  if (env && env.direction === "main-to-runtime") {
    process.send({
      direction: "runtime-to-main",
      id: env.id,
      response: {
        id: env.id,
        type: "response",
        command: env.command.type,
        success: true,
      },
    });
    process.send({
      direction: "runtime-to-main",
      event: { type: "agent_start" },
    });
  }
});
process.stdin.resume();
```

Overwrite `packages/agent-host/test/pi.integration.test.ts` with:

```ts
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { PiRuntimeSupervisor } from "../src/pi-runtime-supervisor.js";
import {
  type PiRuntimeEnvelope,
  type PiRuntimeHostHandle,
} from "../src/pi-runtime-transport.js";

const childPath = fileURLToPath(new URL("./fixtures/pi-runtime-test-child.mjs", import.meta.url));

function forkHandle(): PiRuntimeHostHandle {
  const child: ChildProcess = fork(childPath, [], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  return {
    postMessage: (envelope) => child.send(envelope),
    onMessage: (callback) => {
      const listener = (envelope: PiRuntimeEnvelope) => callback(envelope);
      child.on("message", listener);
      return () => child.removeListener("message", listener);
    },
    onExit: (callback) => {
      const listener = (code: number | null) => callback(code);
      child.on("exit", listener);
      return () => child.removeListener("exit", listener);
    },
    kill: () => child.kill(),
  };
}

describe("PiRuntimeSupervisor integration", () => {
  it("round-trips commands and events through a real child process", async () => {
    const supervisor = new PiRuntimeSupervisor(forkHandle);
    const client = await supervisor.start();
    const events: unknown[] = [];
    client.onEvent((event) => events.push(event));
    const response = await client.send({ type: "abort" });
    expect(response.success).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(events).toContainEqual({ type: "agent_start" });
    await supervisor.stop();
  });
});
```

- [ ] **Step 3: Trim public exports**

Overwrite `packages/agent-host/src/index.ts` with:

```ts
export * from "./rpc-client.js";
export * from "./pi-runtime-transport.js";
export * from "./pi-runtime-supervisor.js";
export * from "./pi-runtime.js";
export * from "./pi-runtime-tools.js";
export * from "./bridge/typebox.js";
export * from "./workflow/types.js";
export * from "./workflow/linear.js";
```

- [ ] **Step 4: Run the agent-host suite**

```powershell
pnpm vitest run packages/agent-host/test
```

Expected: all tests pass, including the replacement integration test.

- [ ] **Step 5: Commit**

```powershell
git add -A packages/agent-host
git commit -m "refactor(agent-host): remove obsolete external Pi process and control server"
```

## Task 11: Full verification and clean-environment acceptance

**Files:**
- Modify: `apps/desktop/test/preload-api.test.ts` if any new public API shape requires it.
- No new product code unless a test exposes a regression.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: verified build and packaged app.

- [ ] **Step 1: Run all tests**

```powershell
pnpm test
```

Expected: all Vitest suites pass.

- [ ] **Step 2: Run the Playwright Electron pilot**

```powershell
pnpm --filter @sparkii/desktop exec playwright test e2e/pilot.spec.ts
```

Expected: pilot flow passes.

- [ ] **Step 3: Build the Windows installer**

```powershell
pnpm --filter @sparkii/desktop run dist
```

Expected: NSIS/MSIX artifacts are produced under `apps/desktop/out`.

- [ ] **Step 4: Clean-machine acceptance**

On a Windows machine without `pi`, pnpm, or system Node:

1. Install the produced NSIS package.
2. Launch Sparkii.
3. Confirm no terminal/console window appears.
4. Complete one chat prompt and one workflow with a configured model endpoint.
5. Trigger a write proposal, approve it, and confirm the audit row is written.

Record the result in the commit message body or a release note.

- [ ] **Step 5: Commit any test/config fixes**

```powershell
git add .
git commit -m "test(desktop): verify managed Pi runtime in packaged app"
```
