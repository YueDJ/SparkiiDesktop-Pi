import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type BeforeAgentStartEvent,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  applySaddleSystemPrompt,
  promptWorkingDirectory,
} from "./skill-prompt.js";
import { join } from "node:path";
import type { ToolDef } from "@sparkii/connectors";
import { resolveToolDefinitions } from "./tool-registry.js";
import {
  connectorReadEnvelope,
  proposalEnvelope,
  type ConnectorReadResult,
  type ProposalDecision,
} from "./pi-runtime-transport.js";
import type { ProposalRequest } from "@sparkii/approval";
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

/**
 * Pi 1.0 默认开启 prompt cache warming（`settings.cacheWarming` 缺省 `"streaming"`，见
 * `settings-manager.js` 的 `getCacheWarmingMode()`），会在长 prompt 的 run 期间对 provider
 * 额外发一次计费请求，并往会话 JSONL 追加 `usage/cache_warm` 条目。
 * 本产品口径是「升级不改变既有行为」，因此在这里显式关闭（幂等，只在需要时落盘一次）。
 */
export function createPiSettingsManager(cwd: string, agentDir: string): SettingsManager {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  if (settingsManager.getCacheWarmingMode() !== "off") settingsManager.setCacheWarmingMode("off");
  return settingsManager;
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

/**
 * Snapshot of one Pi session for `get_state`. `streamingMessage` is the not-yet-committed
 * assistant message (`agent.state.streamingMessage`); openers need it to paint the in-flight
 * bubble without reading the session tree or the jsonl file.
 */
export function sessionStateSnapshot(session: {
  isStreaming?: boolean;
  isCompacting?: boolean;
  sessionId?: string;
  sessionFile?: string;
  steeringMode?: string;
  followUpMode?: string;
  pendingMessageCount?: number;
  agent?: { state?: { streamingMessage?: unknown } };
  getContextUsage?: () => unknown;
  getSteeringMessages?: () => readonly string[];
  getFollowUpMessages?: () => readonly string[];
}): Record<string, unknown> {
  return {
    streaming: session.isStreaming,
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    contextUsage: session.getContextUsage?.(),
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    steeringMode: session.steeringMode,
    followUpMode: session.followUpMode,
    pendingMessageCount: session.pendingMessageCount,
    streamingMessage: session.agent?.state?.streamingMessage ?? null,
    ...readQueueSnapshot(session),
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

export function appendCustomEntryAndEmit(
  session: { sessionManager: { appendCustomEntry(type: string, data: unknown): string; getEntry(id: string): unknown }; _emit?(event: unknown): void },
  customType: string,
  data: unknown,
): void {
  const entryId = session.sessionManager.appendCustomEntry(customType, data);
  const entry = session.sessionManager.getEntry(entryId);
  if (entry) session._emit?.({ type: "entry_appended", entry });
}

function systemPromptExtensionFactory(
  getSystemPrompt: () => string | undefined,
  getSaddle: () => SessionSaddle | null,
  syncTools: (pi: ExtensionAPI) => void,
) {
  return (pi: ExtensionAPI) => {
    pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
      // Pi 1.0 的模型可见工具集由会话内部的「工具注册表 + loadout」推导：
      // 每次 prompt 前 `_preparePromptAndToolLoadout()` 会用注册表过滤一次并回写
      // `agent.state.tools`，所以鞍里的工具必须真的进注册表（0.84.x 可直接赋值 state.tools）。
      syncTools(pi);
      return applySaddleSystemPrompt(getSystemPrompt(), {
        ...event,
        systemPromptOptions: {
          ...event.systemPromptOptions,
          cwd: promptWorkingDirectory(getSaddle(), event.systemPromptOptions?.cwd),
          workspaceRoot: getSaddle()?.workspaceRoot,
        },
      });
    });
  };
}

export async function createPiSdkSessionHost(
  options: PiSdkRuntimeOptions,
): Promise<PiRuntimeSessionHost> {
  let pendingSaddle: SessionSaddle | null = null;
  let liveSession: any = null;
  // 上一次真正写进 Pi 工具注册表的鞍对象；同一个鞍重复 prompt 不重复注册。
  let appliedSaddle: SessionSaddle | null = null;
  const pendingProposals = new Map<
    string,
    { resolve: (decision: ProposalDecision) => void; reject: (error: Error) => void }
  >();
  const pendingConnectorReads = new Map<
    string,
    { resolve: (result: ConnectorReadResult) => void; reject: (error: Error) => void }
  >();

  options.transport.onMessage((envelope) => {
    if ("proposalDecision" in envelope) {
      const pending = pendingProposals.get(envelope.requestId);
      if (!pending) return;
      pendingProposals.delete(envelope.requestId);
      pending.resolve(envelope.proposalDecision);
    }
    if ("connectorReadResult" in envelope) {
      const pending = pendingConnectorReads.get(envelope.requestId);
      if (!pending) return;
      pendingConnectorReads.delete(envelope.requestId);
      pending.resolve(envelope.connectorReadResult);
    }
  });

  const fallbackCwd = options.cwd ?? process.env.SPARKII_PI_CWD ?? process.cwd();
  const fallbackWorkspaceRoot = options.workspaceRoot ?? process.env.SPARKII_WORKSPACE_ROOT ?? fallbackCwd;
  const agentDir = resolveAgentDir(options.agentDir);
  const sessionDir = join(agentDir, "sessions");

  const proposeFromTool = (request: ProposalRequest & { requestId: string }) =>
    new Promise<ProposalDecision>((resolve, reject) => {
      pendingProposals.set(request.requestId, { resolve, reject });
      options.transport.postMessage(proposalEnvelope(request));
    });

  const connectorReadFromTool = (request: Parameters<typeof connectorReadEnvelope>[0]) =>
    new Promise<ConnectorReadResult>((resolve, reject) => {
      pendingConnectorReads.set(request.requestId, { resolve, reject });
      options.transport.postMessage(connectorReadEnvelope(request));
    });

  /**
   * 按鞍装配工具定义。Pi 1.0 起工具必须经会话注册表（`customTools` / 扩展 `registerTool`）进入，
   * 直接写 `session.agent.state.tools` 会在下一个 prompt 被 loadout 过滤掉。
   */
  const buildSaddleTools = (saddle: SessionSaddle): ToolDefinition[] =>
    resolveToolDefinitions(saddle.tools, {
      cwd: saddle.cwd ?? fallbackCwd,
      workspaceRoot: saddle.workspaceRoot ?? fallbackWorkspaceRoot,
      skillsDir: saddle.skillsDir,
      propose: proposeFromTool,
      connectorRead: connectorReadFromTool,
      recordSessionEntry: (customType, data) => {
        if (liveSession) appendCustomEntryAndEmit(liveSession, customType, data);
      },
    });

  /**
   * 会话中途换鞍（进程池槽位复用）：把新鞍的工具补进注册表并重置激活集合。
   * `registerTool` 同名覆盖，旧鞍的工具会因不在激活集合里而不再声明给模型（不泄漏）。
   * Pi 1.0 的 `ExtensionAPI.registerTool()` 内部会调用 `refreshTools()` 重建注册表，
   * 因此不需要触碰任何私有字段。
   */
  const syncSaddleTools = (pi: ExtensionAPI): void => {
    const saddle = pendingSaddle;
    if (!saddle || saddle === appliedSaddle) return;
    const definitions = buildSaddleTools(saddle);
    for (const definition of definitions) pi.registerTool(definition);
    pi.setActiveTools(definitions.map((definition) => definition.name));
    appliedSaddle = saddle;
  };

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
    // 1.0：鞍工具必须在会话创建期进注册表（customTools）+ 用 tools 限定允许/激活集合。
    // 只传 customTools 不传 tools 会让 `usesDefaultTools` 为真，把内置 read/bash/edit/write 一并激活。
    const saddleTools = saddle ? buildSaddleTools(saddle) : [];
    const saddleToolNames = saddleTools.map((definition) => definition.name);
    const services = await createAgentSessionServices({
      cwd: effectiveCwd,
      modelRuntime,
      settingsManager: createPiSettingsManager(effectiveCwd, agentDir),
      resourceLoaderOptions: {
        additionalSkillPaths: saddle?.skillsDir ? [saddle.skillsDir] : options.skillsDir ? [options.skillsDir] : [],
        extensionFactories: [
          systemPromptExtensionFactory(
            () => pendingSaddle?.systemPrompt,
            () => pendingSaddle,
            syncSaddleTools,
          ),
        ],
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
      customTools: saddleTools,
      tools: saddleToolNames,
    });
    appliedSaddle = saddle;
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
    liveSession = session;
    const runtimeErrorListeners = new Set<(error: { message: string; command?: string; stack?: string }) => void>();
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
      appendWorkflowEntry: async (customType, data) => {
        appendCustomEntryAndEmit(session, customType, data);
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
      getState: () => sessionStateSnapshot(session),
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
      // 换鞍后下一次 prompt 由扩展把新工具同步进注册表（旧的留在注册表但不再激活）。
      appliedSaddle = null;
      adaptSession();
    },
  };
}
