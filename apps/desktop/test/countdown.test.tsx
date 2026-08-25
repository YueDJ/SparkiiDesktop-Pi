import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { Countdown } from '../src/trust/Countdown.js';

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Countdown', () => {
  it('shows remaining seconds and ticks down', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    render(<Countdown until={1_000_000 + 60_000} />);
    expect(document.body.textContent).toContain('60s');
    act(() => { vi.advanceTimersByTime(1000); });
    expect(document.body.textContent).toContain('59s');
  });

  it('fires onExpire when time runs out', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const onExpire = vi.fn();
    render(<Countdown until={1_000_000 + 2_000} onExpire={onExpire} />);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
