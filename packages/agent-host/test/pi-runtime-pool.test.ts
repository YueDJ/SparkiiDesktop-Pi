import { describe, it, expect } from "vitest";
import { PiRuntimePool } from "../src/pi-runtime-pool.js";
import type { RuntimePoolSnapshot } from "../src/runtime-pool.js";
import { readyEnvelope, responseEnvelope, type PiRuntimeHostHandle, type PiRuntimeEnvelope } from "../src/pi-runtime-transport.js";

class FakeHandle implements PiRuntimeHostHandle {
  sent: PiRuntimeEnvelope[] = [];
  private messageCb?: (env: PiRuntimeEnvelope) => void;
  private exitCb?: (code: number | null) => void;
  postMessage(e: PiRuntimeEnvelope) {
    this.sent.push(e);
    if ("command" in e) {
      this.emit(responseEnvelope(e.id, { id: e.id, type: "response", command: e.command.type, success: true }));
    }
  }
  onMessage(cb: (env: PiRuntimeEnvelope) => void) { this.messageCb = cb; return () => { this.messageCb = undefined; }; }
  onExit(cb: (code: number | null) => void) { this.exitCb = cb; return () => { this.exitCb = undefined; }; }
  emit(env: PiRuntimeEnvelope) { this.messageCb?.(env); }
  crash(code: number | null = 1) { this.exitCb?.(code); }
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

    expect(pool.activeCount()).toBe(1);
    expect(pool.snapshot()).toMatchObject({ active: 1, queued: 0, slots: [{ sessionId: "user-session" }] });

    await pool.release("user-session");
    await probe;
    expect(pool.activeCount()).toBe(1);
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
});
