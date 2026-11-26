import { describe, it, expect, vi } from "vitest";
import { PiRuntimePool } from "../src/pi-runtime-pool.js";
import type { RuntimePoolSnapshot } from "../src/runtime-pool.js";
import { eventEnvelope, readyEnvelope, responseEnvelope, type PiRuntimeHostHandle, type PiRuntimeEnvelope } from "../src/pi-runtime-transport.js";

class FakeHandle implements PiRuntimeHostHandle {
  sent: PiRuntimeEnvelope[] = [];
  killed = false;
  sessionGeneration = 0;
  private messageCb?: (env: PiRuntimeEnvelope) => void;
  private exitCb?: (code: number | null) => void;
  postMessage(e: PiRuntimeEnvelope) {
    this.sent.push(e);
    if ("command" in e) this.emit(this.responseFor(e));
  }
  protected responseFor(e: Extract<PiRuntimeEnvelope, { command: unknown }>) {
    if (e.command.type === "new_session" || e.command.type === "switch_session") this.sessionGeneration += 1;
    return responseEnvelope(e.id, {
      id: e.id, type: "response", command: e.command.type, success: true,
      data: e.command.type === "new_session" || e.command.type === "switch_session"
        ? { sessionGeneration: this.sessionGeneration }
        : undefined,
    });
  }
  onMessage(cb: (env: PiRuntimeEnvelope) => void) { this.messageCb = cb; return () => { this.messageCb = undefined; }; }
  onExit(cb: (code: number | null) => void) { this.exitCb = cb; return () => { this.exitCb = undefined; }; }
  emit(env: PiRuntimeEnvelope) { this.messageCb?.(env); }
  crash(code: number | null = 1) { this.exitCb?.(code); }
  kill() { this.killed = true; this.crash(0); }
  ready() { this.emit(readyEnvelope()); }
}

class DeferredResetHandle extends FakeHandle {
  resetRequests: PiRuntimeEnvelope[] = [];
  sessionGeneration = 0;

  postMessage(e: PiRuntimeEnvelope) {
    this.sent.push(e);
    if ("command" in e && e.command.type === "new_session") {
      this.resetRequests.push(e);
      return;
    }
    if ("command" in e) {
      if (e.command.type === "switch_session") this.sessionGeneration += 1;
      this.emit(responseEnvelope(e.id, {
        id: e.id, type: "response", command: e.command.type, success: true,
        data: e.command.type === "switch_session" ? { sessionGeneration: this.sessionGeneration } : undefined,
      }));
    }
  }

  finishReset(success = true): void {
    const request = this.resetRequests.shift();
    if (!request || !("command" in request)) throw new Error("no pending new_session request");
    if (success) this.sessionGeneration += 1;
    this.emit(responseEnvelope(request.id, {
      id: request.id,
      type: "response",
      command: "new_session",
      success,
      error: success ? undefined : "reset failed",
      data: success ? { sessionGeneration: this.sessionGeneration } : undefined,
    }));
  }
}

class DelayedSwitchHandle extends FakeHandle {
  switchRequests: PiRuntimeEnvelope[] = [];
  newSessionRequests: PiRuntimeEnvelope[] = [];
  currentSessionFile: string | null = null;

  postMessage(e: PiRuntimeEnvelope) {
    this.sent.push(e);
    if (!("command" in e)) return;
    if (e.command.type === "switch_session") {
      this.switchRequests.push(e);
      return;
    }
    if (e.command.type === "new_session") {
      this.newSessionRequests.push(e);
      this.currentSessionFile = null;
    }
    this.emit(this.responseFor(e));
  }

  finishSwitch(): void {
    const request = this.switchRequests.shift();
    if (!request || !("command" in request)) throw new Error("no pending switch_session request");
    this.currentSessionFile = request.command.sessionPath;
    this.sessionGeneration += 1;
    this.emit(responseEnvelope(request.id, {
      id: request.id,
      type: "response",
      command: "switch_session",
      success: true,
      data: { sessionGeneration: this.sessionGeneration },
    }));
  }
}

