import { randomUUID } from "node:crypto";
import { PiRuntimeSupervisor } from "./pi-runtime-supervisor.js";
import type { PiRuntimeClient, PiRuntimeHostHandle } from "./pi-runtime-transport.js";
import type { RpcCommand, SessionSaddle } from "./types.js";
import type {
  RuntimeAcquireMeta,
  RuntimePoolSnapshot,
  RuntimeSessionStatus,
} from "./runtime-pool.js";

export interface PiRuntimeSlot {
  client: PiRuntimeClient;
  supervisor: PiRuntimeSupervisor;
  /** 这个进程此刻属于哪条会话；未绑定时为 null。读的是活牌子，不是 acquire 当时的拷贝。 */
  getSessionId(): string | null;
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

export interface AcquireOptions {
  resumeSessionFile?: string;
  saddle?: SessionSaddle;
  meta?: RuntimeAcquireMeta;
}

export class PiRuntimePool {
  private slots: Slot[] = [];
  private pending: Pending[] = [];
  private bySession = new Map<string, PiRuntimeClient>();
  private listeners = new Set<(snapshot: RuntimePoolSnapshot) => void>();

  constructor(private opts: { maxAgents: number; makeSupervisor: () => PiRuntimeHostHandle }) {}

  subscribe(listener: (snapshot: RuntimePoolSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): RuntimePoolSnapshot {
    return {
      maxAgents: this.opts.maxAgents,
      active: this.slots.filter((s) => s.sessionId !== null && !s.meta?.internal).length,
      queued: this.pending.filter((p) => !p.options.meta?.internal).length,
      slots: this.slots
        .filter((s) => s.sessionId !== null && !s.meta?.internal)
        .map((s) => ({
          slotId: s.id,
          sessionId: s.sessionId as string,
          profileId: s.meta?.profileId ?? "",
          profileName: s.meta?.profileName ?? s.meta?.profileId ?? "",
          label: s.meta?.label ?? (s.sessionId as string),
          status: s.status,
          startedAt: s.startedAt,
        })),
      queue: this.pending
        .filter((p) => !p.options.meta?.internal)
        .map((p, i) => ({
        queueId: p.id,
        profileId: p.options.meta?.profileId ?? "",
        profileName: p.options.meta?.profileName ?? p.options.meta?.profileId ?? "",
        label: p.options.meta?.label ?? p.sessionId,
        position: i + 1,
      })),
    };
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

  private emitSnapshot(): void {
    const next = this.snapshot();
    for (const listener of this.listeners) listener(next);
  }

  async acquire(sessionId: string, opts: AcquireOptions = {}): Promise<PiRuntimeSlot> {
    const free = this.slots.find((s) => s.sessionId === null);
    if (free) return this.bind(free, sessionId, opts);
    if (this.slots.length < this.opts.maxAgents) {
      const supervisor = new PiRuntimeSupervisor(this.opts.makeSupervisor);
      const client = await supervisor.start();
      const slot: Slot = {
        id: randomUUID(),
        supervisor,
        client,
        sessionId: null,
        status: "occupied-idle",
        startedAt: 0,
      };
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
    return { client: slot.client, supervisor: slot.supervisor, getSessionId: () => slot.sessionId };
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

  get(sessionId: string): PiRuntimeClient | undefined {
    return this.bySession.get(sessionId);
  }

  renameSession(from: string, to: string): void {
    const slot = this.slots.find((s) => s.sessionId === from);
    if (!slot) return;
    slot.sessionId = to;
    this.bySession.delete(from);
    this.bySession.set(to, slot.client);
    this.emitSnapshot();
  }

  async release(sessionId: string): Promise<void> {
    const slot = this.slots.find((s) => s.sessionId === sessionId);
    if (!slot) return;
    this.bySession.delete(sessionId);
    // 先卸牌子：new_session 期间到达的事件不能再盖上这条会话的 id。
    slot.sessionId = null;
    try { await slot.client.send({ type: "new_session" }); } catch { /* 子进程已退出则忽略 */ }
    slot.meta = undefined;
    slot.status = "occupied-idle";
    slot.startedAt = 0;
    const next = this.pending.shift();
    if (next) void this.bind(slot, next.sessionId, next.options).then(next.resolve, next.reject);
    this.emitSnapshot();
  }

  activeCount(): number {
    return this.bySession.size;
  }

  /** Send one command to every live runtime process; individual failures are ignored. */
  async broadcast(command: RpcCommand): Promise<void> {
    await Promise.all(
      this.slots.map((slot) => slot.client.send(command).catch(() => undefined)),
    );
  }

  async stopAll(): Promise<void> {
    for (const slot of this.slots) await slot.supervisor.stop();
    this.slots = [];
    this.bySession.clear();
    for (const p of this.pending) p.reject(new Error("pool stopped"));
    this.pending = [];
    this.emitSnapshot();
  }
}
