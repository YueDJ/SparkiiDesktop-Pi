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
import type { SessionSaddle } from "./types.js";
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

  const cwd = options.cwd ?? process.env.SPARKII_PI_CWD ?? process.cwd();
  const currentWorkspaceRoot = options.workspaceRoot ?? process.env.SPARKII_WORKSPACE_ROOT ?? cwd;
  const agentDir = resolveAgentDir(options.agentDir);
  const sessionDir = join(agentDir, "sessions");
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const apiKey = process.env.SPARKII_PI_API_KEY;

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
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    });
    return {
      ...result,
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager: SessionManager.create(cwd, sessionDir),
  });

  function adaptSession(): PiRuntimeSession {
    const session: any = runtime.session;
    const saddleTools: ToolDefinition[] = pendingSaddle
      ? resolveToolDefinitions(pendingSaddle.tools, {
          cwd,
          workspaceRoot: pendingSaddle.workspaceRoot ?? currentWorkspaceRoot,
          propose: async (request) =>
            new Promise<ProposalDecision>((resolve, reject) => {
              pendingProposals.set(request.requestId, { resolve, reject });
              options.transport.postMessage(proposalEnvelope(request));
            }),
        })
      : [];
    session.agent.state.tools = saddleTools;
    return {
      prompt: (text, promptOptions) => session.prompt(text, promptOptions),
      steer: (text) => session.steer(text),
      followUp: (text) => session.followUp(text),
      abort: () => session.abort(),
      setModel: async (provider, modelId) => {
        await syncModelConfig(provider);
        if (apiKey) await modelRuntime.setRuntimeApiKey(provider, apiKey);
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
        }));
      },
      testConnection: async (provider, modelId) => {
        const start = Date.now();
        await syncModelConfig(provider);
        const model = modelRuntime.getModel(provider, modelId);
        if (!model) return { ok: false, error: `unknown model ${provider}/${modelId}` };
        try {
          await modelRuntime.completeSimple(model, {
            messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
          });
          return { ok: true, latencyMs: Date.now() - start };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
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
      getMessages: () => session.messages,
      getState: () => ({
        streaming: session.isStreaming,
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
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
