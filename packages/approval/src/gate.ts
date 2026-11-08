import type { ApprovalPolicy } from '@sparkii/config';
import { Rbac, type Subject } from '@sparkii/identity';
import { createProposal, transition, summarizePayload, type Proposal, type ProposalSubmission } from './proposal.js';
import { AuditStore } from './audit.js';

export class GateError extends Error {
  constructor(
    public code: 'UNAUTHORIZED' | 'NOT_FOUND' | 'NOT_PENDING' | 'SHUTTING_DOWN',
    message: string,
  ) { super(message); }
}

interface ProfilePolicy { policy: ApprovalPolicy; rbac: Rbac; }

export class ApprovalGate {
  private proposals = new Map<string, Proposal>();
  private profiles = new Map<string, ProfilePolicy>();
  /**
   * m10：abortPendingForQuit（§7.7 步骤 2）一旦开始，审批门就不再接受新提案。
   * 原先只有「逐条过期」而没有闸门：shutdown.ts 的 abortPendingApprovals 先于 stopPool，
   * 窗口内 agent 仍能 submit ⇒ 新提案逃过 expire + 审计，违反 §7.7 步骤 2 的「未清空前不得进入安装」。
   * 置位在方法**同步段**（第一个 await 之前），因此不存在「检查后插入」的交错。
   */
  private shuttingDown = false;

  constructor(private opts: { audit: AuditStore; policy?: ApprovalPolicy; rbac?: Rbac }) {
    if (opts.policy && opts.rbac) this.profiles.set('default', { policy: opts.policy, rbac: opts.rbac });
  }

  configureProfile(profileId: string, cfg: ProfilePolicy): void {
    this.profiles.set(profileId, cfg);
  }

  private profileOf(profileId: string): ProfilePolicy {
    const p = this.profiles.get(profileId) ?? this.profiles.get('default');
    if (!p) throw new GateError('NOT_FOUND', `no policy for profile ${profileId}`);
    return p;
  }

  async submit(req: ProposalSubmission, meta: { profileId: string; sessionId: string; actor: string }): Promise<Proposal> {
    if (this.shuttingDown) {
      throw new GateError('SHUTTING_DOWN', 'approval gate is shutting down for update install');
    }
    const p = createProposal(req, { profileId: meta.profileId, sessionId: meta.sessionId });
    this.proposals.set(p.id, p);
    await this.opts.audit.append({ actor: meta.actor, action: 'proposal.created', resource: p.toolName, payloadSummary: summarizePayload(p.payload), sessionId: meta.sessionId });
    return p;
  }

  async decide(id: string, by: Subject, approved: boolean, note?: string): Promise<Proposal> {
    const p = this.proposals.get(id);
    if (!p) throw new GateError('NOT_FOUND', id);
    if (p.status !== 'pending') throw new GateError('NOT_PENDING', id);
    if (approved && p.risk !== 'read' && !this.profileOf(p.profileId).rbac.canApprove(by, p.risk)) throw new GateError('UNAUTHORIZED', 'approver lacks permission');
    const out = transition(p, approved ? 'approved' : 'denied');
    out.decisionBy = by.userId; out.decisionNote = note;
    this.proposals.set(id, out);
    await this.opts.audit.append({ actor: by.userId, action: approved ? 'proposal.approved' : 'proposal.denied', resource: p.toolName, decision: approved ? 'approved' : 'denied', sessionId: p.sessionId });
    return out;
  }

  async expire(id: string): Promise<Proposal | undefined> {
    const p = this.proposals.get(id);
    if (!p || p.status !== 'pending') return p;
    if (Date.now() - p.createdAt >= this.profileOf(p.profileId).policy.timeoutMs) {
      const out = transition(p, 'expired');
      this.proposals.set(id, out);
      await this.opts.audit.append({ actor: 'system', action: 'proposal.expired', resource: p.toolName, decision: 'expired', sessionId: p.sessionId });
      return out;
    }
    return p;
  }

  /**
   * §7.7 步骤 2：升级安装前把全部 pending 提案显式过期并逐条写审计。
   * 逐条 await transition 写回与审计 append，未清空前不得返回成功（不能进入安装）。
   * 不改动 expire(id) 的超时语义；非 pending 提案不受影响。
   */
  async abortPendingForQuit(reason: string): Promise<number> {
    // 先关闸门（同步动作），再逐条过期；此后到达的 submit 一律 SHUTTING_DOWN。
    this.shuttingDown = true;
    const pending = this.listPending();
    try {
      for (const p of pending) {
        const out = transition(p, 'expired');
        out.decisionBy = 'system:update-install';
        out.decisionNote = reason;
        this.proposals.set(p.id, out);
        await this.opts.audit.append({
          actor: 'system',
          action: 'update.install-abort',
          resource: p.toolName,
          decision: 'expired',
          payloadSummary: reason,
          sessionId: p.sessionId,
        });
      }
    } catch (err) {
      // m10：这一方法失败时，安装事务可能走「可逆」分支（应用继续运行）。若不重开闸门，
      // 之后所有审批提交都会永久 SHUTTING_DOWN —— 比一次失败的清理严重得多。
      // 已过期的提案不会回滚（它们本来就该在安装前作废），但闸门必须重新接受新提交。
      this.shuttingDown = false;
      throw err;
    }
    return pending.length;
  }

  async cancelSession(sessionId: string, reason: string): Promise<Proposal[]> {
    const cancelled: Proposal[] = [];
    for (const proposal of this.proposals.values()) {
      if (proposal.sessionId !== sessionId || proposal.status !== 'pending') continue;
      const out = transition(proposal, 'denied');
      out.decisionBy = 'system:task-revoked';
      out.decisionNote = reason;
      this.proposals.set(out.id, out);
      cancelled.push(out);
      await this.opts.audit.append({
        actor: 'system',
        action: 'proposal.cancelled',
        resource: out.toolName,
        payloadSummary: reason,
        decision: 'denied',
        sessionId: out.sessionId,
      });
    }
    return cancelled;
  }

  get(id: string) { return this.proposals.get(id); }
  listPending() { return [...this.proposals.values()].filter((p) => p.status === 'pending'); }
}
