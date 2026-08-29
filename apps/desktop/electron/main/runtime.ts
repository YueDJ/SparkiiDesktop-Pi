import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { loadProfile } from "@sparkii/config";
import { ModelRouter, normalizeRouting } from "@sparkii/model-router";
import { Rbac, type Subject } from "@sparkii/identity";
import { ApprovalGate, ConnectorExecutor, AuditStore } from "@sparkii/approval";
import { PiRuntimePool } from "@sparkii/agent-host";
import { knowledgeConnector } from "@sparkii/connectors";
import { createUtilityHostHandle, createForkHostHandle } from "../pi-runtime/transports.js";
import { registerConnectorHandlers } from "./connector-registry.js";
import { ChatSessionStore } from "./chat-session-store.js";
import { Keyring } from "./keyring.js";
import { loadSettings } from "./settings.js";
import { loadApiKey, saveApiKey } from "./settings.js";
import { registerGeneralExecutor } from "./general-executor.js";
import { firstProfileWithKnowledge } from "./profile-catalog.js";

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
  pool: PiRuntimePool; subject: Subject;
  chatSessions: ChatSessionStore; dataDir: string; keyring: Keyring; piAgentDir: string;
  profileOf(id: string): ProfileRuntime;
  keyFor(providerId: string): Promise<string | null>;
  setKey(providerId: string, key: string): Promise<void>;
}

export interface KeyStore {
  keyFor(providerId: string): Promise<string | null>;
  setKey(providerId: string, key: string): Promise<void>;
}

export function createKeyStore(keyring: Keyring): KeyStore {
  const keyCache = new Map<string, string>();
  return {
    async keyFor(providerId: string): Promise<string | null> {
      const cached = keyCache.get(providerId);
      if (cached !== undefined) return cached;
      const key = await loadApiKey(keyring, providerId);
      if (key !== null) keyCache.set(providerId, key);
      return key;
    },
    async setKey(providerId: string, key: string): Promise<void> {
      await saveApiKey(keyring, providerId, key);
      keyCache.set(providerId, key);
    },
  };
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
  const knowledgeProfile = firstProfileWithKnowledge(profiles.values());
  if (knowledgeProfile) await knowledgeConnector.init({ corpus: knowledgeProfile.profile.agent.knowledge });
  const entry = resolvePiRuntimeEntry();
  const env = { PI_CODING_AGENT_DIR: piAgentDir };
  const settings = await loadSettings(opts.dataDir);
  const rawMaxAgents = Number(settings.maxAgents ?? process.env.SPARKII_MAX_AGENTS ?? 4);
  const maxAgents = Number.isFinite(rawMaxAgents) && rawMaxAgents > 0 ? Math.floor(rawMaxAgents) : 4;
  const pool = new PiRuntimePool({
    maxAgents,
    makeSupervisor: () =>
      process.env.SPARKII_PI_USE_FORK === "1"
        ? createForkHostHandle(entry, env)
        : createUtilityHostHandle(entry, env),
  });
  const keyStore = createKeyStore(keyring);
  return {
    profiles, gate, executor, audit, pool,
    subject: { userId: userInfo().username, roles: ["admin", "reviewer"] },
    chatSessions, dataDir: opts.dataDir, keyring, piAgentDir,
    profileOf: (id) => {
      const pr = profiles.get(id);
      if (!pr) throw new Error(`unknown profile ${id}`);
      return pr;
    },
    keyFor: keyStore.keyFor,
    setKey: keyStore.setKey,
  };
}
