import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadProfile } from "@sparkii/config";
import { ModelRouter, normalizeRouting } from "@sparkii/model-router";
import { Rbac, LocalIdentityProvider, type Subject } from "@sparkii/identity";
import { ApprovalGate, ConnectorExecutor, AuditStore } from "@sparkii/approval";
import { PiRuntimePool } from "@sparkii/agent-host";
import { knowledgeConnector } from "@sparkii/connectors";
import { createUtilityHostHandle, createForkHostHandle } from "../pi-runtime/transports.js";
import { registerConnectorHandlers } from "./connector-registry.js";
import { ChatSessionStore } from "./chat-session-store.js";
import { Keyring } from "./keyring.js";
import { registerGeneralExecutor } from "./general-executor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ProfileRuntime {
  profile: Awaited<ReturnType<typeof loadProfile>>;
  router: ModelRouter;
  rbac: Rbac;
  dir: string;
}

export interface Runtime {
  profiles: Map<string, ProfileRuntime>;
  gate: ApprovalGate; executor: ConnectorExecutor; audit: AuditStore;
  pool: PiRuntimePool; identity: LocalIdentityProvider; subject: Subject | null;
  chatSessions: ChatSessionStore; dataDir: string; keyring: Keyring; piAgentDir: string;
  profileOf(id: string): ProfileRuntime;
}

function resolvePiRuntimeEntry(): string {
  const explicit = process.env.SPARKII_PI_RUNTIME_ENTRY;
  if (explicit && existsSync(explicit)) return explicit;
  return join(__dirname, "../pi-runtime/utility-entry.js");
}

export async function assemble(opts: {
  profiles: Array<{ id: string; dir: string }>;
  dataDir: string; publicKey?: string; allowUnsigned?: boolean;
}): Promise<Runtime> {
  const profiles = new Map<string, ProfileRuntime>();
  for (const { id, dir } of opts.profiles) {
    const profile = await loadProfile(dir, { publicKey: opts.publicKey, allowUnsigned: opts.allowUnsigned });
    profiles.set(id, {
      profile,
      router: new ModelRouter(normalizeRouting(profile.manifest.modelRouting.tasks)),
      rbac: new Rbac(profile.security.roles),
      dir,
    });
  }
  const audit = new AuditStore(join(opts.dataDir, "audit.db"));
  const gate = new ApprovalGate({ audit });
  for (const [id, pr] of profiles) {
    gate.configureProfile(id, { policy: pr.profile.security.approval, rbac: pr.rbac });
  }
  const executor = new ConnectorExecutor(audit);
  registerConnectorHandlers(executor);
  const chatSessions = new ChatSessionStore(join(opts.dataDir, "sessions.db"));
  const keyring = new Keyring(join(opts.dataDir, "keyring"));
  const piAgentDir = join(opts.dataDir, "pi-agent");
  registerGeneralExecutor(executor, {
    getWorkspace: (sessionId) => {
      const rec = chatSessions.get(sessionId);
      return rec ? { workspacePath: rec.workspacePath } : undefined;
    },
    markWorkspaceCreated: () => {},
  });
  const identity = new LocalIdentityProvider(join(opts.dataDir, "users.json"));
  if ((await identity.listUsers()).length === 0) {
    await identity.seed({ id: "admin", username: "admin", password: "admin123", roles: ["admin", "reviewer"] });
  }
  const contract = profiles.get("contract-review");
  if (contract) await knowledgeConnector.init({ corpus: contract.profile.agent.knowledge });
  const entry = resolvePiRuntimeEntry();
  const apiKey = await keyring.get("apiKey");
  const env = {
    PI_CODING_AGENT_DIR: piAgentDir,
    ...(apiKey ? { SPARKII_PI_API_KEY: apiKey } : {}),
  };
  const pool = new PiRuntimePool({
    maxAgents: Number(process.env.SPARKII_MAX_AGENTS ?? 4),
    makeSupervisor: () =>
      process.env.SPARKII_PI_USE_FORK === "1"
        ? createForkHostHandle(entry, env)
        : createUtilityHostHandle(entry, env),
  });
  return {
    profiles, gate, executor, audit, pool, identity, subject: null, chatSessions, dataDir: opts.dataDir, keyring, piAgentDir,
    profileOf: (id) => {
      const pr = profiles.get(id);
      if (!pr) throw new Error(`unknown profile ${id}`);
      return pr;
    },
  };
}
