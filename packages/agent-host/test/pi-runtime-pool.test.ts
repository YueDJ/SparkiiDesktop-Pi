import { describe, it, expect } from "vitest";
import { PiRuntimePool } from "../src/pi-runtime-pool.js";
import type { RuntimePoolSnapshot } from "../src/runtime-pool.js";
import { readyEnvelope, responseEnvelope, type PiRuntimeHostHandle, type PiRuntimeEnvelope } from "../src/pi-runtime-transport.js";

class FakeHandle implements PiRuntimeHostHandle {
  sent: PiRuntimeEnvelope[] = [];
  private messageCb?: (env: PiRuntimeEnvelope) => void;
  postMessage(e: PiRuntimeEnvelope) {
    this.sent.push(e);
    if ("command" in e) {
      this.emit(responseEnvelope(e.id, { id: e.id, type: "response", command: e.command.type, success: true }));
    }
  }
  onMessage(cb: (env: PiRuntimeEnvelope) => void) { this.messageCb = cb; return () => { this.messageCb = undefined; }; }
  onExit() { return () => {}; }
  emit(env: PiRuntimeEnvelope) { this.messageCb?.(env); }
  kill() {}
  ready() { this.emit(readyEnvelope()); }
}

describe("PiRuntimePool", () => {
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

  it("sends new_session on release", async () => {
    const handle = new FakeHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    await pool.acquire("a");
    handle.ready();
    await pool.release("a");
    const sent = handle.sent.find((e) => "command" in e && (e as any).command?.type === "new_session");
    expect(sent).toBeTruthy();
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
});
