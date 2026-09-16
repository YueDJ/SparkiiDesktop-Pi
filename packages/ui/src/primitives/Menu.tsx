import { useLayoutEffect, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useFocusScope } from './useFocusScope.js';
import {
  computeMenuPosition,
  readMenuGap,
  type MenuAlign,
  type MenuPlacement,
  type MenuPosition,
} from './menu-placement.js';

export {
  computeMenuPosition,
  readMenuGap,
  MENU_GAP_FALLBACK_PX,
  MENU_GAP_TOKEN,
} from './menu-placement.js';
export type { MenuAlign, MenuPlacement, MenuPosition } from './menu-placement.js';

function menuStyle(coords: MenuPosition): CSSProperties {
  return {
    top: coords.top,
    bottom: coords.bottom,
    left: coords.left,
    maxHeight: coords.maxHeight,
    maxWidth: coords.maxWidth,
  };
}

export function Menu({
  open,
  onClose,
  children,
  containerRef,
  placement = 'bottom',
  align = 'end',
}: {
  open: boolean;
  onClose(): void;
  children: ReactNode;
  containerRef?: RefObject<HTMLElement | null>;
  placement?: MenuPlacement;
  align?: MenuAlign;
}) {
  const ref = useFocusScope<HTMLDivElement>(open, onClose);
  const [coords, setCoords] = useState<MenuPosition | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target)) return;
      if (containerRef?.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, onClose, containerRef]);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    if (!containerRef) return;

    const update = () => {
      const menu = ref.current;
      const anchor = containerRef.current;
      if (!menu || !anchor) return;
      const next = computeMenuPosition({
        anchor: anchor.getBoundingClientRect(),
        menuWidth: menu.offsetWidth,
        menuHeight: menu.offsetHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        gap: readMenuGap(menu),
        preferredPlacement: placement,
        preferredAlign: align,
      });
      setCoords((current) => (
        current
        && current.top === next.top
        && current.bottom === next.bottom
        && current.left === next.left
        && current.maxHeight === next.maxHeight
        && current.maxWidth === next.maxWidth
        && current.placement === next.placement
        && current.align === next.align
          ? current
          : next
      ));
    };

    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    if (containerRef.current) observer?.observe(containerRef.current);
    if (ref.current) observer?.observe(ref.current);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [open, containerRef, placement, align, children]);

  if (!open) return null;

  if (containerRef) {
    return createPortal(
      <div
        ref={ref}
        className="ui-menu ui-menu--fixed"
        role="menu"
        tabIndex={-1}
        data-placement={coords?.placement ?? placement}
        data-align={coords?.align ?? align}
        style={coords ? menuStyle(coords) : { visibility: 'hidden' }}
      >
        {children}
      </div>,
      document.body,
    );
  }

  return (
    <div
      ref={ref}
      className={`ui-menu ui-menu--${placement}`}
      role="menu"
      tabIndex={-1}
      data-placement={placement}
      data-align={align}
    >
      {children}
    </div>
  );
}

export function MenuItem({ label, hint, onSelect, trailing = '›', testId, disabled, current }: { label: string; hint?: string; onSelect(): void; trailing?: ReactNode; testId?: string; disabled?: boolean; current?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      className="ui-menu-item"
      data-testid={testId}
      data-current={current || undefined}
      disabled={disabled}
      onClick={() => { if (!disabled) onSelect(); }}
    >
      <span>{label}</span>
      {hint && <span className="ui-menu-item-hint">{hint}</span>}
      <span className="ui-menu-item-chevron">{trailing}</span>
    </button>
  );
}
