import type { ReactNode } from 'react';
export function SettingsRow({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <div className="ui-settings-row"><span>{label}</span>{children}{hint && <span className="ui-muted">{hint}</span>}</div>;
}
