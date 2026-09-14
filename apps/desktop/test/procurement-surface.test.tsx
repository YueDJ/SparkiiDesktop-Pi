import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ProcurementSurface from '../agents/procurement-review/surface/index.js';
import { canStartFull, canStartThin } from '../agents/procurement-review/surface/pack.js';

expect.extend({
  toBeDisabled(received: unknown) {
    const disabled = Boolean((received as { disabled?: boolean } | null)?.disabled);
    return {
      pass: disabled,
      message: () => `expected element ${disabled ? 'not ' : ''}to be disabled`,
    };
  },
});

const empty = { planReady: false, qtyReady: false, priceReady: false, timeReady: false, policyKb: 'default' as const };

describe('pack gates', () => {
  it('allows thin when plan is ready; full when plan plus any fact dim', () => {
    expect(canStartThin(empty)).toBe(false);
    expect(canStartFull(empty)).toBe(false);
    expect(canStartThin({ ...empty, planReady: true })).toBe(true);
    expect(canStartFull({ ...empty, planReady: true })).toBe(false);
    expect(canStartFull({ ...empty, planReady: true, qtyReady: true })).toBe(true);
    expect(canStartFull({ ...empty, planReady: true, priceReady: true })).toBe(true);
  });

  it('disables start buttons without a plan and keeps pull disabled', () => {
    render(<ProcurementSurface
      sessionId={null} mode="live" title=""
      session={{ entries: [], streaming: false, status: 'idle', meta: { currentStep: null } }}
      actions={{} as any}
      agent={{ id: 'procurement-review', name: 'procurement-review', surfaceType: 'workflow' }}
    />);
    expect(screen.getByRole('button', { name: '开始分析' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '完整性审核' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /从 OA 获取/ })).toBeDisabled();
  });
});

const evaluation = {
  lines: [{ id: 'M-煤', code: 'RM-001', name: '烟煤', qty: 2800, unit: '吨', unitPrice: 920, stockQty: 4200, usageQty: 2100, medianPrice: null, dealCount: 0, transitQty: null, transitRef: null, qtyOpen: true, priceOpen: false, timeOpen: false }],
  hits: [{ id: 'h1', rowId: 'M-煤', dim: 'qty', level: 'high', ruleId: 'qty.over-cover', metrics: { coverMonths: 10 }, cite: { label: '覆盖>4个月', refs: [] } }],
  closed: { qty: false, price: true, time: true, compliance: false },
  conflicts: [],
};
const findingsJson = {
  findings: [
    { id: 'r1', rowId: 'M-煤', dim: 'qty', level: 'high', title: '烟煤可覆盖约 10 个月', reason: '超过 4 个月', advice: '核减', cite: { label: '覆盖>4个月' }, hitId: 'h1' },
    { id: 'c1', rowId: 'M-煤', dim: 'compliance', level: 'mid', title: '烟煤单行金额超集采线', reason: '超 200 万', advice: '补说明', cite: { label: '《采购管理办法》第12条' }, hitId: '' },
  ],
};
const session = {
  entries: [
    { id: 'e0', kind: 'custom', customType: 'workflow_state', data: { action: 'evaluation', payload: evaluation } },
    { id: 'e1', kind: 'custom', customType: 'workflow_step_end', data: { stepId: 'review', status: 'ok', output: findingsJson } },
  ],
  streaming: false,
  status: 'done',
  meta: { currentStep: 'report' },
};

describe('analyze and review workbench', () => {
  it('hides adopt on analyze and blocks export while high risk is open', async () => {
    const review = vi.fn();
    render(<ProcurementSurface sessionId="s1" mode="live" title="" session={session as any} actions={{ review } as any} agent={{ id: 'procurement-review', name: 'procurement-review', surfaceType: 'workflow' }} />);
    expect(screen.queryByRole('button', { name: '采纳' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '进入复核' }));
    expect(screen.getByRole('button', { name: '导出' })).toBeDisabled();
    fireEvent.click(screen.getAllByRole('button', { name: '采纳' })[0]);
    expect(review).toHaveBeenCalledWith('risk_confirmed', { stepId: 'review', payload: { riskId: 'r1' } });
  });

  it('renders compliance as a sibling column not a full-width strip', () => {
    const { container } = render(<ProcurementSurface sessionId="s1" mode="live" title="" session={session as any} actions={{} as any} agent={{ id: 'procurement-review', name: 'procurement-review', surfaceType: 'workflow' }} />);
    const conds = container.querySelector('.conds');
    const rule = container.querySelector('.rule-bar');
    expect(rule && conds?.contains(rule) && rule.parentElement === conds).toBe(true);
  });
});
