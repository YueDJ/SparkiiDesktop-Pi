import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { ToolDef } from "@sparkii/connectors";
import { resolveToolDefinitions } from "./tool-registry.js";
import {
  proposalEnvelope,
  type ProposalDecision,
} from "./pi-runtime-transport.js";
import type { ImageContent, SessionSaddle } from "./types.js";
import type {
  PiRuntimeChildTransport,
  PiRuntimeSession,
  PiRuntimeSessionHost,
} from "./pi-runtime.js";

export interface PiSdkRuntimeOptions {
  transport: PiRuntimeChildTransport;
  tools?: ToolDef[];
  cwd?: string;
  skillsDir?: string;
  workspaceRoot?: string;
  agentDir?: string;
}

export function buildSkillLoaderOptions(skillsDir?: string): { additionalSkillPaths: string[] } {
  return { additionalSkillPaths: skillsDir ? [skillsDir] : [] };
}

export function resolveAgentDir(explicit?: string): string {
  return explicit ?? process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
}

export function readQueueSnapshot(session: {
  getSteeringMessages?: () => readonly string[];
  getFollowUpMessages?: () => readonly string[];
}): { steering: string[]; followUp: string[] } {
  return {
    steering: [...(session.getSteeringMessages?.() ?? [])],
    followUp: [...(session.getFollowUpMessages?.() ?? [])],
  };
}

export function clearSessionQueue(session: {
  clearQueue?: () => { steering: readonly string[]; followUp: readonly string[] };
}): { steering: string[]; followUp: string[] } {
  const cleared = session.clearQueue?.();
  return {
    steering: cleared?.steering ? [...cleared.steering] : [],
    followUp: cleared?.followUp ? [...cleared.followUp] : [],
  };
}

export function startPromptWithoutBlocking(
  session: { prompt: (text: string, options?: any) => Promise<unknown> },
  text: string,
  options?: { streamingBehavior?: "steer" | "followUp"; images?: ImageContent[] },
  onError?: (error: { message: string; command?: string; stack?: string }, command?: string) => void,
): Promise<void> {
  void session.prompt(text, options).catch((error) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    onError?.({
      message: normalized.message,
      command: "prompt",
      stack: normalized.stack,
    }, "prompt");
  });
  return Promise.resolve();
}

function systemPromptExtensionFactory(getSystemPrompt: () => string | undefined) {
  return (pi: ExtensionAPI) => {
    pi.on("before_agent_start", () => {
      const systemPrompt = getSystemPrompt();
      return systemPrompt ? { systemPrompt } : undefined;
    });
  };
}

