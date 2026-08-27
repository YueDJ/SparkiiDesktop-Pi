import { Button } from '../primitives/Button.js';
import { TextField } from '../primitives/TextField.js';

export interface SessionListItem { id: string; name: string; state?: string; time?: string; active?: boolean; }
export interface SessionListProps {
  sessions: SessionListItem[];
  onNew(): void;
  onOpen(id: string): void;
  onRename?(id: string): void;
  onDelete?(id: string): void;
  renamingId?: string | null;
  renameDraft?: string;
  onRenameChange?(value: string): void;
  onRenameCommit?(id: string): void;
  onRenameCancel?(): void;
}

export function SessionList({ sessions, onNew, onOpen, onRename, onDelete, renamingId = null, renameDraft = '', onRenameChange, onRenameCommit, onRenameCancel }: SessionListProps) {
  return (
    <div className="ui-session-list">
      <Button variant="primary" className="ui-btn--block" onClick={onNew}>+ 新会话</Button>
      {sessions.map((s) => (
        <div key={s.id} className={`ui-list-row ${s.active ? 'current' : ''}`} onClick={() => onOpen(s.id)}>
          {renamingId === s.id ? (
            <TextField
              className="ui-list-row-rename"
              value={renameDraft}
              autoFocus
              onChange={(e) => onRenameChange?.(e.target.value)}
              onBlur={() => onRenameCommit?.(s.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onRenameCommit?.(s.id);
                if (e.key === 'Escape') onRenameCancel?.();
              }}
            />
          ) : (
            <>
              <span>{s.name} {s.state}</span>
              {onRename && <button type="button" className="ui-icon-btn ui-btn--sm" title={`重命名 ${s.id}`} onClick={(e) => { e.stopPropagation(); onRename(s.id); }}>✎</button>}
              {onDelete && <button type="button" className="ui-icon-btn ui-btn--sm" title={`删除 ${s.id}`} onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}>✕</button>}
            </>
          )}
          <span className="ui-list-row-hint">{s.time}</span>
        </div>
      ))}
    </div>
  );
}
