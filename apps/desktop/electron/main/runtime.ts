import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { loadProfile } from '@sparkii/config';
import { ModelRouter, normalizeRouting } from '@sparkii/model-router';
import { Rbac, LocalIdentityProvider, type Subject } from '@sparkii/identity';
import { ApprovalGate, ConnectorExecutor, AuditStore } from '@sparkii/approval';
import { PiProcessSupervisor } from '@sparkii/agent-host';
import { knowledgeConnector } from '@sparkii/connectors';

export interface Runtime {
  profile: Awaited<ReturnType<typeof loadProfile>>;
  router: ModelRouter; rbac: Rbac; gate: ApprovalGate; executor: ConnectorExecutor; audit: AuditStore;
  supervisor: PiProcessSupervisor; identity: LocalIdentityProvider; subject: Subject | null;
}

function resolvePiBin(): string {
  const explicit = process.env.SPARKII_PI_BIN || process.env.PI_BIN;
  if (explicit) return explicit;
  if (process.platform === 'win32') {
    const candidates = [
      process.env.PNPM_HOME && join(process.env.PNPM_HOME, 'bin', 'pi.cmd'),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'pnpm', 'bin', 'pi.cmd'),
      process.env.APPDATA && join(process.env.APPDATA, 'npm', 'pi.cmd'),
    ].filter((p): p is string => Boolean(p));
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return 'pi';
}

export async function assemble(opts: { profileDir: string; dataDir: string; publicKey?: string; allowUnsigned?: boolean }): Promise<Runtime> {
  const profile = await loadProfile(opts.profileDir, { publicKey: opts.publicKey, allowUnsigned: opts.allowUnsigned });
  const router = new ModelRouter(normalizeRouting(profile.manifest.modelRouting.tasks));
  const rbac = new Rbac(profile.security.roles);
  const audit = new AuditStore(join(opts.dataDir, 'audit.db'));
  const gate = new ApprovalGate({ policy: profile.security.approval, rbac, audit });
  const executor = new ConnectorExecutor(audit);
  const identity = new LocalIdentityProvider(join(opts.dataDir, 'users.json'));
  if ((await identity.listUsers()).length === 0) {
    await identity.seed({ id: 'admin', username: 'admin', password: 'admin123', roles: ['admin', 'reviewer'] });
  }
  await knowledgeConnector.init({ corpus: profile.agent.knowledge });
  return { profile, router, rbac, gate, executor, audit, supervisor: new PiProcessSupervisor({ bin: resolvePiBin() }), identity, subject: null };
}
