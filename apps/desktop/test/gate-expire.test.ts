import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { ApprovalGate, AuditStore } from '@sparkii/approval';

const stores: AuditStore[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));

function fresh(): { audit: AuditStore; gate: ApprovalGate } {
  const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'g4-gate-')), 'a.db'));
  stores.push(audit);
  return { audit, gate: new ApprovalGate({ audit }) };
}

function submit(gate: ApprovalGate, sessionId: string, requestId: string) {
  return gate.submit(
    { requestId, toolName: 'report.export', targetSystem: 'report', summary: requestId, payload: {}, risk: 'write' },
    { profileId: 'p', sessionId, actor: 'agent' },
  );
}

describe('ApprovalGate.abortPendingForQuit（§7.7 步骤 2 显式过期）', () => {
  it('expires every pending proposal, writes one audit event each, returns the count', async () => {
    const { audit, gate } = fresh();
    const a = await submit(gate, 's1', 'r1');
    const b = await submit(gate, 's2', 'r2');
    const c = await submit(gate, 's3', 'r3');

    const n = await gate.abortPendingForQuit('update-install');
    expect(n).toBe(3);
    for (const p of [a, b, c]) {
      expect(gate.get(p.id)?.status).toBe('expired');
      expect(gate.get(p.id)?.decisionBy).toBe('system:update-install');
      expect(gate.get(p.id)?.decisionNote).toBe('update-install');
    }

    const events = await audit.query({ action: 'update.install-abort' });
    expect(events).toHaveLength(3); // 审计事件数 == 提案数
    expect(events.every((e) =>
      e.actor === 'system'
      && e.decision === 'expired'
      && e.payloadSummary === 'update-install'
      && typeof e.sessionId === 'string'
      && e.resource === 'report.export'
    )).toBe(true);
    expect(gate.listPending()).toEqual([]);
  });

  it('returns 0 on a repeated call and does not append more audit events', async () => {
    const { audit, gate } = fresh();
    await submit(gate, 's1', 'r1');
    await submit(gate, 's2', 'r2');

    expect(await gate.abortPendingForQuit('update-install')).toBe(2);
    expect(await gate.abortPendingForQuit('update-install')).toBe(0);
    expect(await audit.query({ action: 'update.install-abort' })).toHaveLength(2);
  });

  it('does not affect non-pending proposals', async () => {
    const { audit, gate } = fresh();
    const pending = await submit(gate, 's1', 'r1');
    const denied = await submit(gate, 's2', 'r2');
    await gate.cancelSession('s2', 'task-revoked'); // 变为 denied（非 pending）

    expect(await gate.abortPendingForQuit('update-install')).toBe(1);
    expect(gate.get(pending.id)?.status).toBe('expired');
    expect(gate.get(denied.id)?.status).toBe('denied');
    expect(gate.get(denied.id)?.decisionBy).toBe('system:task-revoked');
    expect(await audit.query({ action: 'update.install-abort' })).toHaveLength(1);
  });

  it('does not return success before every audit write completes', async () => {
    const writes: string[] = [];
    // 慢速 append：若实现漏 await，方法会在写满 3 条前就 resolve。
    const slowAudit = {
      append: async (ev: { action: string }) => {
        await new Promise((r) => setTimeout(r, 5));
        writes.push(ev.action);
      },
    } as unknown as AuditStore;
    const gate = new ApprovalGate({ audit: slowAudit });
    for (let i = 0; i < 3; i += 1) await submit(gate, `s${i}`, `r${i}`);

    expect(writes.filter((a) => a === 'update.install-abort')).toHaveLength(0);
    expect(await gate.abortPendingForQuit('update-install')).toBe(3);
    expect(writes.filter((a) => a === 'update.install-abort')).toHaveLength(3);
    expect(gate.listPending()).toHaveLength(0);
  });

  // m10：shutdown 顺序是 abortPendingApprovals → stopPool；两者之间 agent 进程仍活着，
  // 原先还能 submit 一条新提案逃过 expire + 审计。现在 abortPendingForQuit 同时关闸。
  it('m10：abort 之后到达的 submit 一律 SHUTTING_DOWN，且不产生提案 / 审计', async () => {
    const { audit, gate } = fresh();
    await submit(gate, 's1', 'r1');
    expect(await gate.abortPendingForQuit('update-install')).toBe(1);
    const createdBefore = (await audit.query({ action: 'proposal.created' })).length;

    await expect(submit(gate, 's1', 'late')).rejects.toMatchObject({ code: 'SHUTTING_DOWN' });
    expect(gate.listPending()).toEqual([]);
    expect((await audit.query({ action: 'proposal.created' })).length).toBe(createdBefore);
  });

  it('m10：abort 逐条写审计的 await 期间到达的 submit 同样被拒（窗口内也关闸）', async () => {
    const writes: string[] = [];
    const slowAudit = {
      append: async (ev: { action: string }) => {
        await new Promise((r) => setTimeout(r, 5));
        writes.push(ev.action);
      },
    } as unknown as AuditStore;
    const gate = new ApprovalGate({ audit: slowAudit });
    await submit(gate, 's0', 'r0');
    const aborting = gate.abortPendingForQuit('update-install');
    // 闸门在 abort 的同步段就关闭了 ⇒ 不等 abort 完成就会拒绝。
    await expect(submit(gate, 's9', 'late')).rejects.toMatchObject({ code: 'SHUTTING_DOWN' });
    expect(await aborting).toBe(1);
  });

  // m10 的配套：abort 失败时安装事务可能走「可逆」分支、应用继续运行。
  // 若闸门不重开，之后所有审批都会永久 SHUTTING_DOWN（比一次失败的清理严重得多）。
  it('m10：abort 中途抛错 ⇒ 闸门重开，后续 submit 仍可用', async () => {
    let calls = 0;
    const flakyAudit = {
      append: async () => {
        calls += 1;
        if (calls === 2) throw new Error('audit disk full');   // 第 1 次是 submit 的 proposal.created
      },
    } as unknown as AuditStore;
    const gate = new ApprovalGate({ audit: flakyAudit });
    await submit(gate, 's1', 'r1');
    await expect(gate.abortPendingForQuit('update-install')).rejects.toThrow(/disk full/);
    // 失败后：闸门重开，新提案可以正常提交（已过期的那条保持 expired，不回滚）。
    const p = await submit(gate, 's2', 'r2');
    expect(p.status).toBe('pending');
    expect(gate.listPending().map((x) => x.id)).toEqual([p.id]);
  });
});
