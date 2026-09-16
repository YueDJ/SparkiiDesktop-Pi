import { describe, it, expect } from 'vitest';
import { computeMenuPosition, MENU_GAP_FALLBACK_PX, MENU_GAP_TOKEN } from '@sparkii/ui';

const gap = MENU_GAP_FALLBACK_PX;

function pos(over: Parameters<typeof computeMenuPosition>[0] extends infer T ? Partial<T> : never) {
  return computeMenuPosition({
    anchor: { top: 40, right: 200, bottom: 72, left: 80 },
    menuWidth: 220,
    menuHeight: 120,
    viewportWidth: 1024,
    viewportHeight: 768,
    gap,
    preferredPlacement: 'bottom',
    preferredAlign: 'start',
    ...over,
  });
}

describe('computeMenuPosition', () => {
  it('uses the theme spacing-xs token for the gap', () => {
    expect(MENU_GAP_TOKEN).toBe('--spacing-xs');
    expect(MENU_GAP_FALLBACK_PX).toBe(8);
  });

  it('opens down from the top and up from the bottom', () => {
    const down = pos({
      anchor: { top: 24, right: 220, bottom: 56, left: 80 },
      preferredPlacement: 'bottom',
    });
    expect(down.placement).toBe('bottom');
    expect(down.top).toBe(56 + gap);

    const up = pos({
      anchor: { top: 700, right: 220, bottom: 732, left: 80 },
      viewportHeight: 768,
      preferredPlacement: 'bottom',
    });
    expect(up.placement).toBe('top');
    expect(up.bottom).toBe(768 - 700 + gap);
    expect(up.top).toBeUndefined();
  });

  it('honors preferred top near the bottom and flips down near the top', () => {
    const keepUp = pos({
      anchor: { top: 700, right: 220, bottom: 732, left: 80 },
      preferredPlacement: 'top',
    });
    expect(keepUp.placement).toBe('top');

    const flipDown = pos({
      anchor: { top: 24, right: 220, bottom: 56, left: 80 },
      preferredPlacement: 'top',
    });
    expect(flipDown.placement).toBe('bottom');
    expect(flipDown.top).toBe(56 + gap);
  });

  it('keeps a gap from every viewport edge, including a right-flush audit trigger', () => {
    const flushRight = pos({
      anchor: { top: 80, right: 1024, bottom: 114, left: 894 },
      menuWidth: 220,
      preferredAlign: 'start',
      viewportWidth: 1024,
    });
    expect(flushRight.left).toBe(1024 - 220 - gap);
    expect(flushRight.left + 220).toBeLessThanOrEqual(1024 - gap);
    expect(flushRight.left).toBeGreaterThanOrEqual(gap);
    expect(flushRight.maxWidth).toBe(1024 - gap * 2);

    const flushLeft = pos({
      anchor: { top: 80, right: 40, bottom: 114, left: 0 },
      preferredAlign: 'end',
      viewportWidth: 1024,
    });
    expect(flushLeft.left).toBe(gap);
  });
});
