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

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Runtime {
  profile: Awaited<ReturnType<typeof loadProfile>>;
  router: ModelRouter; rbac: Rbac; gate: ApprovalGate; executor: ConnectorExecutor; audit: AuditStore;
  pool: PiRuntimePool; identity: LocalIdentityProvider; subject: Subject | null;
  dataDir: string;
}

function resolvePiRuntimeEntry(): string {
  const explicit = process.env.SPARKII_PI_RUNTIME_ENTRY;
  if (explicit && existsSync(explicit)) return explicit;
  return join(__dirname, "../pi-runtime/utility-entry.js");
}

export async function assemble(opts: { profileDir: string; dataDir: string; publicKey?: string; allowUnsigned?: boolean }): Promise<Runtime> {
  const profile = await loadProfile(opts.profileDir, { publicKey: opts.publicKey, allowUnsigned: opts.allowUnsigned });
  const router = new ModelRouter(normalizeRouting(profile.manifest.modelRouting.tasks));
  const rbac = new Rbac(profile.security.roles);
  const audit = new AuditStore(join(opts.dataDir, "audit.db"));
  const gate = new ApprovalGate({ policy: profile.security.approval, rbac, audit });
  const executor = new ConnectorExecutor(audit);
  registerConnectorHandlers(executor);
  const identity = new LocalIdentityProvider(join(opts.dataDir, "users.json"));
  if ((await identity.listUsers()).length === 0) {
    await identity.seed({ id: "admin", username: "admin", password: "admin123", roles: ["admin", "reviewer"] });
  }
  await knowledgeConnector.init({ corpus: profile.agent.knowledge });
  const entry = resolvePiRuntimeEntry();
  process.env.SPARKII_SKILLS_DIR = join(opts.profileDir, 'agent', 'skills');
  const pool = new PiRuntimePool({
    maxAgents: Number(process.env.SPARKII_MAX_AGENTS ?? 4),
    makeSupervisor: () =>
      process.env.SPARKII_PI_USE_FORK === "1"
        ? createForkHostHandle(entry)
        : createUtilityHostHandle(entry),
  });
  return { profile, router, rbac, gate, executor, audit, pool, identity, subject: null, dataDir: opts.dataDir };
}
