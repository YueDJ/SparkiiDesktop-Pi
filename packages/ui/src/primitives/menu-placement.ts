export const MENU_GAP_TOKEN = '--spacing-xs';
export const MENU_GAP_FALLBACK_PX = 8;

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

export function readMenuGap(node?: Element | null): number {
  const source = node ?? (typeof document === 'undefined' ? null : document.documentElement);
  if (!source) return MENU_GAP_FALLBACK_PX;
  const raw = getComputedStyle(source).getPropertyValue(MENU_GAP_TOKEN).trim();
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : MENU_GAP_FALLBACK_PX;
}

export function computeMenuPosition(input: {
  anchor: Pick<DOMRect, 'top' | 'right' | 'bottom' | 'left'>;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  gap: number;
  preferredPlacement: MenuPlacement;
  preferredAlign: MenuAlign;
}): MenuPosition {
  const { anchor, viewportWidth, viewportHeight, gap, preferredPlacement, preferredAlign } = input;
  const maxWidth = Math.max(0, viewportWidth - gap * 2);
  const width = Math.min(input.menuWidth > 0 ? input.menuWidth : 220, maxWidth || input.menuWidth || 220);

  const spaceBelow = viewportHeight - anchor.bottom - gap;
  const spaceAbove = anchor.top - gap;

  let placement = preferredPlacement;
  if (input.menuHeight > 0) {
    if (preferredPlacement === 'bottom' && spaceBelow < input.menuHeight && spaceAbove > spaceBelow) {
      placement = 'top';
    } else if (preferredPlacement === 'top' && spaceAbove < input.menuHeight && spaceBelow > spaceAbove) {
      placement = 'bottom';
    }
  }

  const available = placement === 'bottom' ? spaceBelow : spaceAbove;
  const maxHeight = Math.max(0, available - gap);

  let left = preferredAlign === 'start' ? anchor.left : anchor.right - width;
  let align = preferredAlign;
  if (left + width > viewportWidth - gap) {
    const flipped = anchor.right - width;
    if (flipped >= gap) {
      left = flipped;
      align = 'end';
    }
  }
  if (left < gap) {
    const flipped = anchor.left;
    if (flipped + width <= viewportWidth - gap) {
      left = flipped;
      align = 'start';
    }
  }
  left = Math.min(Math.max(left, gap), Math.max(gap, viewportWidth - width - gap));

  return placement === 'bottom'
    ? { top: anchor.bottom + gap, left, maxHeight, maxWidth, placement, align }
    : { bottom: viewportHeight - anchor.top + gap, left, maxHeight, maxWidth, placement, align };
}
