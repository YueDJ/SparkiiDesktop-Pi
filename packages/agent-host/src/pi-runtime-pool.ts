/**
 * 复用既有 stopAll()，不新增 stop()；stopped 闸门用于升级关机时拒绝新会话（§0.7 P0-1）。
 * 关机协议（apps/desktop/electron/main/shutdown.ts）调用 stopAll() 后，acquire() 一律
 * 抛 'pool stopped'，避免升级退出过程中又重建 slot；stopAll() 本身保持幂等。
 */
import { randomUUID } from "node:crypto";
import { PiRuntimeSupervisor } from "./pi-runtime-supervisor.js";
import type { PiRuntimeClient, PiRuntimeEventContext, PiRuntimeHostHandle } from "./pi-runtime-transport.js";
import type { RpcCommand, RpcResponse, SessionSaddle } from "./types.js";
import type {
  RuntimeAcquireMeta,
  RuntimePoolSnapshot,
  RuntimeSessionStatus,
} from "./runtime-pool.js";

export interface PiRuntimeSlot {
  client: PiRuntimeClient;
  supervisor: PiRuntimeSupervisor;
  /** Immutable lease of this acquisition; a later same-id binding has a different value. */
  readonly lease: number;
  /** 这个进程此刻属于哪条会话；未绑定时为 null。读的是活牌子，不是 acquire 当时的拷贝。 */
  getSessionId(): string | null;
}

/** A lease changes on every binding, even when a reused slot keeps both client and session id. */
export interface PiRuntimeBinding {
  readonly client: PiRuntimeClient;
  readonly lease: number;
}

interface Slot {
  id: string;
  supervisor: PiRuntimeSupervisor;
  client: PiRuntimeClient;
  sessionId: string | null;
  sessionGeneration: number;
  lease: number;
  /** new_session 未确认前不可复用；sessionId 仍为 null，避免迟到事件归到旧会话。 */
  resetting?: boolean;
  /** Serializes every lifecycle command and bind/release critical section for this child. */
  lifecycleTail?: Promise<void>;
  meta?: RuntimeAcquireMeta;
  status: RuntimeSessionStatus;
  startedAt: number;
  offEvent?: () => void;
}

interface Pending {
  id: string;
  sessionId: string;
  options: AcquireOptions;
  control: AcquisitionControl;
  resolve: (slot: PiRuntimeSlot) => void;
  reject: (e: Error) => void;
}

interface AcquisitionControl {
  cancelled: boolean;
}

interface Acquisition {
  promise: Promise<PiRuntimeSlot>;
  control: AcquisitionControl;
}

class RuntimeSessionGenerationError extends Error {}

function changesSession(command: RpcCommand): boolean {
  return command.type === 'new_session' || command.type === 'switch_session';
}

function changesLifecycle(command: RpcCommand): boolean {
  return changesSession(command) || command.type === 'configure_session';
}

export interface AcquireOptions {
  resumeSessionFile?: string;
  saddle?: SessionSaddle;
  meta?: RuntimeAcquireMeta;
}

export class PiRuntimePool {
  /** 升级关机后置位：拒绝一切新 acquire()，不新增 stop() 方法。见文件头注释。 */
  private stopped = false;
  private slots: Slot[] = [];
  private pending: Pending[] = [];
  private starting = new Set<PiRuntimeSupervisor>();
  private supervisorStops = new WeakMap<PiRuntimeSupervisor, Promise<void>>();
  private slotRetirements = new WeakMap<Slot, Promise<void>>();
  private slotReleases = new WeakMap<Slot, Promise<void>>();
  private stopPromise?: Promise<void>;
  private readonly stoppedSignal: Promise<void>;
  private signalStopped!: () => void;
  private nextLease = 1;
  private bySession = new Map<string, PiRuntimeBinding>();
  private acquisitions = new Map<string, Acquisition>();
  private eventClients = new WeakMap<Slot, PiRuntimeClient>();
  private listeners = new Set<(snapshot: RuntimePoolSnapshot) => void>();

