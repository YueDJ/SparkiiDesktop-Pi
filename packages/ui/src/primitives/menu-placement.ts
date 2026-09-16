/** Trigger-to-menu gap. Theme: spacing.xs = 8px. */
export const MENU_TRIGGER_GAP_TOKEN = '--spacing-xs';
export const MENU_TRIGGER_GAP_FALLBACK_PX = 8;

/** Inset from every viewport edge. Theme: spacing.md = 16px (same as the error toast). */
export const MENU_VIEWPORT_GAP_TOKEN = '--spacing-md';
export const MENU_VIEWPORT_GAP_FALLBACK_PX = 16;

export const MENU_GAP_TOKEN = MENU_VIEWPORT_GAP_TOKEN;
export const MENU_GAP_FALLBACK_PX = MENU_VIEWPORT_GAP_FALLBACK_PX;

export type MenuPlacement = 'top' | 'bottom';
export type MenuAlign = 'start' | 'end';

export interface MenuPosition {
  top?: number;
  bottom?: number;
  left: number;
  maxHeight: number;
  maxWidth: number;
  placement: MenuPlacement;
  align: MenuAlign;
}

export function readCssPx(token: string, fallback: number, node?: Element | null): number {
  const source = node ?? (typeof document === 'undefined' ? null : document.documentElement);
  if (!source) return fallback;
  const raw = getComputedStyle(source).getPropertyValue(token).trim();
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function readMenuGap(node?: Element | null): number {
  return readCssPx(MENU_VIEWPORT_GAP_TOKEN, MENU_VIEWPORT_GAP_FALLBACK_PX, node);
}

export function readMenuTriggerGap(node?: Element | null): number {
  return readCssPx(MENU_TRIGGER_GAP_TOKEN, MENU_TRIGGER_GAP_FALLBACK_PX, node);
}

export function viewportSize(): { width: number; height: number } {
  const root = typeof document === 'undefined' ? null : document.documentElement;
  return {
    width: root?.clientWidth || window.innerWidth,
    height: root?.clientHeight || window.innerHeight,
  };
}

export function computeMenuPosition(input: {
  anchor: Pick<DOMRect, 'top' | 'right' | 'bottom' | 'left'>;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  gap: number;
  edge?: number;
  preferredPlacement: MenuPlacement;
  preferredAlign: MenuAlign;
}): MenuPosition {
  const { anchor, viewportWidth, viewportHeight, preferredPlacement, preferredAlign } = input;
  const triggerGap = input.gap;
  const edge = input.edge ?? input.gap;
  const maxWidth = Math.max(0, viewportWidth - edge * 2);
  const width = Math.min(input.menuWidth > 0 ? input.menuWidth : 220, maxWidth || input.menuWidth || 220);

  const spaceBelow = viewportHeight - anchor.bottom - triggerGap;
  const spaceAbove = anchor.top - triggerGap;

  let placement = preferredPlacement;
  if (input.menuHeight > 0) {
    if (preferredPlacement === 'bottom' && spaceBelow < input.menuHeight && spaceAbove > spaceBelow) {
      placement = 'top';
    } else if (preferredPlacement === 'top' && spaceAbove < input.menuHeight && spaceBelow > spaceAbove) {
      placement = 'bottom';
    }
  }

  const available = placement === 'bottom' ? spaceBelow : spaceAbove;
  const maxHeight = Math.max(0, available - edge);

  let left = preferredAlign === 'start' ? anchor.left : anchor.right - width;
  let align = preferredAlign;
  if (left + width > viewportWidth - edge) {
    const flipped = anchor.right - width;
    if (flipped >= edge) {
      left = flipped;
      align = 'end';
    }
  }
  if (left < edge) {
    const flipped = anchor.left;
    if (flipped + width <= viewportWidth - edge) {
      left = flipped;
      align = 'start';
    }
  }
  left = Math.min(Math.max(left, edge), Math.max(edge, viewportWidth - width - edge));

  return placement === 'bottom'
    ? { top: anchor.bottom + triggerGap, left, maxHeight, maxWidth, placement, align }
    : { bottom: viewportHeight - anchor.top + triggerGap, left, maxHeight, maxWidth, placement, align };
}
