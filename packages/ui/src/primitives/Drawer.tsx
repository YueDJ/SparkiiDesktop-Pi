import type { ReactNode } from 'react';
import { CloseIcon } from '../icons/index.js';
import { useFocusScope } from './useFocusScope.js';

export type DrawerSize = 'md' | 'sm';

export function Drawer({ open, title, onClose, children, fixed = false, size = 'md', className = '' }: { open: boolean; title: string; onClose(): void; children: ReactNode; fixed?: boolean; size?: DrawerSize; className?: string }) {
  const ref = useFocusScope<HTMLElement>(open, onClose);
  if (!open) return null;
  return (
    <>
      <button type="button" className={`ui-drawer-backdrop ${fixed ? 'fixed' : ''}`} data-testid="drawer-backdrop" aria-label="关闭面板" onClick={onClose} />
      <aside ref={ref} className={`ui-drawer ${size === 'sm' ? 'ui-drawer--sm' : ''} ${fixed ? 'fixed' : ''} ${className}`} role="dialog" aria-label={title}>
        <div className="ui-drawer-head"><span>{title}</span><button type="button" className="ui-dismiss" aria-label="关闭" onClick={onClose}><CloseIcon /></button></div>
        <div className="ui-drawer-body">{children}</div>
      </aside>
    </>
  );
}
