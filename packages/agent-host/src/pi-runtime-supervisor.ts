import { randomUUID } from "node:crypto";
import {
  commandEnvelope,
  proposalDecisionEnvelope,
  connectorReadResultEnvelope,
  type ConnectorReadRequest,
  type ConnectorReadResult,
  type PiRuntimeClient,
  type PiRuntimeEnvelope,
  type PiRuntimeHostHandle,
  type ProposalDecision,
} from "./pi-runtime-transport.js";
import type {
  ActionExecutionResult,
  RuntimeActionRequest,
} from "./runtime-actions.js";
import { actionResultEnvelope } from "./runtime-actions.js";
import type { ProposalRequest } from "@sparkii/approval";
import type { NormalizedEvent, RpcCommand, RpcResponse } from "./types.js";

type ProposalHandler = (
  request: ProposalRequest & { requestId: string },
) => Promise<ProposalDecision>;

type ConnectorReadHandler = (request: ConnectorReadRequest) => Promise<ConnectorReadResult>;
type ActionHandler = (request: RuntimeActionRequest) => Promise<ActionExecutionResult>;

const UNHANDLED_READ: ConnectorReadResult = {
  ok: false,
  error: { code: "CONNECTOR_DENIED", message: "unhandled" },
};

const UNHANDLED_ACTION = (request: RuntimeActionRequest): ActionExecutionResult => ({
  requestId: request.requestId,
  status: "denied",
  decision: {
    decision: "deny",
    ruleId: "platform.action-handler-unavailable",
    reason: "Main runtime action router is unavailable",
  },
});

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
  private closed: Error | null = null;

  constructor(
    private handle: PiRuntimeHostHandle,
    private onProposal: ProposalHandler,
    private onConnectorRead: ConnectorReadHandler,
    private onAction: ActionHandler,
    private sendTimeoutMs = 300_000,
    private readinessTimeoutMs = 60_000,
  ) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Suppress unhandled-rejection noise if the child exits before any send()
    // attaches a handler; send() still observes the rejection via Promise.race.
    this.readyPromise.catch(() => {});
    handle.onMessage((envelope) => void this.consume(envelope));
  }

  async send(command: RpcCommand): Promise<RpcResponse> {
    if (this.closed) throw this.closed;
    await Promise.race([
      this.readyPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`runtime not ready after ${this.readinessTimeoutMs}ms`)), this.readinessTimeoutMs)),
    ]);
    if (this.closed) throw this.closed;
    const id = randomUUID();
    return new Promise<RpcResponse>((resolve, reject) => {
      if (this.closed) {
        reject(this.closed);
        return;
      }
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
    this.closed = error;
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
      return;
    }
    if ("action" in envelope) {
      let result: ActionExecutionResult;
      try {
        result = await this.onAction(envelope.action);
      } catch (error) {
        result = {
          requestId: envelope.action.requestId,
          status: "failed",
          decision: {
            decision: "deny",
            ruleId: "platform.action-handler-failed",
            reason: error instanceof Error ? error.message : String(error),
          },
          error: {
            code: "ACTION_HANDLER_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
      this.handle.postMessage(actionResultEnvelope(
        envelope.action.requestId,
        result,
      ));
      return;
    }
    if ("connectorRead" in envelope) {
      try {
        const result = await this.onConnectorRead(envelope.connectorRead);
        this.handle.postMessage(connectorReadResultEnvelope(envelope.connectorRead.requestId, result));
      } catch {
        this.handle.postMessage(connectorReadResultEnvelope(envelope.connectorRead.requestId, UNHANDLED_READ));
      }
    }
  }
}

export interface PiRuntimeSupervisorOptions {
  sendTimeoutMs?: number;
  readinessTimeoutMs?: number;
  /**
   * stop() 等待子进程退出的上限（每个句柄）。
   * ⚠ 这与「主进程 3s 未退出则 app.exit(0)」是两件事：那个兜底作用于 app.quit()，
   * 这里等的是 pi 子进程的 exit 事件。pool.stopAll 会并行 stop 所有槽位，
   * 因此整池的等待上限也是这个值（不随槽位数线性增长）。
   */
  stopTimeoutMs?: number;
  logger?: { warn(message: string): void };
}

/**
 * stop() 的默认等待上限：关机序列要求「停进程」这一步在快照/退出前完成（设计 §7.7 步骤 3）。
 * 超时仍不退 ⇒ 再 kill 一次并记录，绝不让关机永久挂起。
 */
export const DEFAULT_STOP_TIMEOUT_MS = 3_000;

export class PiRuntimeSupervisor {
  private client?: PiRuntimeClientImpl;
  private handle?: PiRuntimeHostHandle;
  private exitCbs = new Set<(code: number | null) => void>();
  /** stop() 等待者：按句柄区分，旧句柄的迟到 exit 不会唤醒等待新句柄的人。 */
  private exitWaiters = new Map<PiRuntimeHostHandle, Set<() => void>>();
  private proposalCb: ProposalHandler = async () => ({
    approved: false,
    proposalId: "unhandled",
    status: "denied",
  });
  private connectorReadCb: ConnectorReadHandler = async () => UNHANDLED_READ;
  private actionCb: ActionHandler = async (request) => UNHANDLED_ACTION(request);

  constructor(
    private makeHandle: () => PiRuntimeHostHandle,
    private opts: PiRuntimeSupervisorOptions = {},
  ) {}

  async start(): Promise<PiRuntimeClient> {
    if (this.client) return this.client;
    const handle = this.makeHandle();
    this.handle = handle;
    this.client = new PiRuntimeClientImpl(
      handle,
      (request) => this.proposalCb(request),
      (request) => this.connectorReadCb(request),
      (request) => this.actionCb(request),
      this.opts.sendTimeoutMs,
      this.opts.readinessTimeoutMs,
    );
    handle.onExit((code) => {
      // 先唤醒 stop() 的等待者（按句柄匹配，见 waitForExit）。
      this.notifyExit(handle);
      // 句柄同一性守卫（防御性）：同一实例被 start→stop→start 复用时，旧句柄的迟到 exit
      // 绝不能清掉新句柄的 client/handle。当前池的接线不会走到这里（每槽 new、只 start 一次），
      // 这是公开 API 层面的加固，不是现网活体 bug。
      if (this.handle !== handle) return;
      this.client?.failPending(new Error(`runtime exited with code ${code}`));
      this.client = undefined;
      this.handle = undefined;
      for (const cb of this.exitCbs) cb(code);
    });
    return this.client;
  }

  /**
   * 停子进程并**等待它真的退出**（M3）。原先 kill 即返回，关机序列可能在子进程仍持有
   * 文件句柄 / 未 flush 的会话 JSONL 时就走到快照与 app.exit（违反 §7.7 步骤 3）。
   * 超时兜底：再 kill 一次并记录 —— 不无限等，也不静默放行。
   */
  async stop(): Promise<void> {
    const handle = this.handle;
    const client = this.client;
    // 先摘 client：即便下面等超时，也不会有人再通过本实例往旧句柄发命令。
    // handle 暂不清 —— 让正常的 exit 回调仍按「同一句柄」路径通知 onExit 订阅者（清理会话状态）；
    // 只有超时（exit 永不出现）或期间已被 start() 换成新句柄时，才在收尾处清掉。
    this.client = undefined;
    client?.close();
    if (!handle) {
      this.handle = undefined;
      return;
    }

    const timeoutMs = Number.isFinite(this.opts.stopTimeoutMs) && (this.opts.stopTimeoutMs ?? 0) > 0
      ? this.opts.stopTimeoutMs!
      : DEFAULT_STOP_TIMEOUT_MS;
    const exited = this.waitForExit(handle, timeoutMs);
    try {
      handle.kill();
    } catch (err) {
      this.opts.logger?.warn(`pi runtime kill failed: ${String(err)}`);
    }
    const timedOut = await exited;
    if (timedOut) {
      this.opts.logger?.warn(
        `pi runtime did not exit within ${timeoutMs}ms; forcing kill again (handles may still be held)`,
      );
      try {
        handle.kill();
      } catch { /* 已经死掉的句柄再 kill 失败无害 */ }
    }
    if (this.handle === handle) this.handle = undefined;
  }

  /** 等一次 exit；返回 true 表示超时（未退出）。等待者按句柄匹配，见 notifyExit。 */
  private waitForExit(handle: PiRuntimeHostHandle, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timeoutRef: { id?: ReturnType<typeof setTimeout> } = {};
      const finish = (timedOut: boolean): void => {
        if (settled) return;
        settled = true;
        if (timeoutRef.id) clearTimeout(timeoutRef.id);
        const set = this.exitWaiters.get(handle);
        if (set) {
          set.delete(onExit);
          if (set.size === 0) this.exitWaiters.delete(handle);
        }
        resolve(timedOut);
      };
      const onExit = (): void => finish(false);
      let set = this.exitWaiters.get(handle);
      if (!set) { set = new Set(); this.exitWaiters.set(handle, set); }
      set.add(onExit);
      timeoutRef.id = setTimeout(() => finish(true), timeoutMs);
      // 只等孩子，不阻止进程退出（关机路径上主进程可能已经在收尾）。
      (timeoutRef.id as { unref?: () => void }).unref?.();
    });
  }

  private notifyExit(handle: PiRuntimeHostHandle): void {
    const set = this.exitWaiters.get(handle);
    if (!set) return;
    this.exitWaiters.delete(handle);
    for (const waiter of [...set]) waiter();
  }

  onExit(cb: (code: number | null) => void): () => void {
    this.exitCbs.add(cb);
    return () => this.exitCbs.delete(cb);
  }

  onProposal(cb: ProposalHandler): void {
    this.proposalCb = cb;
  }

  onConnectorRead(cb: ConnectorReadHandler): void {
    this.connectorReadCb = cb;
  }

  onAction(cb: ActionHandler): void {
    this.actionCb = cb;
  }
}
