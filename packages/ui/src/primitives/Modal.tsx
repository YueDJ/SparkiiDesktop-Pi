import { useEffect, useRef, type ReactNode } from 'react';

export function Modal({ open, title, onClose, children }: { open: boolean; title: string; onClose(): void; children: ReactNode }) {
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
    <div className="ui-modal-mask open">
      <div className="ui-modal" role="dialog" aria-label={title}>
        <div className="ui-modal-head"><span>{title}</span><button type="button" className="ui-icon-btn" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="ui-modal-body">{children}</div>
      </div>
    </div>
  );
}