describe("PiRuntimePool", () => {
  it("R7 coalesces concurrent acquisition of one session id into a single owner", async () => {
    const handles: FakeHandle[] = [];
    const events: string[] = [];
    const pool = new PiRuntimePool({
      maxAgents: 2,
      makeSupervisor: () => { const handle = new FakeHandle(); handles.push(handle); return handle; },
    });
    const first = pool.acquire("same-session");
    const second = pool.acquire("same-session");
    handles[0].ready();
    const [a, b] = await Promise.all([first, second]);

    expect(handles).toHaveLength(1);
    expect(a.client).toBe(b.client);
    expect(pool.activeCount()).toBe(1);
    expect(pool.snapshot()).toMatchObject({ active: 1, queued: 0 });
    expect(pool.snapshot().slots.map((slot) => slot.sessionId)).toEqual(["same-session"]);
    const off = a.client.onEvent((event) => events.push(event.type));
    handles[0].emit(eventEnvelope({ type: "agent_start" }));
    expect(events).toEqual(["agent_start"]);
    off();
    await pool.release("same-session");
    expect(pool.activeCount()).toBe(0);
    expect(pool.snapshot().slots).toEqual([]);
  });

  it("R8 round7 B1 retires a cancelled opening instead of letting a late switch undo release", async () => {
    const handles: DelayedSwitchHandle[] = [];
    const pool = new PiRuntimePool({
      maxAgents: 1,
      makeSupervisor: () => {
        const handle = new DelayedSwitchHandle();
        handles.push(handle);
        return handle;
      },
    });
    const acquiring = pool.acquire("private", { resumeSessionFile: "/tmp/private.jsonl" })
      .catch((error: unknown) => error);
    handles[0].ready();
    await vi.waitFor(() => expect(handles[0].switchRequests).toHaveLength(1));
    const openingClient = pool.get("private");

    expect(pool.cancelAcquire("private")).toBe(true);
    let releaseSettled = false;
    const releasing = pool.release("private").then(() => { releaseSettled = true; });
    let replacementSettled = false;
    const replacement = pool.acquire("replacement").then((slot) => {
      replacementSettled = true;
      return slot;
    });
    // Let an incorrectly serialized release run to completion; the fixed pool
    // must still be waiting behind the delayed switch here.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const beforeLateSwitch = {
      releaseSettled,
      replacementSettled,
      resetRequests: handles[0].newSessionRequests.length,
      killed: handles[0].killed,
      handles: handles.length,
    };

    try {
      expect(beforeLateSwitch).toEqual({
        releaseSettled: false,
        replacementSettled: false,
        resetRequests: 0,
        killed: false,
        handles: 1,
      });

      handles[0].finishSwitch();
      await expect(acquiring).resolves.toMatchObject({ message: "RUNTIME_ACQUIRE_CANCELLED" });
      await releasing;
      await vi.waitFor(() => expect(handles).toHaveLength(2));
      handles[1].ready();
      const next = await replacement;

      expect(handles[0].killed).toBe(true);
      expect(handles[0].currentSessionFile).toBe("/tmp/private.jsonl");
      expect(next.client).not.toBe(openingClient);
      expect(next.getSessionId()).toBe("replacement");
      expect(pool.get("private")).toBeUndefined();
      expect(pool.get("replacement")).toBe(next.client);
    } finally {
      if (handles[0].switchRequests.length) handles[0].finishSwitch();
      await acquiring;
      await releasing.catch(() => undefined);
      if (handles[1]) handles[1].ready();
      await replacement.catch(() => undefined);
      await pool.stopAll();
    }
  });

  it("R8-P0-2 cancels only the queued acquisition for a session being deleted", async () => {
    const handle = new FakeHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    await pool.acquire("active");
    handle.ready();
    const queued = pool.acquire("s-private");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pool.cancelAcquire("s-private")).toBe(true);
    await expect(queued).rejects.toThrow("RUNTIME_ACQUIRE_CANCELLED");
    expect(pool.snapshot()).toMatchObject({ active: 1, queued: 0, queue: [] });
    expect(pool.getBinding("s-private")).toBeUndefined();

    await pool.release("active");
    expect(pool.getBinding("s-private")).toBeUndefined();
    expect(pool.activeCount()).toBe(0);
    await pool.stopAll();
  });

  it("R8-P0-2 stops a cold-starting supervisor when acquisition is cancelled", async () => {
    const handles: FakeHandle[] = [];
    const pool = new PiRuntimePool({
      maxAgents: 1,
      makeSupervisor: () => { const handle = new FakeHandle(); handles.push(handle); return handle; },
    });
    const acquiring = pool.acquire("s-private");

    expect(pool.cancelAcquire("s-private")).toBe(true);
    handles[0].ready();
    await expect(acquiring).rejects.toThrow("RUNTIME_ACQUIRE_CANCELLED");
    expect(handles[0].killed).toBe(true);
    expect(pool.snapshot()).toMatchObject({ active: 0, queued: 0, slots: [], queue: [] });
    expect(pool.getBinding("s-private")).toBeUndefined();
    await pool.stopAll();
  });

  it("P1-7 reserves cold-start capacity before supervisor startup", async () => {
    const handles: FakeHandle[] = [];
    const pool = new PiRuntimePool({
      maxAgents: 1,
      makeSupervisor: () => { const handle = new FakeHandle(); handles.push(handle); return handle; },
    });
    const first = pool.acquireIfIdle("memory:1", { meta: { profileId: "internal", internal: true } });
    const second = pool.acquireIfIdle("memory:2", { meta: { profileId: "internal", internal: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handles).toHaveLength(1);
    expect(await second).toBeNull();
    handles[0].ready();
    expect(await first).toBeTruthy();
    expect(pool.activeCount()).toBe(1);
    await pool.release("memory:1");
  });

  it("reuses a free slot across release", async () => {
    const handles: FakeHandle[] = [];
    const pool = new PiRuntimePool({ maxAgents: 2, makeSupervisor: () => { const h = new FakeHandle(); handles.push(h); return h; } });
    const a = await pool.acquire("a");
    handles[0].ready();
    expect(a.client).toBeTruthy();
    expect(pool.get("a")).toBe(a.client);
    expect(pool.activeCount()).toBe(1);
    await pool.release("a");
    expect(pool.get("a")).toBeUndefined();
    expect(pool.activeCount()).toBe(0);
    const b = await pool.acquire("b");
    expect(b.client).toBe(a.client); // 复用同一个 supervisor 的 client
  });

  it("queues beyond maxAgents and wakes on release", async () => {
    const handle = new FakeHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    await pool.acquire("a");
    handle.ready();
    let resolved = false;
    const p = pool.acquire("b").then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);
    await pool.release("a");
    await p;
    expect(resolved).toBe(true);
    expect(pool.get("b")).toBeTruthy();
  });

  it("wakes queued sessions when maxAgents increases", async () => {
    const handles: FakeHandle[] = [];
    const pool = new PiRuntimePool({
      maxAgents: 1,
      makeSupervisor: () => { const handle = new FakeHandle(); handles.push(handle); return handle; },
    });
    const first = pool.acquire("a");
    handles[0].ready();
    await first;
    const queued = pool.acquire("b");

    pool.setMaxAgents(2);

    expect(handles).toHaveLength(2);
    handles[1].ready();
    await expect(queued).resolves.toBeTruthy();
    expect(pool.snapshot()).toMatchObject({ active: 2, queued: 0, maxAgents: 2 });
  });

  it("sends new_session on release", async () => {
    const handle = new FakeHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    await pool.acquire("a");
    handle.ready();
    await pool.release("a");
    const sent = handle.sent.find((e) => "command" in e && (e as any).command?.type === "new_session");
    expect(sent).toBeTruthy();
  });

  it("retires a slot whose new_session fails instead of reusing it", async () => {
    class FailingNewSessionHandle extends FakeHandle {
      postMessage(e: PiRuntimeEnvelope) {
        this.sent.push(e);
        if ("command" in e) {
          const command = (e as { command: { type: string } }).command;
          this.emit(responseEnvelope(e.id, {
            id: e.id,
            type: "response",
            command: command.type as never,
            success: command.type !== "new_session",
          }));
        }
      }
    }
    const handles: FakeHandle[] = [];
    const pool = new PiRuntimePool({
      maxAgents: 1,
      makeSupervisor: () => {
        const handle = new FailingNewSessionHandle();
        handles.push(handle);
        return handle;
      },
    });
    await pool.acquire("a");
    handles[0].ready();
    await pool.release("a");

    // 会话没能重置 ⇒ 槽位必须被摘掉（不能带着上一条会话的状态回池）
    expect(pool.activeCount()).toBe(0);
    const b = await pool.acquire("b");
    expect(handles.length).toBe(2);
    expect(pool.get("b")).toBe(b.client);
  });

  it("R7 keeps a resetting slot unavailable and queues a concurrent acquire until reset succeeds", async () => {
    const handle = new DeferredResetHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    const first = await pool.acquire("a");
    handle.ready();
    const attributedDuringReset: Array<string | null> = [];
    first.client.onEvent(() => attributedDuringReset.push(first.getSessionId()));

    const releasing = pool.release("a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handle.resetRequests).toHaveLength(1);
    let concurrentResolved = false;
    const concurrent = pool.acquire("b").then((slot) => { concurrentResolved = true; return slot; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    handle.emit(eventEnvelope({ type: "agent_start" }));
    const duringReset = {
      snapshot: pool.snapshot(),
      active: pool.activeCount(),
      a: pool.get("a"),
      b: pool.get("b"),
      resolved: concurrentResolved,
      sessionId: first.getSessionId(),
    };

    handle.finishReset();
    await releasing;
    const second = await concurrent;

    expect(duringReset).toMatchObject({ active: 0, resolved: false, sessionId: null });
    expect(duringReset.a).toBeUndefined();
    expect(duringReset.b).toBeUndefined();
    expect(duringReset.snapshot).toMatchObject({ active: 0, queued: 1, slots: [], queue: [{ position: 1 }] });
    expect(attributedDuringReset).toEqual([]);
    expect(second.client).toBe(first.client);
    expect(pool.get("a")).toBeUndefined();
    expect(pool.get("b")).toBe(second.client);
    expect(pool.activeCount()).toBe(1);
    expect(pool.snapshot()).toMatchObject({ active: 1, queued: 0, slots: [{ sessionId: "b" }] });
    await pool.stopAll();
  });

  it("R7 ignores a stale lease release after the same session id is reacquired", async () => {
    const handle = new DeferredResetHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    const first = await pool.acquire("same");
    handle.ready();
    const oldLease = pool.getBinding("same")?.lease;
    expect(oldLease).toBeTypeOf("number");

    const releasing = pool.release("same", oldLease);
    await new Promise((resolve) => setTimeout(resolve, 0));
    handle.finishReset();
    await releasing;
    const second = await pool.acquire("same");
    const newLease = pool.getBinding("same")?.lease;
    expect(second.client).toBe(first.client);
    expect(newLease).not.toBe(oldLease);

    const resetCount = () => handle.sent.filter((entry) => "command" in entry && entry.command.type === "new_session").length;
    expect(resetCount()).toBe(1);
    const staleRelease = pool.release("same", oldLease);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resetCount()).toBe(1);
    await staleRelease;
    expect(pool.get("same")).toBe(second.client);
    expect(pool.activeCount()).toBe(1);
    expect(pool.snapshot()).toMatchObject({ active: 1, slots: [{ sessionId: "same" }] });

    const finalRelease = pool.release("same", newLease);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resetCount()).toBe(2);
    handle.finishReset();
    await finalRelease;
    expect(pool.get("same")).toBeUndefined();
    await pool.stopAll();
  });

  it("R7 drops pre-reset events after rebind and accepts new-generation events", async () => {
    const handle = new DeferredResetHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    const first = await pool.acquire("a");
    handle.ready();
    const seen: string[] = [];
    first.client.onEvent((event) => seen.push(event.type));

    const releasing = pool.release("a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const concurrent = pool.acquire("b");
    await new Promise((resolve) => setTimeout(resolve, 0));
    handle.finishReset();
    await releasing;
    const second = await concurrent;

    handle.emit({
      direction: "runtime-to-main",
      event: { type: "agent_start" },
      sessionGeneration: 0,
    } as unknown as PiRuntimeEnvelope);
    expect(seen).toEqual([]);
    expect(pool.snapshot().slots[0]?.status).toBe("occupied-idle");

    handle.emit({
      direction: "runtime-to-main",
      event: { type: "agent_start" },
      sessionGeneration: 1,
    } as unknown as PiRuntimeEnvelope);
    expect(seen).toEqual(["agent_start"]);
    expect(pool.snapshot().slots[0]?.status).toBe("streaming");
    expect(second.client).toBe(first.client);
    await pool.stopAll();
  });

  it.each(['missing', 'equal'] as const)('R7 retires a slot when a successful new_session returns a %s generation', async (mode) => {
    class InvalidGenerationHandle extends FakeHandle {
      postMessage(e: PiRuntimeEnvelope) {
        this.sent.push(e);
        if (!("command" in e)) return;
        if (e.command.type !== "new_session") {
          this.emit(this.responseFor(e));
          return;
        }
        this.emit(responseEnvelope(e.id, {
          id: e.id, type: "response", command: "new_session", success: true,
          data: mode === "equal" ? { sessionGeneration: 0 } : undefined,
        }));
      }
    }
    const handles: InvalidGenerationHandle[] = [];
    const pool = new PiRuntimePool({
      maxAgents: 1,
      makeSupervisor: () => { const handle = new InvalidGenerationHandle(); handles.push(handle); return handle; },
    });
    const first = await pool.acquire("a");
    handles[0].ready();
    await pool.release("a");

    expect(handles[0].killed).toBe(true);
    const next = await pool.acquire("b");
    expect(handles).toHaveLength(2);
    expect(next.client).not.toBe(first.client);
    expect(pool.get("b")).toBe(next.client);
    await pool.stopAll();
  });

  it.each(['missing', 'equal'] as const)('R7 retires a bound slot when the exposed facade sends new_session with a %s generation', async (mode) => {
    class DirectFacadeGenerationHandle extends FakeHandle {
      newSessionRequests = 0;

      postMessage(e: PiRuntimeEnvelope) {
        this.sent.push(e);
        if (!("command" in e)) return;
        if (e.command.type !== "new_session") {
          this.emit(this.responseFor(e));
          return;
        }
        this.newSessionRequests += 1;
        if (this.newSessionRequests === 1) {
          this.emit(responseEnvelope(e.id, {
            id: e.id, type: "response", command: "new_session", success: true,
            data: mode === "equal" ? { sessionGeneration: this.sessionGeneration } : undefined,
          }));
          return;
        }
        // A later pool.release response is valid; it must not revive the retired client.
        this.sessionGeneration += 1;
        this.emit(responseEnvelope(e.id, {
          id: e.id, type: "response", command: "new_session", success: true,
          data: { sessionGeneration: this.sessionGeneration },
        }));
      }
    }
    const handles: DirectFacadeGenerationHandle[] = [];
    const pool = new PiRuntimePool({
      maxAgents: 1,
      makeSupervisor: () => { const handle = new DirectFacadeGenerationHandle(); handles.push(handle); return handle; },
    });
    try {
      const first = await pool.acquire("a");
      const handle = handles[0];
      handle.ready();
      pool.renameSession("a", "renamed");

      await expect(first.client.send({ type: "new_session" })).rejects.toThrow(/generation/i);

      // Retirement is observable before the rejected facade send settles.
      expect(first.getSessionId()).toBeNull();
      expect(pool.get("a")).toBeUndefined();
      expect(pool.get("renamed")).toBeUndefined();
      expect(pool.activeCount()).toBe(0);
      expect(pool.snapshot()).toMatchObject({ active: 0, queued: 0, slots: [] });
      expect(handle.killed).toBe(true);

      await pool.release("renamed");
      expect(handle.newSessionRequests).toBe(1);
      expect(handle.killed).toBe(true);
      expect(pool.get("a")).toBeUndefined();
      expect(pool.get("renamed")).toBeUndefined();
      expect(pool.activeCount()).toBe(0);

      const acquiring = pool.acquire("b");
      expect(handles).toHaveLength(2);
      handles[1].ready();
      const second = await acquiring;
      expect(second.client).not.toBe(first.client);
      expect(handles[1].killed).toBe(false);
      expect(pool.get("b")).toBe(second.client);
      expect(pool.activeCount()).toBe(1);
    } finally {
      await pool.stopAll();
    }
  });

  it.each(['missing', 'equal'] as const)('R7 retires a bound slot when the exposed facade sends switch_session with a %s generation', async (mode) => {
    class DirectSwitchGenerationHandle extends FakeHandle {
      postMessage(e: PiRuntimeEnvelope) {
        this.sent.push(e);
        if (!("command" in e)) return;
        if (e.command.type !== "switch_session") {
          this.emit(this.responseFor(e));
          return;
        }
        this.emit(responseEnvelope(e.id, {
          id: e.id, type: "response", command: "switch_session", success: true,
          data: mode === "equal" ? { sessionGeneration: this.sessionGeneration } : undefined,
        }));
      }
    }
    const handle = new DirectSwitchGenerationHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    try {
      const first = await pool.acquire("a");
      handle.ready();

      await expect(first.client.send({ type: "switch_session", sessionPath: "/tmp/direct.jsonl" })).rejects.toThrow(/generation/i);

      expect(first.getSessionId()).toBeNull();
      expect(pool.get("a")).toBeUndefined();
      expect(pool.activeCount()).toBe(0);
      expect(pool.snapshot().slots).toEqual([]);
      expect(handle.killed).toBe(true);
    } finally {
      await pool.stopAll();
    }
  });

  it("R7 retires an uncertain slot once for concurrent exposed facade sends", async () => {
    class ConcurrentInvalidGenerationHandle extends FakeHandle {
      kills = 0;
      postMessage(e: PiRuntimeEnvelope) {
        this.sent.push(e);
        if (!("command" in e)) return;
        this.emit(responseEnvelope(e.id, {
          id: e.id, type: "response", command: e.command.type, success: true,
          data: e.command.type === "new_session" ? undefined : { sessionGeneration: this.sessionGeneration },
        }));
      }
      kill() { this.kills += 1; super.kill(); }
    }
    const handle = new ConcurrentInvalidGenerationHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    try {
      const first = await pool.acquire("a");
      handle.ready();
      const outcomes = await Promise.allSettled([
        first.client.send({ type: "new_session" }),
        first.client.send({ type: "new_session" }),
      ]);

      expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
      expect(handle.kills).toBe(1);
      expect(handle.killed).toBe(true);
      expect(pool.get("a")).toBeUndefined();
      expect(pool.activeCount()).toBe(0);
      expect(pool.snapshot().slots).toEqual([]);
    } finally {
      await pool.stopAll();
    }
  });

  it.each(['new_session', 'switch_session'] as const)("R7 does not validate generation data on an unsuccessful exposed facade %s response", async (type) => {
    class UnsuccessfulDirectHandle extends FakeHandle {
      postMessage(e: PiRuntimeEnvelope) {
        this.sent.push(e);
        if (!("command" in e)) return;
        this.emit(responseEnvelope(e.id, {
          id: e.id, type: "response", command: e.command.type,
          success: e.command.type !== type,
          error: e.command.type === type ? "session change rejected" : undefined,
          data: e.command.type === type ? { sessionGeneration: -1 } : undefined,
        }));
      }
    }
    const handle = new UnsuccessfulDirectHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    try {
      const first = await pool.acquire("a");
      handle.ready();
      const command = type === "new_session"
        ? { type } as const
        : { type, sessionPath: "/tmp/rejected.jsonl" } as const;

      await expect(first.client.send(command)).resolves.toMatchObject({ success: false, error: "session change rejected" });
      expect(handle.killed).toBe(false);
      expect(first.getSessionId()).toBe("a");
      expect(pool.get("a")).toBe(first.client);
      expect(pool.activeCount()).toBe(1);
    } finally {
      await pool.stopAll();
    }
  });

  it.each(['new_session', 'switch_session'] as const)("R7 rejects session-changing %s broadcasts without sending them", async (type) => {
    const handle = new FakeHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    try {
      const first = await pool.acquire("a");
      handle.ready();
      const sentBefore = handle.sent.length;
      const command = type === "new_session"
        ? { type } as const
        : { type, sessionPath: "/tmp/broadcast.jsonl" } as const;

      await expect(pool.broadcast(command)).rejects.toThrow(/broadcast/i);
      expect(handle.sent).toHaveLength(sentBefore);
      expect(handle.killed).toBe(false);
      expect(pool.get("a")).toBe(first.client);
      expect(pool.activeCount()).toBe(1);
    } finally {
      await pool.stopAll();
    }
  });

  it("R7 rejects an equal switch_session generation and retires the uncertain slot", async () => {
    class EqualSwitchHandle extends FakeHandle {
      postMessage(e: PiRuntimeEnvelope) {
        this.sent.push(e);
        if (!("command" in e)) return;
        if (e.command.type !== "switch_session") {
          this.emit(this.responseFor(e));
          return;
        }
        this.emit(responseEnvelope(e.id, {
          id: e.id, type: "response", command: "switch_session", success: true,
          data: { sessionGeneration: this.sessionGeneration },
        }));
      }
    }
    const handles: EqualSwitchHandle[] = [];
    const pool = new PiRuntimePool({
      maxAgents: 1,
      makeSupervisor: () => { const handle = new EqualSwitchHandle(); handles.push(handle); return handle; },
    });
    await pool.acquire("a");
    handles[0].ready();
    await pool.release("a");

    await expect(pool.acquire("b", { resumeSessionFile: "/tmp/b.jsonl" })).rejects.toThrow(/generation/i);
    expect(handles[0].killed).toBe(true);
    const next = await pool.acquire("c");
    expect(handles).toHaveLength(2);
    expect(pool.get("c")).toBe(next.client);
    await pool.stopAll();
  });

  it("R7 does not validate generation data on an unsuccessful switch_session response", async () => {
    class UnsuccessfulSwitchHandle extends FakeHandle {
      postMessage(e: PiRuntimeEnvelope) {
        this.sent.push(e);
        if (!("command" in e)) return;
        if (e.command.type !== "switch_session") {
          this.emit(this.responseFor(e));
          return;
        }
        this.emit(responseEnvelope(e.id, {
          id: e.id, type: "response", command: "switch_session", success: false,
          error: "switch rejected", data: { sessionGeneration: -1 },
        }));
      }
    }
    const handle = new UnsuccessfulSwitchHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });

    const failed = pool.acquire("a", { resumeSessionFile: "/tmp/a.jsonl" });
    handle.ready();
    await expect(failed).rejects.toThrow(/switch_session failed: switch rejected/);
    expect(handle.killed).toBe(false);
    const next = await pool.acquire("b");
    expect(next.client).toBe(pool.get("b"));
    await pool.release("b");
    await pool.stopAll();
  });

  it("R7 drops stale events throughout switch_session and accepts only the confirmed generation", async () => {
    class DeferredSwitchHandle extends FakeHandle {
      switchRequests: PiRuntimeEnvelope[] = [];
      postMessage(e: PiRuntimeEnvelope) {
        this.sent.push(e);
        if ("command" in e && e.command.type === "switch_session") {
          this.switchRequests.push(e);
          return;
        }
        if ("command" in e) this.emit(this.responseFor(e));
      }
      finishSwitch(): void {
        const request = this.switchRequests.shift();
        if (!request || !("command" in request)) throw new Error("no pending switch_session request");
        this.sessionGeneration += 1;
        this.emit(responseEnvelope(request.id, {
          id: request.id, type: "response", command: "switch_session", success: true,
          data: { sessionGeneration: this.sessionGeneration },
        }));
      }
    }
    const handle = new DeferredSwitchHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    const acquiring = pool.acquire("a", { resumeSessionFile: "/tmp/a.jsonl" });
    handle.ready();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const seen: string[] = [];
    pool.get("a")!.onEvent((event) => seen.push(event.type));
    handle.emit({ direction: "runtime-to-main", event: { type: "agent_start" }, sessionGeneration: 0 } as unknown as PiRuntimeEnvelope);
    expect(seen).toEqual([]);
    handle.finishSwitch();
    const slot = await acquiring;
    expect(slot.client).toBe(pool.get("a"));
    handle.emit({ direction: "runtime-to-main", event: { type: "agent_start" }, sessionGeneration: 0 } as unknown as PiRuntimeEnvelope);
    expect(seen).toEqual([]);
    handle.emit({ direction: "runtime-to-main", event: { type: "agent_start" }, sessionGeneration: 1 } as unknown as PiRuntimeEnvelope);
    expect(seen).toEqual(["agent_start"]);
    await pool.release("a");
    await pool.stopAll();
  });

  it("R7 clears a concurrent binding on reset failure and gives the waiter a healthy new client", async () => {
    const handles: DeferredResetHandle[] = [];
    const pool = new PiRuntimePool({
      maxAgents: 1,
      makeSupervisor: () => { const handle = new DeferredResetHandle(); handles.push(handle); return handle; },
    });
    const first = await pool.acquire("a");
    handles[0].ready();

    const releasing = pool.release("a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const concurrent = pool.acquire("b");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const bindingDuringReset = pool.get("b");
    const snapshotDuringReset = pool.snapshot();

    handles[0].finishReset(false);
    await releasing;
    const second = await concurrent;

    expect(bindingDuringReset).toBeUndefined();
    expect(snapshotDuringReset).toMatchObject({ active: 0, queued: 1, slots: [] });
    expect(handles).toHaveLength(2);
    expect(handles[0].killed).toBe(true);
    expect(second.client).not.toBe(first.client);
    expect(pool.get("b")).toBe(second.client);
    expect(pool.activeCount()).toBe(1);
    expect(pool.snapshot()).toMatchObject({ active: 1, queued: 0, slots: [{ sessionId: "b" }] });
    await pool.stopAll();
  });

  it("R7 retires the slot when new_session rejects and does not resolve a waiter with its killed client", async () => {
    const handles: DeferredResetHandle[] = [];
    const pool = new PiRuntimePool({
      maxAgents: 1,
      makeSupervisor: () => { const handle = new DeferredResetHandle(); handles.push(handle); return handle; },
    });
    const first = await pool.acquire("a");
    handles[0].ready();

    const releasing = pool.release("a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const concurrent = pool.acquire("b");
    await new Promise((resolve) => setTimeout(resolve, 0));
    handles[0].crash(1);
    await releasing;
    const second = await concurrent;

    expect(handles).toHaveLength(2);
    expect(second.client).not.toBe(first.client);
    expect(pool.get("a")).toBeUndefined();
    expect(pool.get("b")).toBe(second.client);
    expect(pool.activeCount()).toBe(1);
    expect(pool.snapshot()).toMatchObject({ active: 1, queued: 0, slots: [{ sessionId: "b" }] });
    await pool.stopAll();
  });

  it("reports the live session id through getSessionId", async () => {
    const handle = new FakeHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    const slot = await pool.acquire("a");
    handle.ready();

    expect(slot.getSessionId()).toBe("a");
    pool.renameSession("a", "b");
    expect(slot.getSessionId()).toBe("b");
    await pool.release("b");
    expect(slot.getSessionId()).toBeNull();
  });

  it("clears sessionId before sending new_session on release", async () => {
    const handle = new FakeHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    const slot = await pool.acquire("a");
    handle.ready();

    const idsWhenUnbinding: Array<string | null> = [];
    const post = handle.postMessage.bind(handle);
    handle.postMessage = (e: PiRuntimeEnvelope) => {
      if ("command" in e && (e as any).command?.type === "new_session") idsWhenUnbinding.push(slot.getSessionId());
      post(e);
    };

    await pool.release("a");
    expect(idsWhenUnbinding).toEqual([null]);
  });

  it("R7 rotates the binding lease when the same session id reacquires a reused client", async () => {
    const handle = new FakeHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    const first = await pool.acquire("same");
    handle.ready();
    const firstBinding = pool.getBinding("same");
    expect(firstBinding).toEqual({ client: first.client, lease: expect.any(Number) });

    await pool.release("same");
    expect(pool.getBinding("same")).toBeUndefined();
    const second = await pool.acquire("same");

    expect(second.client).toBe(first.client);
    expect(pool.getBinding("same")).toEqual({ client: second.client, lease: expect.any(Number) });
    expect(pool.getBinding("same")!.lease).not.toBe(firstBinding!.lease);
    await pool.stopAll();
  });

  it("stamps the next session on the same slot after release", async () => {
    const handle = new FakeHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    const first = await pool.acquire("a");
    handle.ready();
    await pool.release("a");
    const second = await pool.acquire("b");

    expect(second.client).toBe(first.client);
    expect(first.getSessionId()).toBe("b");
    expect(second.getSessionId()).toBe("b");
  });

  it("renames a session id while keeping the same client", async () => {
    const handle = new FakeHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    const { client } = await pool.acquire("temp");
    handle.ready();

    pool.renameSession("temp", "real");

    expect(pool.get("temp")).toBeUndefined();
    expect(pool.get("real")).toBe(client);
    expect(pool.activeCount()).toBe(1);

    await pool.release("real");
    expect(pool.get("real")).toBeUndefined();
    expect(pool.activeCount()).toBe(0);
    const sent = handle.sent.find((e) => "command" in e && (e as any).command?.type === "new_session");
    expect(sent).toBeTruthy();
  });

  it("renameSession is a no-op when the source id is unknown", async () => {
    const handle = new FakeHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    await pool.acquire("known");
    handle.ready();

    pool.renameSession("missing", "ghost");

    expect(pool.get("ghost")).toBeUndefined();
    expect(pool.get("known")).toBeTruthy();
    expect(pool.activeCount()).toBe(1);
  });

  it("broadcasts a command to every live runtime process", async () => {
    const handle = new FakeHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    await pool.acquire("a");
    handle.ready();

    await pool.broadcast({ type: "set_api_key", provider: "deepseek", apiKey: "sk-x" });

    const command = handle.sent.find(
      (e) => "command" in e && (e as { command: { type: string } }).command?.type === "set_api_key",
    );
    expect(command).toBeTruthy();
  });

  it("emits a snapshot after acquire, release and rename", async () => {
    const handle = new FakeHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    const snapshots: RuntimePoolSnapshot[] = [];
    pool.subscribe((s) => snapshots.push(s));

    await pool.acquire("a", { meta: { profileId: "general", profileName: "通用智能体", label: "会话#1" } });
    handle.ready();

    expect(pool.snapshot()).toMatchObject({ active: 1, queued: 0, maxAgents: 1 });
    expect(pool.snapshot().slots[0]).toMatchObject({
      sessionId: "a",
      profileId: "general",
      profileName: "通用智能体",
      label: "会话#1",
    });
    expect(snapshots.length).toBeGreaterThan(0);

    await pool.release("a");
    expect(pool.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

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
    expect(pool.snapshot().slots[0]).toMatchObject({
      profileId: "general",
      profileName: "通用智能体",
      label: "会话#2",
    });
  });

  it("reuses one process and sends the next session's skillsDir on configure_session", async () => {
    const handle = new FakeHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    await pool.acquire("a");
    handle.ready();

    await pool.release("a");
    const first = await pool.acquire("general-session", {
      saddle: { tools: ["read"], skillsDir: "/skills-a" },
    });
    await pool.release("general-session");
    const second = await pool.acquire("contract-session", {
      saddle: { tools: ["read"], skillsDir: "/skills-b" },
    });

    expect(second.client).toBe(first.client);
    const skillsDirs = handle.sent
      .filter((e) => "command" in e && (e as { command: { type: string } }).command.type === "configure_session")
      .map((e) => (e as { command: { saddle: { skillsDir?: string } } }).command.saddle.skillsDir);
    expect(skillsDirs).toEqual(["/skills-a", "/skills-b"]);
  });

  it("updateMeta patches a live slot label and emits a snapshot", async () => {
    const handle = new FakeHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    const snapshots: RuntimePoolSnapshot[] = [];
    pool.subscribe((s) => snapshots.push(s));

    await pool.acquire("a", { meta: { profileId: "contract-review", profileName: "合同审核智能体", label: "新会话" } });
    handle.ready();
    const before = snapshots.length;

    expect(pool.updateMeta("a", { label: "采购合同" })).toBe(true);
    expect(pool.snapshot().slots[0]).toMatchObject({
      profileId: "contract-review",
      profileName: "合同审核智能体",
      label: "采购合同",
    });
    expect(snapshots.length).toBeGreaterThan(before);
  });

  it("updateMeta patches a queued session without waking it", async () => {
    const handle = new FakeHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    await pool.acquire("a", { meta: { profileId: "general", profileName: "通用智能体", label: "会话#1" } });
    handle.ready();

    const pending = pool.acquire("b", {
      meta: { profileId: "contract-review", profileName: "合同审核智能体", label: "新会话" },
    });
    expect(pool.snapshot().queue[0]).toMatchObject({ label: "新会话" });

    expect(pool.updateMeta("b", { label: "采购合同" })).toBe(true);
    expect(pool.snapshot().queue[0]).toMatchObject({
      profileId: "contract-review",
      profileName: "合同审核智能体",
      label: "采购合同",
    });
    expect(pool.snapshot().slots[0].sessionId).toBe("a");

    await pool.release("a");
    await pending;
    expect(pool.snapshot().slots[0]).toMatchObject({ sessionId: "b", label: "采购合同" });
  });

  it("snapshot uses 新会话 when acquire has no label, not the session id", async () => {
    const handle = new FakeHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    await pool.acquire("01a06da9-ff37-7fe6-b320-2bda26cb3188");
    handle.ready();
    expect(pool.snapshot().slots[0]).toMatchObject({
      sessionId: "01a06da9-ff37-7fe6-b320-2bda26cb3188",
      label: "新会话",
    });
    expect(pool.snapshot().slots[0].label).not.toBe("01a06da9-ff37-7fe6-b320-2bda26cb3188");
  });

  it("updateMeta follows renameSession so a temp key can receive the real title", async () => {
    const handle = new FakeHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    await pool.acquire("new:temp", { meta: { profileId: "contract-review", profileName: "合同审核智能体", label: "新会话" } });
    handle.ready();
    pool.renameSession("new:temp", "wf-1");
    expect(pool.updateMeta("wf-1", { label: "采购合同" })).toBe(true);
    expect(pool.snapshot().slots[0]).toMatchObject({
      sessionId: "wf-1",
      profileName: "合同审核智能体",
      label: "采购合同",
    });
  });

  it("updateMeta is a no-op for an unknown session", async () => {
    const handle = new FakeHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    await pool.acquire("a", { meta: { profileId: "general", profileName: "通用智能体", label: "会话#1" } });
    handle.ready();
    const snapshots: RuntimePoolSnapshot[] = [];
    pool.subscribe((s) => snapshots.push(s));

    expect(pool.updateMeta("missing", { label: "采购合同" })).toBe(false);
    expect(pool.snapshot().slots[0].label).toBe("会话#1");
    expect(snapshots).toHaveLength(0);
  });

  it("hides internal probe slots and queue items from the snapshot", async () => {
    const handle = new FakeHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });

    await pool.acquire("user-session", { meta: { profileId: "general", profileName: "通用智能体", label: "会话#1" } });
    handle.ready();
    const probe = pool.acquire("probe:test", {
      meta: { profileId: "internal", profileName: "内部探测", label: "内部探测", internal: true },
    });

    await expect(probe).rejects.toThrow('NO_IDLE_SLOT');

    expect(pool.activeCount()).toBe(1);
    expect(pool.snapshot()).toMatchObject({ active: 1, queued: 0, slots: [{ sessionId: "user-session" }] });

    await pool.release("user-session");
    expect(pool.activeCount()).toBe(0);
    expect(pool.snapshot()).toMatchObject({ active: 0, queued: 0, slots: [] });
  });

  it("drops a crashed slot instead of handing it to the next acquire", async () => {
    const handles: FakeHandle[] = [];
    const pool = new PiRuntimePool({
      maxAgents: 1,
      makeSupervisor: () => {
        const h = new FakeHandle();
        handles.push(h);
        return h;
      },
    });
    const first = await pool.acquire("a");
    handles[0].ready();
    handles[0].crash(1);
    await pool.release("a");

    const second = pool.acquire("b");
    await new Promise((r) => setTimeout(r, 0));
    expect(handles).toHaveLength(2);
    handles[1].ready();
    const slot = await second;
    expect(slot.client).not.toBe(first.client);
    expect(slot.getSessionId()).toBe("b");
  });

  // m9（审核报告 §4 Minor）：acquire 入口查过 stopped 之后还有 `await start()` 这个让位点，
  // 期间 stopAll() 置 stopped ⇒ 原实现仍会新建槽位入池（关机中冒出一个活进程）。
  // 用例：不 await acquire，立刻 stopAll，再 await ⇒ 必须被拒绝且新建的句柄已被 kill。
  it("m9：await start() 期间池被 stopAll ⇒ acquire 复检 stopped、停掉新 supervisor 并拒绝", async () => {
    const handles: FakeHandle[] = [];
    const pool = new PiRuntimePool({
      maxAgents: 1,
      makeSupervisor: () => {
        const h = new FakeHandle();
        handles.push(h);
        return h;
      },
    });
    const pending = pool.acquire("late");
    // stopAll 的本体同步置 stopped（第一个 await 之前）⇒ acquire 的 await 之后必然看到。
    const stopping = pool.stopAll();
    await expect(pending).rejects.toThrow(/pool stopped/);
    await stopping;
    expect(handles).toHaveLength(1);
    expect(handles[0].killed, "复检发现已停时必须 kill 掉刚建好的运行时").toBe(true);
    expect(pool.snapshot().slots).toHaveLength(0);
    expect(pool.activeCount()).toBe(0);
  });

  it("stopAll waits for every cold-start supervisor and repeated calls share the same shutdown", async () => {
    class SlowExitHandle extends FakeHandle {
      kills = 0;
      private exits = new Set<(code: number | null) => void>();
      onExit(cb: (code: number | null) => void) { this.exits.add(cb); return () => { this.exits.delete(cb); }; }
      kill() { this.kills += 1; }
      emitExit(code: number) { for (const cb of [...this.exits]) cb(code); }
    }
    const handles: SlowExitHandle[] = [];
    const pool = new PiRuntimePool({
      maxAgents: 2,
      makeSupervisor: () => { const handle = new SlowExitHandle(); handles.push(handle); return handle; },
    });
    const first = pool.acquire("first");
    const second = pool.acquire("second");
    const firstOutcome = first.catch((error: unknown) => error);
    const secondOutcome = second.catch((error: unknown) => error);
    let resolved = false;
    const stopping = pool.stopAll().then(() => { resolved = true; });
    const repeated = pool.stopAll();

    await new Promise((resolve) => setTimeout(resolve, 20));
    const resolvedBeforeExit = resolved;
    const killsBeforeExit = handles.map((handle) => handle.kills);
    handles[0].emitExit(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const resolvedAfterFirstExit = resolved;
    handles[1].emitExit(0);
    await Promise.all([stopping, repeated, firstOutcome, secondOutcome]);

    expect(await firstOutcome).toMatchObject({ message: "pool stopped" });
    expect(await secondOutcome).toMatchObject({ message: "pool stopped" });
    expect(resolvedBeforeExit, "冷启动进程尚未 exit，stopAll 不得提前 resolve").toBe(false);
    expect(resolvedAfterFirstExit, "另一个冷启动进程尚未 exit，stopAll 仍不得 resolve").toBe(false);
    expect(killsBeforeExit).toEqual([1, 1]);
    expect(pool.snapshot()).toMatchObject({ active: 0, queued: 0, slots: [] });
    await expect(pool.acquire("after-stop")).rejects.toThrow(/pool stopped/);
  });

  it("releases cold-start capacity when supervisor creation fails", async () => {
    let attempts = 0;
    const handles: FakeHandle[] = [];
    const pool = new PiRuntimePool({
      maxAgents: 1,
      makeSupervisor: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("spawn failed");
        const handle = new FakeHandle();
        handles.push(handle);
        return handle;
      },
    });

    await expect(pool.acquire("failed")).rejects.toThrow("spawn failed");
    const retry = await pool.acquire("retry");
    expect(handles).toHaveLength(1);
    expect(retry.getSessionId()).toBe("retry");
    handles[0].ready();
    await pool.release("retry");
    await pool.stopAll();
  });

  it("R7 serializes a direct lifecycle command behind switch and retires before reuse", async () => {
    class RetireDuringSwitchHandle extends FakeHandle {
      switchRequests: PiRuntimeEnvelope[] = [];

      postMessage(e: PiRuntimeEnvelope) {
        this.sent.push(e);
        if (!("command" in e)) return;
        if (e.command.type === "switch_session") {
          this.switchRequests.push(e);
          return;
        }
        if (e.command.type === "new_session") {
          // Direct facade probe: a successful response without a newer generation
          // makes retirement synchronous in the pool's centralized send path.
          this.emit(responseEnvelope(e.id, {
            id: e.id, type: "response", command: "new_session", success: true,
          }));
          return;
        }
        this.emit(this.responseFor(e));
      }

      finishSwitch(): void {
        const request = this.switchRequests.shift();
        if (!request || !("command" in request)) throw new Error("no pending switch_session request");
        this.sessionGeneration += 1;
        this.emit(responseEnvelope(request.id, {
          id: request.id, type: "response", command: "switch_session", success: true,
          data: { sessionGeneration: this.sessionGeneration },
        }));
      }
    }

    const handles: RetireDuringSwitchHandle[] = [];
    const pool = new PiRuntimePool({
      maxAgents: 1,
      makeSupervisor: () => {
        const handle = new RetireDuringSwitchHandle();
        handles.push(handle);
        return handle;
      },
    });
    try {
      const acquiring = pool.acquire("a", { resumeSessionFile: "/tmp/a.jsonl" });
      handles[0].ready();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(handles[0].switchRequests).toHaveLength(1);
      const retiringClient = pool.get("a")!;

      // A direct lifecycle command must queue behind the opening switch instead of
      // retiring the child underneath it. Its invalid response retires the slot
      // before any subsequent acquire can reuse the stale client.
      let directSettled = false;
      const directOutcome = retiringClient.send({ type: "new_session" })
        .catch((error: unknown) => error)
        .finally(() => { directSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(directSettled).toBe(false);
      handles[0].finishSwitch();
      const bound = await acquiring;
      await expect(directOutcome).resolves.toMatchObject({ message: expect.stringMatching(/generation/i) });

      expect(bound.getSessionId()).toBeNull();
      expect(handles[0].killed).toBe(true);
      expect(pool.get("a")).toBeUndefined();
      expect(pool.activeCount()).toBe(0);
      expect(pool.snapshot().slots).toEqual([]);

      const healthy = pool.acquire("healthy");
      expect(handles).toHaveLength(2);
      handles[1].ready();
      const next = await healthy;
      expect(handles[1].killed).toBe(false);
      expect(next.client).not.toBe(retiringClient);
      expect(next.getSessionId()).toBe("healthy");
      expect(pool.get("healthy")).toBe(next.client);
    } finally {
      await pool.stopAll();
    }
  });

  it("stopAll during a queued bind rejects the request instead of returning a stopped slot", async () => {
    const handle = new FakeHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    await pool.acquire("a");
    handle.ready();
    await pool.release("a");
    let delayed: PiRuntimeEnvelope | undefined;
    handle.postMessage = (envelope: PiRuntimeEnvelope) => {
      handle.sent.push(envelope);
      if ("command" in envelope && envelope.command.type === "configure_session") delayed = envelope;
      else if ("command" in envelope) {
        handle.emit(responseEnvelope(envelope.id, {
          id: envelope.id, type: "response", command: envelope.command.type, success: true,
        }));
      }
    };

    const outcome = pool.acquire("b", { saddle: { tools: ["read"] } }).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(delayed).toBeDefined();
    const stopping = pool.stopAll();
    if (delayed) {
      handle.emit(responseEnvelope(delayed.id, {
        id: delayed.id, type: "response", command: "configure_session", success: true,
      }));
    }
    await stopping;

    expect(await outcome).toMatchObject({ message: "pool stopped" });
    expect(pool.activeCount()).toBe(0);
    expect(pool.snapshot().slots).toEqual([]);
  });

  it("continues queued binds after configure_session fails without rebinding the failed request", async () => {
    class FailFirstConfigureHandle extends FakeHandle {
      configureCalls = 0;
      postMessage(e: PiRuntimeEnvelope) {
        this.sent.push(e);
        if ("command" in e) {
          const command = (e as { command: { type: string } }).command;
          const success = command.type !== "configure_session" || ++this.configureCalls > 1;
          if (success && (command.type === "new_session" || command.type === "switch_session")) this.sessionGeneration += 1;
          this.emit(responseEnvelope(e.id, {
            id: e.id,
            type: "response",
            command: command.type as never,
            success,
            data: success && (command.type === "new_session" || command.type === "switch_session")
              ? { sessionGeneration: this.sessionGeneration }
              : undefined,
          }));
        }
      }
    }
    const handle = new FailFirstConfigureHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    await pool.acquire("a");
    handle.ready();
    const b = pool.acquire("b", { saddle: { tools: ["read"] } });
    const c = pool.acquire("c", { saddle: { tools: ["read"] } });
    const bOutcome = b.catch((error: unknown) => error);
    const cOutcome = c.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    await pool.release("a");
    const bError = await bOutcome;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const configureCalls = handle.sent.filter(
      (e): e is Extract<PiRuntimeEnvelope, { command: unknown }> =>
        "command" in e && (e as { command: { type: string } }).command.type === "configure_session",
    );
    const snapshot = pool.snapshot();
    await pool.stopAll();
    const result = await cOutcome;

    expect(bError).toMatchObject({ message: expect.stringMatching(/configure_session failed/) });
    expect(result.ok, "失败的 b 不得阻塞后面的 c").toBe(true);
    expect(configureCalls).toHaveLength(2);
    expect(snapshot).toMatchObject({ active: 1, queued: 0, slots: [{ sessionId: "c" }] });
    expect(pool.activeCount()).toBe(0);
  });

  it("stopAll rejects when a child never confirms process exit", async () => {
    class StuckHandle extends FakeHandle {
      kills = 0;
      kill() { this.kills += 1; }
    }
    vi.useFakeTimers();
    try {
      const handle = new StuckHandle();
      const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
      await pool.acquire("a");
      const rejection = expect(pool.stopAll()).rejects.toThrow(/shutdown did not confirm every process exit/);
      await vi.advanceTimersByTimeAsync(6_000);
      await rejection;
      expect(handle.kills).toBe(2);
      expect(pool.activeCount()).toBe(0);
      await expect(pool.stopAll()).rejects.toThrow(/shutdown did not confirm every process exit/);
    } finally {
      vi.useRealTimers();
    }
  });

  // M3：stopAll 必须等每个子进程真的退出（supervisor.stop 内部带超时兜底），
  // 而不是 kill 即返回 —— 否则关机序列会在句柄仍被占用时走到快照/退出。
  it("M3：stopAll 等到子进程 exit 才 resolve（kill 不自动退出时由超时兜底）", async () => {
    class SlowExitHandle extends FakeHandle {
      kills = 0;
      private exits = new Set<(code: number | null) => void>();
      onExit(cb: (code: number | null) => void) { this.exits.add(cb); return () => { this.exits.delete(cb); }; }
      kill() { this.kills += 1; }
      emitExit(code: number) { for (const cb of [...this.exits]) cb(code); }
    }
    const handle = new SlowExitHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    await pool.acquire("a");
    let resolved = false;
    const stopping = pool.stopAll().then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved, "子进程还没退出，stopAll 不得提前 resolve").toBe(false);
    handle.emitExit(0);
    await stopping;
    expect(handle.kills).toBe(1);
  });
});
