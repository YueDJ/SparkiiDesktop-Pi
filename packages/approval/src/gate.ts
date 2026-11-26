import type { ApprovalPolicy } from '@sparkii/config';
import { Rbac, type Subject } from '@sparkii/identity';
import { createProposal, hashPayload, transition, summarizePayload, type Proposal, type ProposalSubmission } from './proposal.js';
import { AuditStore } from './audit.js';

export class GateError extends Error {
  constructor(
    public code: 'UNAUTHORIZED' | 'NOT_FOUND' | 'NOT_PENDING' | 'SHUTTING_DOWN',
    message: string,
  ) { super(message); }
}

interface ProfilePolicy { policy: ApprovalPolicy; rbac: Rbac; }
type InvalidationListener = (proposal: Proposal) => void;
interface PendingInvalidation {
  proposal: Proposal;
  deliveredListeners: Set<InvalidationListener>;
}

export class ApprovalGate {
  private proposals = new Map<string, Proposal>();
  private invalidationListeners = new Set<InvalidationListener>();
  private pendingInvalidations = new Map<string, PendingInvalidation>();
  private profiles = new Map<string, ProfilePolicy>();
  /**
   * m10：abortPendingForQuit（§7.7 步骤 2）一旦开始，审批门就不再接受新提案。
   * 原先只有「逐条过期」而没有闸门：shutdown.ts 的 abortPendingApprovals 先于 stopPool，
   * 窗口内 agent 仍能 submit ⇒ 新提案逃过 expire + 审计，违反 §7.7 步骤 2 的「未清空前不得进入安装」。
   * 置位在方法**同步段**（第一个 await 之前），因此不存在「检查后插入」的交错。
   */
  private shuttingDown = false;
  private privacyBlocked: string | undefined;

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

  private assertPrivacyAvailable(): void {
    if (this.privacyBlocked) throw new GateError('SHUTTING_DOWN', this.privacyBlocked);
  }

  async submit(req: ProposalSubmission, meta: { profileId: string; sessionId: string; actor: string; taskId?: string }): Promise<Proposal> {
    this.assertPrivacyAvailable();
    if (this.shuttingDown) {
      throw new GateError('SHUTTING_DOWN', 'approval gate is shutting down for update install');
    }
    const safeReq = this.opts.audit.redactValue(req);
    const safeMeta = this.opts.audit.redactValue(meta);
    const safeMetaValue = safeMeta.value as { profileId: string; sessionId: string; actor: string; taskId?: string };
    const p = createProposal(safeReq.value as ProposalSubmission, { profileId: safeMetaValue.profileId, sessionId: safeMetaValue.sessionId, taskId: safeMetaValue.taskId });
    if (safeReq.redacted || safeMeta.redacted) p.privacyRedacted = true;
    this.proposals.set(p.id, p);
    await this.opts.audit.append({ actor: meta.actor, action: 'proposal.created', resource: p.toolName, payloadSummary: summarizePayload(p.payload), sessionId: p.sessionId });
    // Privacy invalidation or a concurrent transition may have replaced the map entry while audit was pending.
    const canonical = this.proposals.get(p.id);
    if (!canonical) throw new GateError('NOT_FOUND', p.id);
    return canonical;  }

  async decide(id: string, by: Subject, approved: boolean, note?: string, expectedTaskId?: string): Promise<Proposal> {
    this.assertPrivacyAvailable();
    const p = this.proposals.get(id);
    if (!p) throw new GateError('NOT_FOUND', id);
    if (expectedTaskId !== undefined && p.taskId !== expectedTaskId) throw new GateError('NOT_PENDING', id);
    if (p.status !== 'pending' || p.privacyRedacted || this.opts.audit.containsValue(p)) throw new GateError('NOT_PENDING', id);
    if (approved && p.risk !== 'read' && !this.profileOf(p.profileId).rbac.canApprove(by, p.risk)) throw new GateError('UNAUTHORIZED', 'approver lacks permission');
    const out = transition(p, approved ? 'approved' : 'denied');
    const safeBy = this.opts.audit.redactValue(by);
    const safeNote = note === undefined ? undefined : this.opts.audit.redactValue(note);
    out.decisionBy = (safeBy.value as Subject).userId;
    out.decisionNote = safeNote?.value as string | undefined;
    if (safeBy.redacted || safeNote?.redacted) out.privacyRedacted = true;
    this.proposals.set(id, out);
    await this.opts.audit.append({ actor: by.userId, action: approved ? 'proposal.approved' : 'proposal.denied', resource: p.toolName, decision: approved ? 'approved' : 'denied', sessionId: p.sessionId });
    const canonical = this.proposals.get(id);
    if (!canonical || (expectedTaskId !== undefined && canonical.taskId !== expectedTaskId)) {
      throw new GateError('NOT_PENDING', id);
    }
    return canonical;
  }

  /**
   * Synchronously bind a caller-selected value (currently an export path) to
   * the exact approved canonical object. A redaction or concurrent update
   * replaces that object, so the compare-and-swap fails closed.
   */
  updateApprovedPayload(expected: Proposal, payload: unknown): Proposal | undefined {
    this.assertPrivacyAvailable();
    const current = this.proposals.get(expected.id);
    if (
      current !== expected
      || current.status !== 'approved'
      || current.privacyRedacted
      || this.opts.audit.containsValue(current)
      || current.payloadHash !== hashPayload(current.payload)
    ) return undefined;
    const safe = this.opts.audit.redactValue(payload);
    const next: Proposal = { ...current, payload: safe.value, payloadHash: hashPayload(safe.value) };
    if (safe.redacted) next.privacyRedacted = true;
    this.proposals.set(next.id, next);
    return next;
  }

