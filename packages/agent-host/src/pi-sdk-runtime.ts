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
  getActiveToolNames?: () => readonly string[];
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
    activeToolNames: [...(session.getActiveToolNames?.() ?? [])],
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
  onApi: (pi: ExtensionAPI) => void,
) {
  return (pi: ExtensionAPI) => {
    onApi(pi);
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
  // 当前会话对应的 ExtensionAPI（会话每次重建都会由扩展工厂重新给出）。
  let extensionApi: ExtensionAPI | null = null;
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
   * 把一批工具定义写进当前会话的注册表，并把激活集合**精确**设成这批工具。
   * Pi 1.0 的 `ExtensionAPI.registerTool()` 内部会调用 `refreshTools()` 重建注册表，
   * 因此不需要触碰任何私有字段；`setActiveTools` 负责把旧鞍的工具从模型声明里撤下。
   */
  const registerSaddleTools = (
    pi: ExtensionAPI,
    saddle: SessionSaddle,
    definitions: ToolDefinition[],
  ): void => {
    for (const definition of definitions) pi.registerTool(definition);
    pi.setActiveTools(definitions.map((definition) => definition.name));
    appliedSaddle = saddle;
  };

  /**
   * prompt 路径上的兜底同步（`before_agent_start` 里调用）：换鞍时**立即**同步（不等第一个 prompt），
   * 这样 `get_state` 在 prompt 之前就能反映真实工具面，也不依赖 prompt 路径的时序。
   * 会话重建后 `extensionApi` 会被新的工厂实例替换；若此刻 API 已失效（会话被替换/重载），
   * 退回由下一次 `before_agent_start` 同步。
   *
   * fail closed：鞍里的工具名解析失败（`resolveToolDefinitions` 抛 unknown tool）时，
   * 先把激活集合清空再抛错，绝不把上一个 profile 的工具留在模型可见面上。
   */
  const syncSaddleToolsNow = (): void => {
    if (!extensionApi || !runtime) return;
    const saddle = pendingSaddle;
    if (!saddle) {
      try {
        extensionApi.setActiveTools([]);
      } catch {
        appliedSaddle = null;
      }
      return;
    }
    if (saddle === appliedSaddle) return;
    let definitions: ToolDefinition[];
    try {
      definitions = buildSaddleTools(saddle);
    } catch (error) {
      appliedSaddle = null;
      try {
        extensionApi.setActiveTools([]);
      } catch {
        // API 已失效：交给下一次 before_agent_start 重新同步
      }
      throw error;
    }
    try {
      registerSaddleTools(extensionApi, saddle, definitions);
    } catch {
      appliedSaddle = null;
    }
  };

  /**
   * 会话被替换（newSession/switchSession/configureSaddle）后，重新把当前鞍的工具装进新会话。
   * 必须先清空 `appliedSaddle`：新会话的注册表是空的、激活集合为空，
   * 若沿用"同鞍跳过"的判断，第一个 prompt 就会带着零工具发出去。
   */
  const applySaddleToCurrentSession = (): void => {
    appliedSaddle = null;
    adaptSession();
    syncSaddleToolsNow();
  };

  /** prompt 前的最后一次核对（`before_agent_start`）：只在该鞍还没生效时才重装。 */
  const syncSaddleToolsOnPrompt = (pi: ExtensionAPI): void => {
    const saddle = pendingSaddle;
    if (!saddle || saddle === appliedSaddle) return;
    registerSaddleTools(pi, saddle, buildSaddleTools(saddle));
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
    // 1.0：鞍工具必须在会话创建期进注册表（customTools）。这里**不能**用 `tools` 限定集合：
    // `tools` 会在创建时冻结 `_allowedToolNames`（`agent-session.js` 构造后无更新点），
    // 而工具注册表按它过滤 ⇒ 换鞍时新增的工具名会被静默丢弃、甚至整盘为空。
    // `noTools: "builtin"` 才是正确口径：关掉默认内置工具（read/bash/edit/write）的自动激活，
    // 同时不设白名单，让扩展/自定义工具可注册，激活集合完全由 `setActiveTools()` 决定。
    const saddleTools = saddle ? buildSaddleTools(saddle) : [];
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
            syncSaddleToolsOnPrompt,
            (api) => {
              extensionApi = api;
            },
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
      noTools: "builtin",
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
      applySaddleToCurrentSession();
    },
    switchSession: async (sessionPath: string) => {
      await runtime.switchSession(sessionPath);
      applySaddleToCurrentSession();
    },
    configureSaddle: async (saddle: SessionSaddle | null) => {
      pendingSaddle = saddle;
      // 换鞍后先做一次立即同步（旧鞍工具留在注册表但不再激活）；`before_agent_start` 还会再核一次。
      applySaddleToCurrentSession();
    },
  };
}
