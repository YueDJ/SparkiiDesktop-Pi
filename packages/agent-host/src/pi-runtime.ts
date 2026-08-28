import { normalizeEvent } from "./rpc-client.js";
import type { PiProviderInfo, RpcCommand, RpcResponse, SessionSaddle } from "./types.js";
import {
  eventEnvelope,
  readyEnvelope,
  responseEnvelope,
  type PiRuntimeEnvelope,
} from "./pi-runtime-transport.js";

export interface PiRuntimeSession {
  prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  clearQueue(): Promise<unknown>;
  setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void>;
  setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setAutoRetry(enabled: boolean): Promise<void>;
  setAutoCompaction(enabled: boolean): Promise<void>;
  setSessionName(name: string): Promise<void>;
  setApiKey(provider: string, apiKey: string): Promise<void>;
  removeApiKey(provider: string): Promise<void>;
  complete(provider: string, modelId: string, text: string): Promise<string>;
  setThinkingLevel(level: string): void;
  getThinkingLevel(): string;
  getAvailableThinkingLevels(): string[];
  listModels(provider?: string): Promise<Array<{ provider: string; modelId: string }>>;
  listProviders(): Promise<PiProviderInfo[]>;
  subscribe(callback: (event: any) => void): () => void;
  onRuntimeError(callback: (error: { message: string; command?: string; stack?: string }) => void): () => void;
  getMessages(): unknown[];
  getSessionEntries(): unknown[];
  getState(): Record<string, unknown>;
  dispose(): void;
}

export interface PiRuntimeSessionHost {
  current(): PiRuntimeSession;
  newSession(): Promise<void>;
  switchSession(sessionPath: string): Promise<void>;
  configureSaddle(saddle: SessionSaddle | null): Promise<void>;
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
  let unsubscribeRuntimeError = opts.host.current().onRuntimeError((error) => {
    opts.transport.postMessage(eventEnvelope({
      type: "runtime_error",
      message: error.message,
      command: error.command,
      stack: error.stack,
    }));
  });

  const resubscribe = (): void => {
    unsubscribe();
    unsubscribeRuntimeError();
    unsubscribe = opts.host.current().subscribe((event) => {
      opts.transport.postMessage(eventEnvelope(normalizeEvent(event)));
    });
    unsubscribeRuntimeError = opts.host.current().onRuntimeError((error) => {
      opts.transport.postMessage(eventEnvelope({
        type: "runtime_error",
        message: error.message,
        command: error.command,
        stack: error.stack,
      }));
    });
  };

  const send = (id: string, command: RpcCommand, response: RpcResponse): void => {
    opts.transport.postMessage(responseEnvelope(id, response));
  };

  opts.transport.onMessage(async (envelope) => {
    if (!("command" in envelope)) return;
    const { id, command } = envelope;
    try {
      const data = await handleCommand(opts.host, command);
      if (command.type === "new_session" || command.type === "switch_session") {
        resubscribe();
      }
      send(id, command, { id, type: "response", command: command.type, success: true, data });
    } catch (error) {
      send(id, command, {
        id, type: "response", command: command.type, success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  opts.transport.postMessage(readyEnvelope());

  return () => {
    unsubscribe();
    unsubscribeRuntimeError();
    opts.host.current().dispose();
  };
}

async function handleCommand(host: PiRuntimeSessionHost, command: RpcCommand): Promise<unknown> {
  const session = host.current();
  switch (command.type) {
    case "prompt":
      await session.prompt(command.message, { streamingBehavior: command.streamingBehavior });
      return undefined;
    case "steer":
      await session.steer(command.message);
      return undefined;
    case "follow_up":
      await session.followUp(command.message);
      return undefined;
    case "clear_queue":
      return await session.clearQueue();
    case "set_steering_mode":
      await session.setSteeringMode(command.mode);
      return undefined;
    case "set_follow_up_mode":
      await session.setFollowUpMode(command.mode);
      return undefined;
    case "abort":
      await session.abort();
      return undefined;
    case "new_session":
      await host.newSession();
      return undefined;
    case "get_state":
      return session.getState();
    case "get_messages":
      return session.getMessages();
    case "get_session_entries":
      return session.getSessionEntries();
    case "set_model":
      await session.setModel(command.provider, command.modelId);
      return undefined;
    case "set_auto_retry":
      await session.setAutoRetry(command.enabled);
      return undefined;
    case "set_auto_compaction":
      await session.setAutoCompaction(command.enabled);
      return undefined;
    case "switch_session":
      await host.switchSession(command.sessionPath);
      return undefined;
    case "configure_session":
      await host.configureSaddle(command.saddle);
      return undefined;
    case "set_session_name":
      await session.setSessionName(command.name);
      return undefined;
    case "set_api_key":
      await session.setApiKey(command.provider, command.apiKey);
      return undefined;
    case "remove_api_key":
      await session.removeApiKey(command.provider);
      return undefined;
    case "complete":
      return await session.complete(command.provider, command.modelId, command.text);
    case "set_thinking_level":
      session.setThinkingLevel(command.level);
      return undefined;
    case "get_thinking_level":
      return session.getThinkingLevel();
    case "list_thinking_levels":
      return session.getAvailableThinkingLevels();
    case "list_models":
      return await session.listModels(command.provider);
    case "list_providers":
      return await session.listProviders();
  }
}
