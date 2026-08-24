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
  private pending = new Map<string, {
    resolve: (r: RpcResponse) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private listeners = new Set<(event: NormalizedEvent) => void>();
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (e: Error) => void;

  constructor(
    private handle: PiRuntimeHostHandle,
    private onProposal: ProposalHandler,
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
    await Promise.race([
      this.readyPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`runtime not ready after ${this.readinessTimeoutMs}ms`)), this.readinessTimeoutMs)),
    ]);
    const id = randomUUID();
    return new Promise<RpcResponse>((resolve, reject) => {
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
    }
  }
}

export class PiRuntimeSupervisor {
  private client?: PiRuntimeClientImpl;
  private handle?: PiRuntimeHostHandle;
  private exitCbs = new Set<(code: number | null) => void>();
  private proposalCb: ProposalHandler = async () => ({
    approved: false,
    proposalId: "unhandled",
    status: "denied",
  });

  constructor(
    private makeHandle: () => PiRuntimeHostHandle,
    private opts: { sendTimeoutMs?: number; readinessTimeoutMs?: number } = {},
  ) {}

  async start(): Promise<PiRuntimeClient> {
    if (this.client) return this.client;
    const handle = this.makeHandle();
    this.handle = handle;
    this.client = new PiRuntimeClientImpl(
      handle,
      (request) => this.proposalCb(request),
      this.opts.sendTimeoutMs,
      this.opts.readinessTimeoutMs,
    );
    handle.onExit((code) => {
      this.client?.failPending(new Error(`runtime exited with code ${code}`));
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
