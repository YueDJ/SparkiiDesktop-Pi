import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  defineTool,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import {
  documentConnector,
  knowledgeConnector,
  reportConnector,
  type ToolDef,
} from "@sparkii/connectors";
import { buildPiRuntimeTools } from "./pi-runtime-tools.js";
import {
  proposalEnvelope,
  type ProposalDecision,
} from "./pi-runtime-transport.js";
import type {
  PiRuntimeChildTransport,
  PiRuntimeSession,
  PiRuntimeSessionHost,
} from "./pi-runtime.js";

export interface PiSdkRuntimeOptions {
  transport: PiRuntimeChildTransport;
  tools?: ToolDef[];
  cwd?: string;
}

export async function createPiSdkSessionHost(
  options: PiSdkRuntimeOptions,
): Promise<PiRuntimeSessionHost> {
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

  const tools =
    options.tools ??
    [
      ...documentConnector.tools,
      ...knowledgeConnector.tools,
      ...reportConnector.tools,
    ];

  const piTools = buildPiRuntimeTools({
    tools,
    propose: async (request) =>
      new Promise<ProposalDecision>((resolve, reject) => {
        pendingProposals.set(request.requestId, { resolve, reject });
        options.transport.postMessage(proposalEnvelope(request));
      }),
  }).map((tool) => defineTool(tool as any));

  const cwd = options.cwd ?? process.env.SPARKII_PI_CWD ?? process.cwd();
  const modelRuntime = await ModelRuntime.create();

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd: effectiveCwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({ cwd: effectiveCwd });
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
    session.agent.state.tools = piTools;
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
  };
}