export async function createPiSdkSessionHost(
  options: PiSdkRuntimeOptions,
): Promise<PiRuntimeSessionHost> {
  let pendingSaddle: SessionSaddle | null = null;
  const pendingProposals = new Map<
    string,
    { resolve: (decision: ProposalDecision) => void; reject: (error: Error) => void }
  >();

  options.transport.onMessage((envelope) => {
    if ("proposalDecision" in envelope) {
      const pending = pendingProposals.get(envelope.requestId);
      if (!pending) return;
      pendingProposals.delete(envelope.requestId);
      pending.resolve(envelope.proposalDecision);
    }
  });

  const fallbackCwd = options.cwd ?? process.env.SPARKII_PI_CWD ?? process.cwd();
  const fallbackWorkspaceRoot = options.workspaceRoot ?? process.env.SPARKII_WORKSPACE_ROOT ?? fallbackCwd;
  const agentDir = resolveAgentDir(options.agentDir);
  const sessionDir = join(agentDir, "sessions");
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });

  // 每次真正用模型前，让本进程重新读一次 models.json（不联网），
  // 使 baseUrl/服务商等 provider 配置变更能在下一条消息时热生效（与 key 的懒加载口径一致）。
  const syncModelConfig = async (provider: string): Promise<void> => {
    try {
      await modelRuntime.refresh({ providers: [provider], allowNetwork: false });
    } catch {
      // 配置刷新失败时沿用现有 provider 配置，不阻塞主流程
    }
  };

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd: effectiveCwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    const saddle = pendingSaddle;
    const services = await createAgentSessionServices({
      cwd: effectiveCwd,
      modelRuntime,
      resourceLoaderOptions: {
        additionalSkillPaths: saddle?.skillsDir ? [saddle.skillsDir] : options.skillsDir ? [options.skillsDir] : [],
        extensionFactories: [systemPromptExtensionFactory(() => pendingSaddle?.systemPrompt)],
      },
    });
    let initialModel;
    if (saddle?.model) {
      await syncModelConfig(saddle.model.provider);
      initialModel = modelRuntime.getModel(saddle.model.provider, saddle.model.modelId);
      if (!initialModel) {
        throw new Error(`unknown model ${saddle.model.provider}/${saddle.model.modelId}`);
      }
    }
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model: initialModel,
      thinkingLevel: saddle?.thinkingLevel as any,
    });
    return {
      ...result,
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: fallbackCwd,
    agentDir,
    sessionManager: SessionManager.create(fallbackCwd, sessionDir),
  });

  function adaptSession(): PiRuntimeSession {
    const session: any = runtime.session;
    const runtimeErrorListeners = new Set<(error: { message: string; command?: string; stack?: string }) => void>();
    const sessionCwd = pendingSaddle?.cwd ?? fallbackCwd;
    const workspaceRoot = pendingSaddle?.workspaceRoot ?? fallbackWorkspaceRoot;
    const saddleTools: ToolDefinition[] = pendingSaddle
      ? resolveToolDefinitions(pendingSaddle.tools, {
          cwd: sessionCwd,
          workspaceRoot,
          propose: async (request) =>
            new Promise<ProposalDecision>((resolve, reject) => {
              pendingProposals.set(request.requestId, { resolve, reject });
              options.transport.postMessage(proposalEnvelope(request));
            }),
        })
      : [];
    session.agent.state.tools = saddleTools;
    return {
      prompt: (text, promptOptions) => startPromptWithoutBlocking(
        session,
        text,
        promptOptions,
        (error) => runtimeErrorListeners.forEach((listener) => listener(error)),
      ),
      steer: (text, images) => session.steer(text, images),
      followUp: (text, images) => session.followUp(text, images),
      clearQueue: async () => clearSessionQueue(session),
      setSteeringMode: async (mode) => {
        session.setSteeringMode(mode);
      },
      setFollowUpMode: async (mode) => {
        session.setFollowUpMode(mode);
      },
      abort: () => session.abort(),
      setModel: async (provider, modelId) => {
        await syncModelConfig(provider);
        const model = modelRuntime.getModel(provider, modelId);
        if (!model) throw new Error(`unknown model ${provider}/${modelId}`);
        await session.setModel(model);
      },
      setAutoRetry: async () => {},
      setAutoCompaction: async () => {},
      setSessionName: async (name) => {
        session.setSessionName(name);
      },
      setApiKey: async (provider, apiKey) => {
        await modelRuntime.setRuntimeApiKey(provider, apiKey);
      },
      removeApiKey: async (provider) => {
        await modelRuntime.removeRuntimeApiKey(provider);
      },
      setThinkingLevel: (level) => {
        session.setThinkingLevel(level);
      },
      getThinkingLevel: () => session.thinkingLevel,
      getAvailableThinkingLevels: () => session.getAvailableThinkingLevels(),
      complete: async (provider, modelId, text) => {
        await syncModelConfig(provider);
        const model = modelRuntime.getModel(provider, modelId);
        if (!model) throw new Error(`unknown model ${provider}/${modelId}`);
        const out = await modelRuntime.completeSimple(model, {
          messages: [{ role: "user", content: text, timestamp: Date.now() }],
        });
        return out.content
          .filter((block): block is { type: "text"; text: string } => block.type === "text")
          .map((block) => block.text)
          .join("");
      },
      listModels: async (provider) => {
        if (provider) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15_000);
          try {
            const result = await modelRuntime.refresh({
              providers: [provider],
              allowNetwork: true,
              force: true,
              signal: controller.signal,
            });
            if (result.aborted) throw new Error('模型拉取超时');
            const error = result.errors.get(provider);
            if (error) throw error;
          } finally {
            clearTimeout(timer);
          }
        }
        const models = modelRuntime.getModels(provider);
        return models.map((model) => ({
          provider: model.provider ?? provider ?? "",
          modelId: model.id,
          supportsImages: Array.isArray((model as any).input) && (model as any).input.includes('image'),
        }));
      },
      listProviders: async () =>
        modelRuntime.getProviders().map((p) => {
          const provider = p as unknown as { id: string; name: string; baseUrl?: string; auth?: { apiKey?: unknown; oauth?: unknown } };
          return {
            id: provider.id,
            name: provider.name,
            baseUrl: provider.baseUrl ?? '',
            apiKeyAuth: Boolean(provider.auth?.apiKey),
            oauthAuth: Boolean(provider.auth?.oauth),
          };
        }),
      subscribe: (callback) => session.subscribe(callback),
      onRuntimeError: (callback) => {
        runtimeErrorListeners.add(callback);
        return () => runtimeErrorListeners.delete(callback);
      },
      getMessages: () => session.messages,
      getSessionEntries: () => session.sessionManager.getBranch(),
      getState: () => ({
        streaming: session.isStreaming,
        isStreaming: session.isStreaming,
        isCompacting: session.isCompacting,
        contextUsage: session.getContextUsage?.(),
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        steeringMode: session.steeringMode,
        followUpMode: session.followUpMode,
        pendingMessageCount: session.pendingMessageCount,
        ...readQueueSnapshot(session),
      }),
      dispose: () => session.dispose(),
    };
  }

  return {
    current: () => adaptSession(),
    newSession: async () => {
      await runtime.newSession();
      adaptSession();
    },
    switchSession: async (sessionPath: string) => {
      await runtime.switchSession(sessionPath);
      adaptSession();
    },
    configureSaddle: async (saddle: SessionSaddle | null) => {
      pendingSaddle = saddle;
      adaptSession();
    },
  };
}
