import type { ReactNode } from 'react';
export function SettingsLayout({ nav, children }: { nav: ReactNode; children: ReactNode }) {
  return <div className="ui-settings-layout"><aside className="ui-settings-nav">{nav}</aside><section className="ui-settings-content">{children}</section></div>;
}
