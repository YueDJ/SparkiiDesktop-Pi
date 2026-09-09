import type { RpcCommand, RpcResponse, NormalizedEvent } from "./types.js";
import type { ProposalRequest } from "@sparkii/approval";

export interface ProposalDecision {
  approved: boolean;
  proposalId: string;
  status: string;
  result?: unknown;
}

export type ConnectorReadRequest = {
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
};

export type ConnectorReadResult = {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
};

export type PiRuntimeEnvelope =
  | { direction: "main-to-runtime"; id: string; command: RpcCommand }
  | { direction: "runtime-to-main"; id: string; response: RpcResponse }
  | { direction: "runtime-to-main"; event: NormalizedEvent }
  | { direction: "runtime-to-main"; ready: true }
  | { direction: "runtime-to-main"; proposal: ProposalRequest & { requestId: string } }
  | { direction: "main-to-runtime"; requestId: string; proposalDecision: ProposalDecision }
  | { direction: "runtime-to-main"; connectorRead: ConnectorReadRequest }
  | { direction: "main-to-runtime"; requestId: string; connectorReadResult: ConnectorReadResult };

export function readyEnvelope(): PiRuntimeEnvelope {
  return { direction: "runtime-to-main", ready: true };
}

export interface PiRuntimeClient {
  send(command: RpcCommand): Promise<RpcResponse>;
  onEvent(callback: (event: NormalizedEvent) => void): () => void;
  close(): void;
}

export interface PiRuntimeHostHandle {
  postMessage(envelope: PiRuntimeEnvelope): void;
  onMessage(callback: (envelope: PiRuntimeEnvelope) => void): () => void;
  onExit(callback: (code: number | null) => void): () => void;
  kill(): void;
}

export function commandEnvelope(id: string, command: RpcCommand): PiRuntimeEnvelope {
  return { direction: "main-to-runtime", id, command };
}

export function responseEnvelope(id: string, response: RpcResponse): PiRuntimeEnvelope {
  return { direction: "runtime-to-main", id, response };
}

export function eventEnvelope(event: NormalizedEvent): PiRuntimeEnvelope {
  return { direction: "runtime-to-main", event };
}

export function proposalEnvelope(proposal: ProposalRequest & { requestId: string }): PiRuntimeEnvelope {
  return { direction: "runtime-to-main", proposal };
}

export function proposalDecisionEnvelope(
  requestId: string,
  proposalDecision: ProposalDecision,
): PiRuntimeEnvelope {
  return { direction: "main-to-runtime", requestId, proposalDecision };
}

export function connectorReadEnvelope(connectorRead: ConnectorReadRequest): PiRuntimeEnvelope {
  return { direction: "runtime-to-main", connectorRead };
}

export function connectorReadResultEnvelope(
  requestId: string,
  connectorReadResult: ConnectorReadResult,
): PiRuntimeEnvelope {
  return { direction: "main-to-runtime", requestId, connectorReadResult };
}
