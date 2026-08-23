import { normalizeEvent } from "./rpc-client.js";
import type { RpcCommand, RpcResponse } from "./types.js";
import {
  eventEnvelope,
  responseEnvelope,
  type PiRuntimeEnvelope,
} from "./pi-runtime-transport.js";

export interface PiRuntimeSession {
  prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setAutoRetry(enabled: boolean): Promise<void>;
  setAutoCompaction(enabled: boolean): Promise<void>;
  subscribe(callback: (event: any) => void): () => void;
  getMessages(): unknown[];
  getState(): Record<string, unknown>;
  dispose(): void;
}

export interface PiRuntimeSessionHost {
  current(): PiRuntimeSession;
  newSession(): Promise<void>;
  switchSession(sessionPath: string): Promise<void>;
}

export interface PiRuntimeChildTransport {
  postMessage(envelope: PiRuntimeEnvelope): void;
  onMessage(callback: (envelope: PiRuntimeEnvelope) => void): () => void;
}

export function createPiRuntime(opts: {
  host: PiRuntimeSessionHost;
  transport: PiRuntimeChildTransport;
}): () => void {
  let unsubscribe = opts.host.current().subscribe((event) => {
    opts.transport.postMessage(eventEnvelope(normalizeEvent(event)));
  });

  const resubscribe = (): void => {
    unsubscribe();
    unsubscribe = opts.host.current().subscribe((event) => {
      opts.transport.postMessage(eventEnvelope(normalizeEvent(event)));
    });
  };

  const send = (id: string, command: RpcCommand, response: RpcResponse): void => {
    opts.transport.postMessage(responseEnvelope(id, response));
  };

  opts.transport.onMessage(async (envelope) => {
    if (!("command" in envelope)) return;
    const { id, command } = envelope;
    try {
      await handleCommand(opts.host, command);
      if (command.type === "new_session" || command.type === "switch_session") {
        resubscribe();
      }
      send(id, command, { id, type: "response", command: command.type, success: true });
    } catch (error) {
      send(id, command, {
        id, type: "response", command: command.type, success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return () => {
    unsubscribe();
    opts.host.current().dispose();
  };
}

async function handleCommand(host: PiRuntimeSessionHost, command: RpcCommand): Promise<void> {
  const session = host.current();
  switch (command.type) {
    case "prompt":
      await session.prompt(command.message, { streamingBehavior: command.streamingBehavior });
      return;
    case "steer":
      await session.steer(command.message);
      return;
    case "follow_up":
      await session.followUp(command.message);
      return;
    case "abort":
      await session.abort();
      return;
    case "new_session":
      await host.newSession();
      return;
    case "get_state":
      return;
    case "get_messages":
      return;
    case "set_model":
      await session.setModel(command.provider, command.modelId);
      return;
    case "set_auto_retry":
      await session.setAutoRetry(command.enabled);
      return;
    case "set_auto_compaction":
      await session.setAutoCompaction(command.enabled);
      return;
    case "switch_session":
      await host.switchSession(command.sessionPath);
      return;
  }
}
