import type { ComponentType } from 'react';
import { Button, Card, Tag } from '@sparkii/ui';

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
    <div className="ui-toolbar">
      <Button data-testid={props.id} onClick={() => props.onAction('documents.upload')}>选择合同</Button>
      {files.map((f, i) => <Tag key={i}><span data-testid={`${props.id}-selected`}>{String(f)}</span></Tag>)}
    </div>
  );
}
function ActionButton(props: WidgetProps) {
  return <Button variant="primary" data-testid={props.id} onClick={() => props.onAction(props.action ?? '')}>{props.id}</Button>;
}
function Table(props: WidgetProps) {
  const value = getByPath(props.state, props.bind);
  const rows = Array.isArray(value) ? value : value !== undefined ? [value] : [];
  return (
    <Card>
      <table>
        {rows.map((r, i) => (
          <tr key={i}>
            {r && typeof r === 'object'
              ? Object.values(r as Record<string, unknown>).map((v, j) => <td key={j}>{String(v)}</td>)
              : <td>{String(r)}</td>}
          </tr>
        ))}
      </table>
    </Card>
  );
}
function DocPreview(props: WidgetProps) {
  return <Card><pre>{JSON.stringify(getByPath(props.state, props.bind), null, 2)}</pre></Card>;
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
