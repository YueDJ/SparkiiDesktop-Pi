import { useState } from 'react';
import { TextArea } from '../primitives/TextArea.js';
import { Button } from '../primitives/Button.js';
import { ModelEffortControl, type ModelEffortProps } from './ModelEffortControl.js';

export interface ChatComposerProps {
  busy: boolean;
  workspacePath: string | null;
  workspaceKind: 'auto' | 'user';
  onChooseWorkspace(): void;
  onClearWorkspace(): void;
  modelProps: ModelEffortProps;
  onSend(text: string): void;
  onStop(): void;
}

export function ChatComposer({ busy, workspacePath, workspaceKind, onChooseWorkspace, onClearWorkspace, modelProps, onSend, onStop }: ChatComposerProps) {
  const [draft, setDraft] = useState('');
  const send = () => { const text = draft.trim(); if (!text || busy) return; onSend(text); setDraft(''); };
  return (
    <div className="ui-composer">
      <div className="ui-composer-input-row">
        <TextArea className="ui-composer-input" data-testid="composer-input" rows={3} placeholder="输入消息，Ctrl+Enter 发送" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }} />
        <Button variant="primary" size="lg" className="ui-composer-send" data-testid="composer-send" onClick={busy ? onStop : send}>{busy ? '停止' : '发送'}</Button>
      </div>
      <div className="ui-composer-controls">
        <div className="ui-composer-workspace">
          <span>工作区</span>
          <span className="ui-composer-path" data-testid="workspace-path" title={workspacePath ?? ''}>{workspacePath ?? '（首次写操作时生成）'}</span>
          <Button size="sm" onClick={onChooseWorkspace}>选择文件夹</Button>
          {workspaceKind === 'user' && <Button size="sm" data-testid="workspace-clear" onClick={onClearWorkspace}>清除</Button>}
        </div>
        <ModelEffortControl {...modelProps} />
      </div>
    </div>
  );
}
