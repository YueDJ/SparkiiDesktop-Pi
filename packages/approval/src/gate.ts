import type { ApprovalPolicy } from '@sparkii/config';
import { Rbac, type Subject } from '@sparkii/identity';
import { createProposal, transition, summarizePayload, type Proposal, type ProposalRequest } from './proposal.js';
import { AuditStore } from './audit.js';

export class GateError extends Error {
  constructor(public code: 'UNAUTHORIZED' | 'NOT_FOUND' | 'NOT_PENDING', message: string) { super(message); }
}

export class ApprovalGate {
  private proposals = new Map<string, Proposal>();
  constructor(private opts: { policy: ApprovalPolicy; rbac: Rbac; audit: AuditStore }) {}

  async submit(req: ProposalRequest, meta: { profileId: string; sessionId: string; actor: string }): Promise<Proposal> {
    const p = createProposal(req, { profileId: meta.profileId, sessionId: meta.sessionId });
    this.proposals.set(p.id, p);
    await this.opts.audit.append({ actor: meta.actor, action: 'proposal.created', resource: p.toolName, payloadSummary: summarizePayload(p.payload), sessionId: meta.sessionId });
    return p;
  }

  async decide(id: string, by: Subject, approved: boolean, note?: string): Promise<Proposal> {
    const p = this.proposals.get(id);
    if (!p) throw new GateError('NOT_FOUND', id);
    if (p.status !== 'pending') throw new GateError('NOT_PENDING', id);
    if (approved && p.risk !== 'read' && !this.opts.rbac.canApprove(by, p.risk)) throw new GateError('UNAUTHORIZED', 'approver lacks permission');
    const out = transition(p, approved ? 'approved' : 'denied');
    out.decisionBy = by.userId; out.decisionNote = note;
    this.proposals.set(id, out);
    await this.opts.audit.append({ actor: by.userId, action: approved ? 'proposal.approved' : 'proposal.denied', resource: p.toolName, decision: approved ? 'approved' : 'denied', sessionId: p.sessionId });
    return out;
  }

  async expire(id: string): Promise<Proposal | undefined> {
    const p = this.proposals.get(id);
    if (!p || p.status !== 'pending') return p;
    if (Date.now() - p.createdAt > this.opts.policy.timeoutMs) {
      const out = transition(p, 'expired');
      this.proposals.set(id, out);
      await this.opts.audit.append({ actor: 'system', action: 'proposal.expired', resource: p.toolName, decision: 'expired', sessionId: p.sessionId });
      return out;
    }
    return p;
  }

  get(id: string) { return this.proposals.get(id); }
  listPending() { return [...this.proposals.values()].filter((p) => p.status === 'pending'); }
}