  async expire(id: string): Promise<Proposal | undefined> {
    this.assertPrivacyAvailable();
    const p = this.proposals.get(id);
    if (!p || p.status !== 'pending') return p;
    if (Date.now() - p.createdAt >= this.profileOf(p.profileId).policy.timeoutMs) {
      const out = transition(p, 'expired');
      this.proposals.set(id, out);
      await this.opts.audit.append({ actor: 'system', action: 'proposal.expired', resource: p.toolName, decision: 'expired', sessionId: p.sessionId });
      return this.proposals.get(id) ?? out;
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
        out.decisionNote = this.opts.audit.redactText(reason);
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
    return this.cancelMatching((proposal) => proposal.sessionId === sessionId, reason);
  }

  async cancelTask(taskId: string, reason: string): Promise<Proposal[]> {
    return this.cancelMatching((proposal) => proposal.taskId === taskId, reason);
  }

  private async cancelMatching(matches: (proposal: Proposal) => boolean, reason: string): Promise<Proposal[]> {
    this.assertPrivacyAvailable();
    const cancelled: string[] = [];
    for (const [id, proposal] of [...this.proposals]) {
      if (!matches(proposal) || proposal.status !== 'pending') continue;
      const out = transition(proposal, 'denied');
      out.decisionBy = 'system:task-revoked';
      out.decisionNote = this.opts.audit.redactText(reason);
      this.proposals.set(out.id, out);
      cancelled.push(id);
      await this.opts.audit.append({
        actor: 'system',
        action: 'proposal.cancelled',
        resource: out.toolName,
        payloadSummary: reason,
        decision: 'denied',
        sessionId: out.sessionId,
      });
    }
    return cancelled.map((id) => this.proposals.get(id)).filter((proposal): proposal is Proposal => !!proposal);
  }

  /**
   * Replay only unfinished proposal/listener pairs. The delivered set makes a
   * retry idempotent, while comparing with the current listener set picks up
   * listeners registered after the original invalidation was queued.
   */
  private replayPendingInvalidations(only?: ReadonlySet<string>): void {
    const errors: unknown[] = [];
    let pending = false;
    const entries = only === undefined
      ? [...this.pendingInvalidations]
      : [...only].flatMap((id) => {
        const notification = this.pendingInvalidations.get(id);
        return notification ? [[id, notification] as const] : [];
      });
    for (const [id, notification] of entries) {
      for (const listener of [...this.invalidationListeners]) {
        if (!this.invalidationListeners.has(listener) || notification.deliveredListeners.has(listener)) continue;
        try {
          listener(notification.proposal);
          notification.deliveredListeners.add(listener);
        } catch (error) {
          errors.push(error);
        }
      }
      if ([...this.invalidationListeners].every((listener) => notification.deliveredListeners.has(listener))) {
        this.pendingInvalidations.delete(id);
      } else {
        pending = true;
      }
    }
    if (errors.length) throw new AggregateError(errors, 'approval invalidation listeners failed');
    if (pending) throw new Error('approval invalidation listeners changed during notification');
  }

  redactTexts(texts: string[]): number {
    if (!texts.some((text) => text.length > 0)) {
      this.assertPrivacyAvailable();
      return 0;
    }
    const errors: unknown[] = [];
    // A non-empty retry first attempts the saved notifications. Failure is
    // collected rather than thrown immediately so new audit patterns still get
    // their mandatory registration and proposal cleanup pass below.
    try { this.replayPendingInvalidations(); } catch (error) { errors.push(error); }
    let changed = 0;
    try {
      this.opts.audit.redactTexts(texts);
      const newlyQueued = new Set<string>();
      for (const [id, proposal] of this.proposals) {
        const safe = this.opts.audit.redactValue(proposal);
        if (!safe.redacted) continue;
        const safeProposal = safe.value as Proposal;
        const next: Proposal = { ...safeProposal, payloadHash: hashPayload(safeProposal.payload), privacyRedacted: true };
        this.proposals.set(id, next);
        const pending = this.pendingInvalidations.get(id);
        if (pending) {
          // Keep one in-flight invalidation per proposal. Already acknowledged
          // listeners need not see the same invalidation again; unfinished and
          // newly registered listeners receive the latest canonical object.
          pending.proposal = next;
        } else {
          this.pendingInvalidations.set(id, { proposal: next, deliveredListeners: new Set() });
          newlyQueued.add(id);
        }
        changed += 1;
      }
      try { this.replayPendingInvalidations(newlyQueued); } catch (error) { errors.push(error); }
    } catch (error) {
      errors.push(error);
    }
    if (errors.length || this.pendingInvalidations.size) {
      this.privacyBlocked = 'approval privacy cleanup incomplete';
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'approval privacy cleanup failed');
      throw new Error('approval invalidation notifications remain pending');
    }
    this.privacyBlocked = undefined;
    return changed;
  }

  onProposalInvalidated(listener: InvalidationListener): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  get(id: string) {
    this.assertPrivacyAvailable();
    return this.proposals.get(id);
  }
  listPending() {
    this.assertPrivacyAvailable();
    return [...this.proposals.values()].filter((p) => p.status === 'pending');
  }
}
