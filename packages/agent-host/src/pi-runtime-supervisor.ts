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
  private pending = new Map<string, (response: RpcResponse) => void>();
  private listeners = new Set<(event: NormalizedEvent) => void>();

  constructor(
    private handle: PiRuntimeHostHandle,
    private onProposal: ProposalHandler,
  ) {
    handle.onMessage((envelope) => void this.consume(envelope));
  }

  send(command: RpcCommand): Promise<RpcResponse> {
    const id = randomUUID();
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.handle.postMessage(commandEnvelope(id, command));
    });
  }

  onEvent(callback: (event: NormalizedEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  close(): void {
    this.pending.clear();
    this.listeners.clear();
  }

  private async consume(envelope: PiRuntimeEnvelope): Promise<void> {
    if ("response" in envelope) {
      const resolver = this.pending.get(envelope.response.id ?? envelope.id);
      if (resolver) {
        this.pending.delete(envelope.response.id ?? envelope.id);
        resolver(envelope.response);
      }
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
  private client?: PiRuntimeClient;
  private handle?: PiRuntimeHostHandle;
  private exitCbs = new Set<(code: number | null) => void>();
  private proposalCb: ProposalHandler = async () => ({
    approved: false,
    proposalId: "unhandled",
    status: "denied",
  });

  constructor(private makeHandle: () => PiRuntimeHostHandle) {}

  async start(): Promise<PiRuntimeClient> {
    if (this.client) return this.client;
    const handle = this.makeHandle();
    this.handle = handle;
    this.client = new PiRuntimeClientImpl(handle, (request) => this.proposalCb(request));
    handle.onExit((code) => {
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
