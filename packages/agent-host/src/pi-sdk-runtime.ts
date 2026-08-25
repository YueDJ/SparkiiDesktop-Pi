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
}

export function buildSkillLoaderOptions(skillsDir?: string): { additionalSkillPaths: string[] } {
  return { additionalSkillPaths: skillsDir ? [skillsDir] : [] };
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
  const modelRuntime = await ModelRuntime.create();

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd: effectiveCwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    const saddle = pendingSaddle;
    const services = await createAgentSessionServices({
      cwd: effectiveCwd,
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
    agentDir: getAgentDir(),
    sessionManager: SessionManager.create(cwd),
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
        const model = modelRuntime.getModel(provider, modelId);
        if (!model) throw new Error(`unknown model ${provider}/${modelId}`);
        await session.setModel(model);
      },
      setAutoRetry: async () => {},
      setAutoCompaction: async () => {},
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
