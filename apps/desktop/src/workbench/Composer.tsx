import { useState } from 'react';

export interface ComposerProps {
  busy: boolean;
  models: string[];
  defaultModel: string | null;
  model: string | null;
  onModelChange(model: string | null): void;
  workspacePath: string | null;
  workspaceKind: 'auto' | 'user';
  onChooseWorkspace(): void;
  onClearWorkspace(): void;
  onSend(text: string): void;
  onStop(): void;
}

export function Composer(props: ComposerProps) {
  const [draft, setDraft] = useState('');
  const send = () => {
    const text = draft.trim();
    if (!text || props.busy) return;
    props.onSend(text);
    setDraft('');
  };

  return (
    <div className="composer">
      <div className="composer-row ws-row">
        <span className="muted">工作区</span>
        <span className="ws-path" data-testid="workspace-path" title={props.workspacePath ?? ''}>
          {props.workspacePath ?? '（首次写操作时生成）'}
        </span>
        <button type="button" className="btn sm" onClick={props.onChooseWorkspace}>选择文件夹</button>
        {props.workspaceKind === 'user' && (
          <button type="button" className="btn sm" data-testid="workspace-clear" onClick={props.onClearWorkspace}>清除</button>
        )}
      </div>
      <div className="composer-row">
        <select
          className="model-select"
          data-testid="model-select"
          value={props.model ?? ''}
          onChange={(e) => props.onModelChange(e.target.value || null)}
        >
          <option value="">默认（跟随配置）{props.defaultModel ? ` · ${props.defaultModel}` : ''}</option>
          {props.models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      <div className="composer-row">
        <textarea
          className="field composer-input"
          data-testid="composer-input"
          rows={3}
          placeholder="输入消息，Ctrl+Enter 发送"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button type="button" className="btn primary composer-send" data-testid="composer-send" onClick={props.busy ? props.onStop : send}>
          {props.busy ? '停止' : '发送'}
        </button>
      </div>
    </div>
  );
}
