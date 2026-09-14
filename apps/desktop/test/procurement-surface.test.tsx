import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
