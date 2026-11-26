import type { RpcCommand, RpcResponse, NormalizedEvent } from "./types.js";
import type { ProposalRequest } from "@sparkii/approval";
import type { RuntimeOriginToken } from "./runtime-actions.js";
import type {
  ActionExecutionResult,
  RuntimeActionRequest,
} from "./runtime-actions.js";

export interface ProposalDecision {
  approved: boolean;
  proposalId: string;
  status: string;
  result?: unknown;
  /** How far the user meant the approval to reach. Absent means a single action. */
  approvalScope?: 'once' | 'task';
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
  | { direction: "runtime-to-main"; event: NormalizedEvent; sessionGeneration?: number }
  | { direction: "runtime-to-main"; ready: true }
  | { direction: "runtime-to-main"; proposal: ProposalRequest & { requestId: string }; sessionGeneration?: number; originToken?: RuntimeOriginToken }
  | { direction: "main-to-runtime"; requestId: string; proposalDecision: ProposalDecision; sessionGeneration?: number }
  | { direction: "runtime-to-main"; action: RuntimeActionRequest; sessionGeneration?: number; originToken?: RuntimeOriginToken }
  | { direction: "main-to-runtime"; requestId: string; actionResult: ActionExecutionResult; sessionGeneration?: number }
  | { direction: "runtime-to-main"; connectorRead: ConnectorReadRequest; sessionGeneration?: number; originToken?: RuntimeOriginToken }
  | { direction: "main-to-runtime"; requestId: string; connectorReadResult: ConnectorReadResult; sessionGeneration?: number };

export function readyEnvelope(): PiRuntimeEnvelope {
  return { direction: "runtime-to-main", ready: true };
}

export interface PiRuntimeEventContext {
  sessionGeneration: number;
}

export interface PiRuntimeRequestContext {
  client: PiRuntimeClient;
  sessionGeneration: number;
  originToken?: RuntimeOriginToken;
}

export interface PiRuntimeClient {
  readonly origin: string;
  sessionGeneration(): number;
  send(command: RpcCommand): Promise<RpcResponse>;
  onEvent(callback: (event: NormalizedEvent, context: PiRuntimeEventContext) => void): () => void;
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

export function eventEnvelope(event: NormalizedEvent, sessionGeneration = 0): PiRuntimeEnvelope {
  return { direction: "runtime-to-main", event, sessionGeneration };
}

export function proposalEnvelope(proposal: ProposalRequest & { requestId: string }, sessionGeneration = 0, originToken?: RuntimeOriginToken): PiRuntimeEnvelope {
  return { direction: "runtime-to-main", proposal, sessionGeneration, ...(originToken ? { originToken } : {}) };
}

export function proposalDecisionEnvelope(
  requestId: string,
  proposalDecision: ProposalDecision,
  sessionGeneration = 0,
): PiRuntimeEnvelope {
  return { direction: "main-to-runtime", requestId, proposalDecision, sessionGeneration };
}

export function connectorReadEnvelope(connectorRead: ConnectorReadRequest, sessionGeneration = 0, originToken?: RuntimeOriginToken): PiRuntimeEnvelope {
  return { direction: "runtime-to-main", connectorRead, sessionGeneration, ...(originToken ? { originToken } : {}) };
}

export function connectorReadResultEnvelope(
  requestId: string,
  connectorReadResult: ConnectorReadResult,
  sessionGeneration = 0,
): PiRuntimeEnvelope {
  return { direction: "main-to-runtime", requestId, connectorReadResult, sessionGeneration };
}
