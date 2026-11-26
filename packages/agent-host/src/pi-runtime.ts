import { normalizeEvent } from "./rpc-client.js";
import type { ImageContent, NormalizedEvent, PiProviderInfo, RpcCommand, RpcResponse, SessionSaddle } from "./types.js";
import {
  eventEnvelope,
  readyEnvelope,
  responseEnvelope,
  type PiRuntimeEnvelope,
} from "./pi-runtime-transport.js";

export interface PiRuntimePromptOptions {
  streamingBehavior?: "steer" | "followUp";
  images?: ImageContent[];
  /** Main-process correlation id; only a matching terminal error may release this turn. */
  promptId?: string;
  /** Immutable Main-created provenance for every SDK request emitted by this run. */
  originToken?: string;
}

export interface PiRuntimeError {
  message: string;
  command?: string;
  stack?: string;
  promptId?: string;
  terminal?: boolean;
}

export interface PiRuntimeSession {
  prompt(text: string, options?: PiRuntimePromptOptions): Promise<void>;
  steer(text: string, images?: ImageContent[]): Promise<void>;
  followUp(text: string, images?: ImageContent[]): Promise<void>;
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
  complete(provider: string, modelId: string, text: string, system?: string): Promise<string>;
  setThinkingLevel(level: string): void;
  getThinkingLevel(): string;
  getAvailableThinkingLevels(): string[];
  appendWorkflowEntry?(customType: string, data: unknown): Promise<void>;
  listModels(provider?: string): Promise<Array<{ provider: string; modelId: string; supportsImages: boolean }>>;
  listProviders(): Promise<PiProviderInfo[]>;
  subscribe(callback: (event: any) => void): () => void;
  onRuntimeError(callback: (error: PiRuntimeError) => void): () => void;
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
  sessionGeneration?: number;
  postMessage(envelope: PiRuntimeEnvelope): void;
  onMessage(callback: (envelope: PiRuntimeEnvelope) => void): () => void;
}

export function createPiRuntime(opts: {
  host: PiRuntimeSessionHost;
  transport: PiRuntimeChildTransport;
}): () => void {
  let sessionGeneration = 0;
  opts.transport.sessionGeneration = sessionGeneration;
  const emitEvent = (event: NormalizedEvent): void => {
    opts.transport.postMessage(eventEnvelope(event, sessionGeneration));
  };
  const forwardRuntimeError = (error: PiRuntimeError): void => {
    if (error.command === "prompt" && error.terminal === true
      && typeof error.promptId === "string" && error.promptId.trim().length > 0) {
      emitEvent({
        type: "prompt_error",
        message: error.message,
        command: "prompt",
        stack: error.stack,
        promptId: error.promptId,
        terminal: true,
      });
      return;
    }
    emitEvent({
      type: "runtime_error",
      message: error.message,
      command: error.command,
      stack: error.stack,
    });
  };
  let unsubscribe = opts.host.current().subscribe((event) => {
    emitEvent(normalizeEvent(event));
  });
  let unsubscribeRuntimeError = opts.host.current().onRuntimeError(forwardRuntimeError);

  const resubscribe = (): void => {
    unsubscribe();
    unsubscribeRuntimeError();
    unsubscribe = opts.host.current().subscribe((event) => {
      emitEvent(normalizeEvent(event));
    });
    unsubscribeRuntimeError = opts.host.current().onRuntimeError(forwardRuntimeError);
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
        sessionGeneration += 1;
        opts.transport.sessionGeneration = sessionGeneration;
        resubscribe();
        send(id, command, {
          id, type: "response", command: command.type, success: true,
          data: { sessionGeneration },
        });
        return;
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
      if (typeof command.originToken !== "string" || !command.originToken.trim()) {
        throw new Error("prompt originToken is required");
      }
      await session.prompt(command.message, {
        streamingBehavior: command.streamingBehavior,
        images: command.images,
        promptId: command.promptId,
        originToken: command.originToken,
      });
      return undefined;
    case "steer":
      if (typeof command.originToken !== "string" || !command.originToken.trim()) {
        throw new Error("steer originToken is required");
      }
      await session.steer(command.message, command.images);
      return undefined;
    case "follow_up":
      if (typeof command.originToken !== "string" || !command.originToken.trim()) {
        throw new Error("follow_up originToken is required");
      }
      // A follow-up is queued on the existing run; it never replaces that run's origin.
      await session.followUp(command.message, command.images);
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
      return await session.complete(command.provider, command.modelId, command.text, command.system);
    case "set_thinking_level":
      session.setThinkingLevel(command.level);
      return undefined;
    case "get_thinking_level":
      return session.getThinkingLevel();
    case "list_thinking_levels":
      return session.getAvailableThinkingLevels();
    case "append_workflow_entry":
      if (!session.appendWorkflowEntry) throw new Error('append_workflow_entry unsupported');
      await session.appendWorkflowEntry(command.customType, command.data);
      return undefined;
    case "list_models":
      return await session.listModels(command.provider);
    case "list_providers":
      return await session.listProviders();
  }
}
