import { PiRuntimeSupervisor } from "./pi-runtime-supervisor.js";
import type { PiRuntimeClient, PiRuntimeHostHandle } from "./pi-runtime-transport.js";

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

export class PiRuntimePool {
  private slots: Slot[] = [];
  private pending: Pending[] = [];
  private bySession = new Map<string, PiRuntimeClient>();

  constructor(private opts: { maxAgents: number; makeSupervisor: () => PiRuntimeHostHandle }) {}

  async acquire(sessionId: string): Promise<PiRuntimeSlot> {
    const free = this.slots.find((s) => s.sessionId === null);
    if (free) return this.bind(free, sessionId);
    if (this.slots.length < this.opts.maxAgents) {
      const supervisor = new PiRuntimeSupervisor(this.opts.makeSupervisor);
      const client = await supervisor.start();
      const slot: Slot = { supervisor, client, sessionId: null };
      this.slots.push(slot);
      return this.bind(slot, sessionId);
    }
    return new Promise<PiRuntimeSlot>((resolve, reject) => {
      this.pending.push({ sessionId, resolve, reject });
    });
  }

  private bind(slot: Slot, sessionId: string): PiRuntimeSlot {
    slot.sessionId = sessionId;
    this.bySession.set(sessionId, slot.client);
    return { client: slot.client, supervisor: slot.supervisor };
  }

  get(sessionId: string): PiRuntimeClient | undefined {
    return this.bySession.get(sessionId);
  }

  async release(sessionId: string): Promise<void> {
    const slot = this.slots.find((s) => s.sessionId === sessionId);
    if (!slot) return;
    this.bySession.delete(sessionId);
    try { await slot.client.send({ type: "new_session" }); } catch { /* 子进程已退出则忽略 */ }
    slot.sessionId = null;
    const next = this.pending.shift();
    if (next) next.resolve(this.bind(slot, next.sessionId));
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