  constructor(private opts: { maxAgents: number; makeSupervisor: () => PiRuntimeHostHandle }) {
    this.stoppedSignal = new Promise((resolve) => { this.signalStopped = resolve; });
  }

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
          label: s.meta?.label ?? "新会话",
          status: s.status,
          startedAt: s.startedAt,
        })),
      queue: this.pending
        .filter((p) => !p.options.meta?.internal)
        .map((p, i) => ({
        queueId: p.id,
        profileId: p.options.meta?.profileId ?? "",
        profileName: p.options.meta?.profileName ?? p.options.meta?.profileId ?? "",
        label: p.options.meta?.label ?? "新会话",
        position: i + 1,
      })),
    };
  }

  setMaxAgents(maxAgents: number): void {
    this.opts.maxAgents = Math.max(1, Math.floor(maxAgents));
    this.emitSnapshot();
    void this.servePending();
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

  /**
   * 内部轻量任务（记忆提炼/整合）的礼让入口：没有空闲槽就当场返回 null，
   * 绝不排到交互会话前面。判断与 acquire 的首次检查在同一个同步段里完成，无让位点。
   */
  async acquireIfIdle(sessionId: string, opts: AcquireOptions = {}): Promise<PiRuntimeSlot | null> {
    if (this.stopped) return null;
    const free = this.slots.some((s) => this.isAvailable(s));
    if (!free && this.slots.length + this.starting.size >= this.opts.maxAgents) return null;
    try {
      return await this.acquire(sessionId, opts);
    } catch (error) {
      if (error instanceof Error && error.message === 'NO_IDLE_SLOT') return null;
      throw error;
    }
  }

  async acquire(sessionId: string, opts: AcquireOptions = {}): Promise<PiRuntimeSlot> {
    if (this.stopped) throw new Error('pool stopped');
    const existing = this.acquisitions.get(sessionId);
    if (existing) return existing.promise;
    const control: AcquisitionControl = { cancelled: false };
    const promise = this.acquireOwned(sessionId, opts, control).then(
      (slot) => {
        if (this.acquisitions.get(sessionId)?.promise === promise) this.acquisitions.delete(sessionId);
        return slot;
      },
      (error: unknown) => {
        if (this.acquisitions.get(sessionId)?.promise === promise) this.acquisitions.delete(sessionId);
        throw error;
      },
    );
    this.acquisitions.set(sessionId, { promise, control });
    return promise;
  }

  cancelAcquire(sessionId: string): boolean {
    const acquisition = this.acquisitions.get(sessionId);
    if (!acquisition) return false;
    acquisition.control.cancelled = true;
    let changed = false;
    this.pending = this.pending.filter((pending) => {
      if (pending.sessionId !== sessionId) return true;
      pending.reject(new Error('RUNTIME_ACQUIRE_CANCELLED'));
      changed = true;
      return false;
    });
    if (changed) this.emitSnapshot();
    return true;
  }

  /** Capture and await the current acquisition, including an in-flight bind/retirement. */
  async waitForAcquire(sessionId: string): Promise<void> {
    const acquisition = this.acquisitions.get(sessionId);
    if (!acquisition) return;
    await acquisition.promise.catch(() => undefined);
  }

  private async acquireOwned(sessionId: string, opts: AcquireOptions, control: AcquisitionControl): Promise<PiRuntimeSlot> {
    if (control.cancelled) throw new Error('RUNTIME_ACQUIRE_CANCELLED');
    if (this.bySession.has(sessionId)) throw new Error(`session ${sessionId} is already bound`);
    const free = this.slots.find((s) => this.isAvailable(s));
    if (free) return this.bind(free, sessionId, opts, control);
    if (this.slots.length + this.starting.size < this.opts.maxAgents) {
      return this.acquireCold(sessionId, opts, control);
    }
    if (opts.meta?.internal) throw new Error('NO_IDLE_SLOT');
    return new Promise<PiRuntimeSlot>((resolve, reject) => {
      this.pending.push({ id: randomUUID(), sessionId, options: opts, control, resolve, reject });
      this.emitSnapshot();
    });
  }

  private isAvailable(slot: Slot): boolean {
    return slot.sessionId === null && !slot.resetting;
  }

  private async whileRunning<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([
      operation,
      this.stoppedSignal.then(() => { throw new Error('pool stopped'); }),
    ]);
  }

  /** One child, one ordered lifecycle lane; the tail itself never rejects. */
  private async enqueueLifecycle<T>(slot: Slot, operation: () => Promise<T>): Promise<T> {
    const previous = slot.lifecycleTail ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    slot.lifecycleTail = tail;
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (slot.lifecycleTail === tail) slot.lifecycleTail = undefined;
    }
  }

  private acceptsEvent(slot: Slot, context: PiRuntimeEventContext): boolean {
    const binding = slot.sessionId === null ? undefined : this.bySession.get(slot.sessionId);
    return !slot.resetting
      && binding?.client === this.clientFor(slot)
      && binding.lease === slot.lease
      && context.sessionGeneration === slot.sessionGeneration;
  }

  private updateSessionGeneration(slot: Slot, response: { success: boolean; data?: unknown }): void {
    if (!response.success) return;
    const data = response.data;
    const generation = data !== null && typeof data === 'object' && !Array.isArray(data)
      ? (data as { sessionGeneration?: unknown }).sessionGeneration
      : undefined;
    if (!Number.isSafeInteger(generation) || (generation as number) <= slot.sessionGeneration) {
      throw new RuntimeSessionGenerationError('runtime session generation must be a strictly increasing safe integer');
    }
    slot.sessionGeneration = generation as number;
  }

  /**
   * The only send path exposed by a slot facade. A session-changing command whose
   * outcome cannot be confirmed makes the whole process uncertain, regardless of
   * whether the caller is bind(), release(), or application code.
   */
  private async send(slot: Slot, command: RpcCommand): Promise<RpcResponse> {
    if (changesLifecycle(command)) {
      return this.enqueueLifecycle(slot, () => this.sendNow(slot, command));
    }
    return this.sendNow(slot, command);
  }

  /** Internal send for callers already executing inside the lifecycle lane. */
  private async sendNow(slot: Slot, command: RpcCommand): Promise<RpcResponse> {
    let response: RpcResponse;
    try {
      response = await slot.client.send(command);
    } catch (error) {
      if (changesSession(command)) {
        // Preserve the send/validation error even if process retirement also fails.
        await this.retireSlot(slot).catch(() => undefined);
      }
      throw error;
    }
    if (changesSession(command) && response.success) {
      try {
        this.updateSessionGeneration(slot, response);
      } catch (error) {
        await this.retireSlot(slot).catch(() => undefined);
        throw error;
      }
    }
    return response;
  }

  private clientFor(slot: Slot): PiRuntimeClient {
    const existing = this.eventClients.get(slot);
    if (existing) return existing;
    const client: PiRuntimeClient = {
      origin: slot.client.origin,
      sessionGeneration: () => slot.sessionGeneration,
      send: async (command) => this.send(slot, command),
      onEvent: (callback) => slot.client.onEvent((event, context) => {
        if (!this.acceptsEvent(slot, context)) return;
        callback(event, context);
      }),
      close: () => slot.client.close(),
    };
    this.eventClients.set(slot, client);
    return client;
  }

  private async acquireCold(sessionId: string, opts: AcquireOptions, control: AcquisitionControl): Promise<PiRuntimeSlot> {
    const supervisor = new PiRuntimeSupervisor(this.opts.makeSupervisor);
    this.starting.add(supervisor);
    let client: PiRuntimeClient;
    try {
      client = await this.whileRunning(supervisor.start());
    } catch (error) {
      this.starting.delete(supervisor);
      await this.stopSupervisor(supervisor).catch(() => undefined);
      throw error;
    }
    this.starting.delete(supervisor);
    // m9：await 是让位点 —— stopAll() 可能在这期间置 stopped。必须在注册事件 / 入池之前
    // 复检，否则关机过程中会新建一个永远停在池外的活进程（违反 §0.7 P0-1 的闸门）。
    if (this.stopped || control.cancelled) {
      await this.stopSupervisor(supervisor);
      throw new Error(control.cancelled ? 'RUNTIME_ACQUIRE_CANCELLED' : 'pool stopped');
    }
    const slot: Slot = {
      id: randomUUID(),
      supervisor,
      client,
      sessionId: null,
      sessionGeneration: 0,
      lease: 0,
      status: "occupied-idle",
      startedAt: 0,
    };
    slot.offEvent = client.onEvent((event, context) => {
      if (!this.acceptsEvent(slot, context)) return;
      this.applyEvent(slot, event);
    });
    this.slots.push(slot);
    return this.bind(slot, sessionId, opts, control);
  }

  private stopSupervisor(supervisor: PiRuntimeSupervisor): Promise<void> {
    let stopping = this.supervisorStops.get(supervisor);
    if (!stopping) {
      stopping = supervisor.stop();
      this.supervisorStops.set(supervisor, stopping);
    }
    return stopping;
  }

  private retireSlot(slot: Slot): Promise<void> {
    const existing = this.slotRetirements.get(slot);
    if (existing) return existing;

    // Detach synchronously: callers must observe an unavailable slot as soon as
    // their send rejects, and no late release/rename may restore an alias to it.
    this.slots = this.slots.filter((s) => s !== slot);
    const client = this.clientFor(slot);
    for (const [id, mapped] of this.bySession) {
      if (mapped.client === client) this.bySession.delete(id);
    }
    slot.sessionId = null;
    slot.resetting = false;
    slot.meta = undefined;
    slot.status = "occupied-idle";
    slot.startedAt = 0;
    slot.offEvent?.();
    slot.offEvent = undefined;
    this.emitSnapshot();

    const retirement = this.stopSupervisor(slot.supervisor).finally(() => {
      void this.servePending();
      this.emitSnapshot();
    });
    this.slotRetirements.set(slot, retirement);
    return retirement;
  }

  private ownsBinding(slot: Slot, sessionId: string, lease: number): boolean {
    return this.slots.includes(slot)
      && !this.slotRetirements.has(slot)
      && slot.sessionId === sessionId
      && slot.lease === lease
      && this.bySession.get(sessionId)?.lease === lease;
  }

  private async bind(slot: Slot, sessionId: string, opts: AcquireOptions, control?: AcquisitionControl): Promise<PiRuntimeSlot> {
    if (control?.cancelled) throw new Error('RUNTIME_ACQUIRE_CANCELLED');
    slot.sessionId = sessionId;
    slot.resetting = true;
    slot.meta = opts.meta;
    slot.status = "starting";
    slot.startedAt = Date.now();
    const client = this.clientFor(slot);
    const lease = ++this.nextLease;
    slot.lease = lease;
    this.bySession.set(sessionId, { client, lease });
    this.emitSnapshot();
    return this.enqueueLifecycle(slot, async () => {
      try {
        if (control?.cancelled) throw new Error('RUNTIME_ACQUIRE_CANCELLED');
        if (opts.saddle) {
          const r = await this.whileRunning(this.sendNow(slot, { type: "configure_session", saddle: opts.saddle }));
          if (control?.cancelled) throw new Error('RUNTIME_ACQUIRE_CANCELLED');
          if (!r.success) throw new Error(`configure_session failed: ${r.error ?? "unknown"}`);
        }
        if (opts.resumeSessionFile) {
          const r = await this.whileRunning(this.sendNow(slot, { type: "switch_session", sessionPath: opts.resumeSessionFile }));
          if (control?.cancelled) throw new Error('RUNTIME_ACQUIRE_CANCELLED');
          if (!r.success) throw new Error(`switch_session failed: ${r.error ?? "unknown"}`);
        }
        if (this.stopped) throw new Error("pool stopped");
        // configure_session/switch_session yielded to other work. Recheck without
        // another await so a successful bind cannot hand out a stale facade.
        if (!this.ownsBinding(slot, sessionId, lease)) {
          throw new Error(`session ${sessionId} is no longer bound`);
        }
      } catch (e) {
        if (this.stopped) throw e;
        // Once cancellation/ownership uncertainty is observed, alias cleanup is not
        // proof that the child is safe. Retire it and confirm exit before deletion.
        if (control?.cancelled || !this.ownsBinding(slot, sessionId, lease)) {
          if (!this.slotRetirements.has(slot)) await this.retireSlot(slot).catch(() => undefined);
          throw e;
        }
        // A still-owned ordinary configuration failure did not lose ownership.
        this.bySession.delete(sessionId);
        slot.sessionId = null;
        slot.resetting = false;
        slot.meta = undefined;
        slot.status = "occupied-idle";
        slot.startedAt = 0;
        this.emitSnapshot();
        throw e;
      }
      slot.resetting = false;
      slot.status = "occupied-idle";
      this.emitSnapshot();
      return { client, supervisor: slot.supervisor, lease, getSessionId: () => slot.sessionId };
    });
  }

  private applyEvent(slot: Slot, event: { type: string }): void {
    const next: RuntimeSessionStatus =
      event.type === "agent_start" || event.type === "turn_start" || event.type === "compaction_start"
        ? "streaming"
        : event.type === "agent_end" || event.type === "agent_settled" || event.type === "turn_end" || event.type === "runtime_error" || event.type === "prompt_error" || event.type === "compaction_end"
          ? "occupied-idle"
          : slot.status;
    if (slot.sessionId !== null && next !== slot.status) {
      slot.status = next;
      this.emitSnapshot();
    }
  }

  get(sessionId: string): PiRuntimeClient | undefined {
    return this.getBinding(sessionId)?.client;
  }

  /** Capture this tuple before subscribing; client identity alone survives release/reacquire. */
  getBinding(sessionId: string): PiRuntimeBinding | undefined {
    const binding = this.bySession.get(sessionId);
    return binding ? { client: binding.client, lease: binding.lease } : undefined;
  }

  renameSession(from: string, to: string): void {
    const slot = this.slots.find((s) => s.sessionId === from);
    if (!slot) return;
    const binding = this.getBinding(from);
    if (!binding) return;
    const occupied = this.bySession.get(to);
    if (occupied && occupied.lease !== binding.lease) throw new Error(`session ${to} is already bound`);
    slot.sessionId = to;
    this.bySession.delete(from);
    this.bySession.set(to, binding);
    this.emitSnapshot();
  }

  updateMeta(sessionId: string, patch: Partial<RuntimeAcquireMeta>): boolean {
    const slot = this.slots.find((s) => s.sessionId === sessionId);
    if (slot) {
      slot.meta = {
        ...slot.meta,
        ...patch,
        profileId: patch.profileId ?? slot.meta?.profileId ?? "",
      };
      this.emitSnapshot();
      return true;
    }
    const pending = this.pending.find((p) => p.sessionId === sessionId);
    if (!pending) return false;
    pending.options.meta = {
      ...pending.options.meta,
      ...patch,
      profileId: patch.profileId ?? pending.options.meta?.profileId ?? "",
    };
    this.emitSnapshot();
    return true;
  }

  private async servePending(): Promise<void> {
    while (!this.stopped && this.pending.length > 0) {
      const free = this.slots.find((s) => this.isAvailable(s));
      if (free) {
        const next = this.pending.shift()!;
        try {
          next.resolve(await this.bind(free, next.sessionId, next.options, next.control));
        } catch (error) {
          next.reject(error instanceof Error ? error : new Error(String(error)));
        }
        continue;
      }
      if (this.slots.length + this.starting.size >= this.opts.maxAgents) return;
      const next = this.pending.shift()!;
      try {
        next.resolve(await this.acquireCold(next.sessionId, next.options, next.control));
      } catch (error) {
        next.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  async release(sessionId: string, expectedLease?: number): Promise<void> {
    const slot = this.slots.find((s) => s.sessionId === sessionId);
    if (!slot) return;
    if (expectedLease !== undefined && !this.ownsBinding(slot, sessionId, expectedLease)) return;
    const existing = this.slotReleases.get(slot);
    if (existing) return existing;
    const lease = expectedLease ?? slot.lease;
    const releasing = this.enqueueLifecycle(slot, async () => {
      // An opening bind owns this lane until it either succeeds or retires. Do
      // not detach its alias early and let new_session overtake switch_session.
      if (!this.ownsBinding(slot, sessionId, lease)) return;
      this.bySession.delete(sessionId);
      // 先卸牌子：new_session 期间到达的事件不能再盖上这条会话的 id。
      // 但 resetting 闸门保持槽位不可用，直到重置结果确认，避免并发 acquire 绑到旧进程。
      slot.sessionId = null;
      slot.resetting = true;
      slot.meta = undefined;
      slot.status = "occupied-idle";
      slot.startedAt = 0;
      this.emitSnapshot();
      let dead = false;
      try {
        const response = await this.whileRunning(this.sendNow(slot, { type: "new_session" }));
        // 子进程活着但会话没能重置（例如换鞍后再也装不上工具）：这个槽位不能带回池复用，
        // 否则下一次 acquire 会绑到一个"清理失败"的会话上。
        if (!response.success) dead = true;
      } catch {
        // 子进程已退出：不能把死槽放回空闲列表，否则下次 acquire 会一直绑到它上面失败。
        dead = true;
      }
      if (dead) {
        await this.retireSlot(slot);
        return;
      }
      slot.resetting = false;
      void this.servePending();
      this.emitSnapshot();
    });
    this.slotReleases.set(slot, releasing);
    releasing.then(
      () => { if (this.slotReleases.get(slot) === releasing) this.slotReleases.delete(slot); },
      () => { if (this.slotReleases.get(slot) === releasing) this.slotReleases.delete(slot); },
    );
    return releasing;
  }

  activeCount(): number {
    return this.bySession.size;
  }

  /** Send one command to every live runtime process; individual failures are ignored. */
  async broadcast(command: RpcCommand): Promise<void> {
    if (changesSession(command)) {
      throw new Error('session-changing commands cannot be broadcast');
    }
    await Promise.all(
      this.slots.map((slot) => slot.client.send(command).catch(() => undefined)),
    );
  }

  stopAll(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    // 先置闸门再停进程；冷启动 supervisor 也必须纳入，且重复调用共享同一次关机。
    this.stopped = true;
    this.signalStopped();
    // 并行停：每个 supervisor.stop() 自带退出等待超时（M3），串行会让整池上限随槽位数增长。
    const stops = [
      ...this.slots.map((slot) => slot.supervisor),
      ...this.starting,
    ].map((supervisor) => this.stopSupervisor(supervisor));
    this.stopPromise = Promise.allSettled(stops).then((results) => {
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) {
        throw new AggregateError(failures.map((result) => result.reason), 'runtime pool shutdown did not confirm every process exit');
      }
    });
    this.slots = [];
    this.bySession.clear();
    for (const p of this.pending) p.reject(new Error("pool stopped"));
    this.pending = [];
    this.emitSnapshot();
    return this.stopPromise;
  }
}
