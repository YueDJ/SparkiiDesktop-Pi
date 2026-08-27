import type { ReactNode } from 'react';
import { useFocusScope } from './useFocusScope.js';

export function Modal({ open, title, onClose, children }: { open: boolean; title: string; onClose(): void; children: ReactNode }) {
  const ref = useFocusScope<HTMLDivElement>(open, onClose);
  if (!open) return null;
  return (
    <div className="ui-modal-mask open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="ui-modal" role="dialog" aria-label={title}>
        <div className="ui-modal-head"><span>{title}</span><button type="button" className="ui-icon-btn" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="ui-modal-body">{children}</div>
      </div>
    </div>
  );
}
