import { useEffect, useRef, type ReactNode } from 'react';

export function Drawer({ open, title, onClose, children, fixed = false }: { open: boolean; title: string; onClose(): void; children: ReactNode; fixed?: boolean }) {
  const prevFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    prevFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prevFocus.current?.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <button type="button" className={`ui-drawer-backdrop ${fixed ? 'fixed' : ''}`} data-testid="drawer-backdrop" aria-label="关闭面板" onClick={onClose} />
      <aside className={`ui-drawer ${fixed ? 'fixed' : ''}`} role="dialog" aria-label={title}>
        <div className="ui-drawer-head"><span>{title}</span><button type="button" className="ui-icon-btn" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="ui-drawer-body">{children}</div>
      </aside>
    </>
  );
}
