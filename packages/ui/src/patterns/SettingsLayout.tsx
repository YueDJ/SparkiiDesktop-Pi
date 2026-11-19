import type { ReactNode } from 'react';

export function SettingsLayout({ nav, children }: { nav: ReactNode; children: ReactNode }) {
  return (
    <div className="ui-settings-layout">
      <aside className="ui-settings-nav" aria-label="设置分类">{nav}</aside>
      <section className="ui-settings-content">{children}</section>
    </div>
  );
}

export function SettingsNavGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ui-settings-nav-group">
      <div className="ui-settings-nav-label">{label}</div>
      <div className="ui-settings-nav-items">{children}</div>
    </div>
  );
}

export function SettingsNavItem({ label, active, onClick }: { label: string; active: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      className={`ui-settings-nav-item${active ? ' is-active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
