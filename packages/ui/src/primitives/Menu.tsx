import { useEffect, type ReactNode } from 'react';

export function Menu({ open, onClose, children }: { open: boolean; onClose(): void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return <div className="ui-menu" role="menu">{children}</div>;
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
