import type { ReactNode } from 'react';

export function SettingsRow({ label, description, htmlFor, children }: {
  label: string;
  description?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="ui-settings-row">
      <div className="ui-settings-row-text">
        <label className="ui-settings-row-label" htmlFor={htmlFor}>{label}</label>
        {description && <div className="ui-settings-row-desc">{description}</div>}
      </div>
      <div className="ui-settings-row-control">{children}</div>
    </div>
  );
}
