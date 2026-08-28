import { useEffect, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useFocusScope } from './useFocusScope.js';

export function Menu({ open, onClose, children, containerRef, placement = 'bottom' }: { open: boolean; onClose(): void; children: ReactNode; containerRef?: RefObject<HTMLElement | null>; placement?: 'top' | 'bottom' }) {
  const ref = useFocusScope<HTMLDivElement>(open, onClose);

  useEffect(() => {
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

  if (!open) return null;

  const anchor = containerRef?.current;
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    const gap = 6;
    const right = Math.max(0, window.innerWidth - rect.right);
    const style = placement === 'top'
      ? { bottom: window.innerHeight - rect.top + gap, right }
      : { top: rect.bottom + gap, right };
    return createPortal(
      <div ref={ref} className="ui-menu ui-menu--fixed" role="menu" tabIndex={-1} style={style}>{children}</div>,
      document.body,
    );
  }

  return <div ref={ref} className={`ui-menu ui-menu--${placement}`} role="menu" tabIndex={-1}>{children}</div>;
}

export function MenuItem({ label, hint, onSelect, trailing = '›' }: { label: string; hint?: string; onSelect(): void; trailing?: ReactNode }) {
  return (
    <button type="button" role="menuitem" className="ui-menu-item" onClick={onSelect}>
      <span>{label}</span>
      {hint && <span className="ui-menu-item-hint">{hint}</span>}
      <span className="ui-menu-item-chevron">{trailing}</span>
    </button>
  );
}
