import type { ReactNode } from 'react';

export function SettingsPageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="ui-settings-page-head">
      <h2 className="ui-settings-page-title">{title}</h2>
      {description && <p className="ui-settings-page-desc">{description}</p>}
    </header>
  );
}

export function SettingsSection({ title, description, testId, children }: {
  title?: string;
  description?: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section className="ui-settings-section" data-testid={testId}>
      {(title || description) && (
        <header className="ui-settings-section-head">
          {title && <h3 className="ui-settings-section-title">{title}</h3>}
          {description && <p className="ui-settings-section-desc">{description}</p>}
        </header>
      )}
      <div className="ui-settings-section-body">{children}</div>
    </section>
  );
}

export function SettingsSaveBar({ dirty, saving, status, error, onSave, saveLabel = '保存', saveTestId }: {
  dirty: boolean;
  saving?: boolean;
  status?: string;
  error?: string;
  onSave(): void;
  saveLabel?: string;
  saveTestId?: string;
}) {
  const text = saving ? '保存中…' : error || (dirty ? '有未保存的更改' : status || '已保存');
  return (
    <div className={`ui-settings-savebar${dirty ? ' is-dirty' : ''}`}>
      <span className={`ui-settings-savebar-status${error ? ' is-error' : ''}`} role="status">{text}</span>
      <button
        type="button"
        className="ui-btn ui-btn--md ui-btn--primary"
        data-testid={saveTestId}
        disabled={!dirty || saving}
        onClick={onSave}
      >
        {saving ? '保存中…' : saveLabel}
      </button>
    </div>
  );
}
