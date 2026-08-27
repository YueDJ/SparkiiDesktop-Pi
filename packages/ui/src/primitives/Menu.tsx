import { useEffect, type ReactNode, type RefObject } from 'react';
import { useFocusScope } from './useFocusScope.js';

export function Menu({ open, onClose, children, containerRef }: { open: boolean; onClose(): void; children: ReactNode; containerRef?: RefObject<HTMLElement | null> }) {
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
  return <div ref={ref} className="ui-menu" role="menu" tabIndex={-1}>{children}</div>;
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
