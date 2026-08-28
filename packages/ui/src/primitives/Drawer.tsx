import type { ReactNode } from 'react';
import { useFocusScope } from './useFocusScope.js';

export function Drawer({ open, title, onClose, children, fixed = false, className = '' }: { open: boolean; title: string; onClose(): void; children: ReactNode; fixed?: boolean; className?: string }) {
  const ref = useFocusScope<HTMLElement>(open, onClose);
  if (!open) return null;
  return (
    <>
      <button type="button" className={`ui-drawer-backdrop ${fixed ? 'fixed' : ''}`} data-testid="drawer-backdrop" aria-label="关闭面板" onClick={onClose} />
      <aside ref={ref} className={`ui-drawer ${fixed ? 'fixed' : ''} ${className}`} role="dialog" aria-label={title}>
        <div className="ui-drawer-head"><span>{title}</span><button type="button" className="ui-icon-btn" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="ui-drawer-body">{children}</div>
      </aside>
    </>
  );
}
