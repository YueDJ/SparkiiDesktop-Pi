import type { ToolHandler } from '@sparkii/connectors';
import { transition, type Proposal } from './proposal.js';
import { AuditStore } from './audit.js';

export class ConnectorExecutor {
  private handlers = new Map<string, ToolHandler>();
  constructor(private audit: AuditStore) {}
  register(name: string, handler: ToolHandler): void { this.handlers.set(name, handler); }

  async execute(p: Proposal, ctx: { actor: string }): Promise<Proposal> {
    if (p.status !== 'approved') {
      await this.audit.append({ actor: ctx.actor, action: 'execution.blocked', resource: p.toolName, decision: p.status === 'denied' ? 'denied' : 'expired' });
      return p;
    }
    const handler = this.handlers.get(p.toolName);
    if (!handler) return transition(p, 'failed');
    try {
      const result = await handler(p.payload as Record<string, unknown>, {
        profileId: p.profileId, sessionId: p.sessionId, actor: ctx.actor, requestId: p.id,
      });
      if (!result.ok) {
        const failed = transition(p, 'failed');
        failed.execution = { ok: false, error: result.error?.message };
        await this.audit.append({ actor: ctx.actor, action: 'proposal.failed', resource: p.toolName });
        return failed;
      }
      const done = transition(p, 'executed');
      done.execution = { ok: true, result: result.data };
      await this.audit.append({ actor: ctx.actor, action: 'proposal.executed', resource: p.toolName });
      return done;
    } catch (e) {
      const failed = transition(p, 'failed');
      failed.execution = { ok: false, error: (e as Error).message };
      await this.audit.append({ actor: ctx.actor, action: 'proposal.failed', resource: p.toolName });
      return failed;
    }
  }
}
