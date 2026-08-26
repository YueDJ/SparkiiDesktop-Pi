import { PiRuntimeSupervisor } from "./pi-runtime-supervisor.js";
import type { PiRuntimeClient, PiRuntimeHostHandle } from "./pi-runtime-transport.js";
import type { SessionSaddle } from "./types.js";

export interface PiRuntimeSlot {
  client: PiRuntimeClient;
  supervisor: PiRuntimeSupervisor;
}

interface Slot {
  supervisor: PiRuntimeSupervisor;
  client: PiRuntimeClient;
  sessionId: string | null;
}

interface Pending {
  sessionId: string;
  resolve: (slot: PiRuntimeSlot) => void;
  reject: (e: Error) => void;
}

export interface AcquireOptions {
  resumeSessionFile?: string;
  saddle?: SessionSaddle;
}

export class PiRuntimePool {
  private slots: Slot[] = [];
  private pending: Pending[] = [];
  private bySession = new Map<string, PiRuntimeClient>();

  constructor(private opts: { maxAgents: number; makeSupervisor: () => PiRuntimeHostHandle }) {}

  async acquire(sessionId: string, opts: AcquireOptions = {}): Promise<PiRuntimeSlot> {
    const free = this.slots.find((s) => s.sessionId === null);
    if (free) return this.bind(free, sessionId, opts);
    if (this.slots.length < this.opts.maxAgents) {
      const supervisor = new PiRuntimeSupervisor(this.opts.makeSupervisor);
      const client = await supervisor.start();
      const slot: Slot = { supervisor, client, sessionId: null };
      this.slots.push(slot);
      return this.bind(slot, sessionId, opts);
    }
    return new Promise<PiRuntimeSlot>((resolve, reject) => {
      this.pending.push({ sessionId, resolve, reject });
    });
  }

  private async bind(slot: Slot, sessionId: string, opts: AcquireOptions): Promise<PiRuntimeSlot> {
    slot.sessionId = sessionId;
    this.bySession.set(sessionId, slot.client);
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
      throw e;
    }
    return { client: slot.client, supervisor: slot.supervisor };
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
  }

  async release(sessionId: string): Promise<void> {
    const slot = this.slots.find((s) => s.sessionId === sessionId);
    if (!slot) return;
    this.bySession.delete(sessionId);
    try { await slot.client.send({ type: "new_session" }); } catch { /* 子进程已退出则忽略 */ }
    slot.sessionId = null;
    const next = this.pending.shift();
    if (next) void this.bind(slot, next.sessionId, {}).then(next.resolve, next.reject);
  }

  activeCount(): number {
    return this.bySession.size;
  }

  async stopAll(): Promise<void> {
    for (const slot of this.slots) await slot.supervisor.stop();
    this.slots = [];
    this.bySession.clear();
    for (const p of this.pending) p.reject(new Error("pool stopped"));
    this.pending = [];
  }
}
