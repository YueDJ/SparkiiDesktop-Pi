import { describe, it, expect } from "vitest";
import { PiRuntimePool } from "../src/pi-runtime-pool.js";
import type { RuntimePoolSnapshot } from "../src/runtime-pool.js";
import { readyEnvelope, responseEnvelope, type PiRuntimeHostHandle, type PiRuntimeEnvelope } from "../src/pi-runtime-transport.js";

class FakeHandle implements PiRuntimeHostHandle {
  sent: PiRuntimeEnvelope[] = [];
  killed = false;
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
  kill() { this.killed = true; this.crash(0); }
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
