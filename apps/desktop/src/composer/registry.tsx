import type { ComponentType } from 'react';

export interface WidgetProps { id: string; bind?: string; action?: string; state: Record<string, unknown>; onAction(action: string): void }

export function getByPath(state: Record<string, unknown>, path: string | undefined): unknown {
  if (!path) return state;
  return path.split('.').reduce<unknown>(
    (acc, key) => (acc && typeof acc === 'object') ? (acc as Record<string, unknown>)[key] : undefined,
    state,
  );
}

function FileUpload(props: WidgetProps) {
  const value = getByPath(props.state, props.bind);
  const files = Array.isArray(value) ? value : value != null ? [value] : [];
  return (
    <div>
      <button data-testid={props.id} onClick={() => props.onAction('documents.upload')}>选择合同</button>
      {files.map((f, i) => <span key={i} data-testid={`${props.id}-selected`}>{String(f)}</span>)}
    </div>
  );
}
function ActionButton(props: WidgetProps) {
  return <button data-testid={props.id} onClick={() => props.onAction(props.action ?? '')}>{props.id}</button>;
}
function Table(props: WidgetProps) {
  const value = getByPath(props.state, props.bind);
  const rows = Array.isArray(value) ? value : value !== undefined ? [value] : [];
  return (
    <table>
      {rows.map((r, i) => (
        <tr key={i}>
          {r && typeof r === 'object'
            ? Object.values(r as Record<string, unknown>).map((v, j) => <td key={j}>{String(v)}</td>)
            : <td>{String(r)}</td>}
        </tr>
      ))}
    </table>
  );
}
function DocPreview(props: WidgetProps) {
  return <pre>{JSON.stringify(getByPath(props.state, props.bind), null, 2)}</pre>;
}
function ChatPanel(props: WidgetProps) {
  return <div data-testid={props.id}>chat</div>;
}
function ApprovalPanel(props: WidgetProps) {
  return <div data-testid={props.id}>approval</div>;
}

export const widgetRegistry: Record<string, ComponentType<WidgetProps>> = {
  'file-upload': FileUpload,
  'action-button': ActionButton,
  'table': Table,
  'doc-preview': DocPreview,
  'chat-panel': ChatPanel,
  'approval-panel': ApprovalPanel,
};
