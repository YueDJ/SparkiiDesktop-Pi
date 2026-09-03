import { useLayoutEffect, useRef, useState, type ChangeEvent } from 'react';
import { TextArea } from '../primitives/TextArea.js';
import { ModelEffortControl, type ModelEffortProps } from './ModelEffortControl.js';
import { PlusIcon, FolderIcon, ClipIcon, ArrowUpIcon, StopIcon } from '../icons/index.js';

export interface ComposerAttachment {
  path: string;
  name: string;
  size?: number;
  type?: string;
  previewUrl?: string;
}

export interface ContextUsage {
  tokens?: number | null;
  contextWindow?: number;
  percent?: number | null;
}

export interface ChatComposerProps {
  busy: boolean;
  stopping?: boolean;
  workspacePath: string | null;
  onChooseWorkspace(): void;
  getLocalPath?(file: File): string;
  modelProps: ModelEffortProps;
  contextUsage?: ContextUsage | null;
  isCompacting?: boolean;
  onSend(text: string, attachments: ComposerAttachment[]): void;
  onStop(): void;
}

function workspaceDisplay(path: string | null): string {
  if (!path) return '未选择工作区';
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function dirname(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  parts.pop();
  return parts[parts.length - 1] ?? path;
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function typeLabel(name: string): string {
  const ext = extOf(name);
  return ext ? ext.toUpperCase() : 'FILE';
}

type AttachmentKind = 'image' | 'word' | 'sheet' | 'pdf' | 'code' | 'file';

function attachmentKind(att: ComposerAttachment): AttachmentKind {
  if (att.type?.startsWith('image/')) return 'image';
  const ext = extOf(att.name);
  if (['doc', 'docx'].includes(ext)) return 'word';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'sheet';
  if (ext === 'pdf') return 'pdf';
  if (['ts', 'tsx', 'js', 'jsx', 'json', 'py', 'md', 'html', 'css', 'sh', 'bash', 'yaml', 'yml', 'sql', 'go', 'rs', 'java', 'c', 'cpp'].includes(ext)) return 'code';
  return 'file';
}

const KIND_GLYPH: Record<Exclude<AttachmentKind, 'image'>, string> = {
  word: 'W', sheet: 'X', pdf: 'PDF', code: '{ }', file: '',
};

function formatTokens(value: number | null | undefined): string {
  return typeof value === 'number' ? value.toLocaleString('zh-CN') : '—';
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== 'number') return '—';
  return `${Math.round(value)}%`;
}

function contextTitle(contextUsage: ContextUsage): string {
  return `上下文 ${formatTokens(contextUsage.tokens)} / ${formatTokens(contextUsage.contextWindow)} tokens`;
}

export function ContextUsageBar({
  contextUsage = null,
  isCompacting = false,
}: {
  contextUsage?: ContextUsage | null;
  isCompacting?: boolean;
}) {
  return (
    <div
      className={`ui-composer-context${isCompacting ? ' ui-composer-context--compacting' : ''}`}
      data-testid="context-bar"
      title={contextUsage ? contextTitle(contextUsage) : '上下文暂不可用'}
    >
      {isCompacting ? (
        <span className="ui-composer-context-compacting">正在压缩上下文…</span>
      ) : contextUsage ? (
        <>
          <span className="ui-composer-context-track" aria-hidden="true">
            <span style={{ width: `${Math.max(0, Math.min(100, contextUsage.percent ?? 0))}%` }} />
          </span>
          <span className="ui-composer-context-text">
            {formatTokens(contextUsage.tokens)} / {formatTokens(contextUsage.contextWindow)} · {formatPercent(contextUsage.percent)}
          </span>
        </>
      ) : (
        <span className="ui-composer-context-empty">上下文 —</span>
      )}
    </div>
  );
}

export function ChatComposer({ busy, stopping = false, workspacePath, onChooseWorkspace, getLocalPath, modelProps, contextUsage = null, isCompacting = false, onSend, onStop }: ChatComposerProps) {
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<ComposerAttachment[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const name = workspaceDisplay(workspacePath);

  const syncHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(() => { syncHeight(); }, [draft]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text, files);
    setDraft('');
    setFiles((xs) => { xs.forEach((f) => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl); }); return []; });
  };

  const pickFiles = () => inputRef.current?.click();

  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (!list) return;
    const added: ComposerAttachment[] = Array.from(list).map((f) => ({
      name: f.name,
      size: f.size,
      type: f.type,
      path: getLocalPath ? getLocalPath(f) : (f as unknown as { path?: string }).path ?? '',
      previewUrl: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
    }));
    setFiles((xs) => [...xs, ...added]);
    e.target.value = '';
  };

  const removeFile = (path: string) => {
    setFiles((xs) => xs.filter((f) => {
      if (f.path === path && f.previewUrl) URL.revokeObjectURL(f.previewUrl);
      return f.path !== path;
    }));
  };

  const sourceLabel = files.length ? dirname(files[0].path) : '';
  const hasDraft = Boolean(draft.trim());
  const canStop = busy && !hasDraft;
  const canSend = hasDraft;
  const actionDisabled = stopping || (!canStop && !canSend);

  return (
    <div className="ui-composer">
      <input ref={inputRef} type="file" multiple hidden aria-hidden="true" tabIndex={-1} onChange={onFiles} />

      <div className="ui-composer-card">
        {files.length > 0 && (
          <div className="ui-composer-attachments">
            <div className="ui-composer-attachment-row">
              {files.map((f) => {
                const kind = attachmentKind(f);
                if (kind === 'image') {
                  return (
                    <span key={f.path} className="ui-composer-file ui-composer-file--image" title={f.path}>
                      <span className="ui-composer-file-thumb">{f.previewUrl && <img src={f.previewUrl} alt={f.name} />}</span>
                      <span className="ui-composer-file-info">
                        <span className="ui-composer-file-name">{f.name}</span>
                        <span className="ui-composer-file-type">{typeLabel(f.name)}</span>
                      </span>
                      <button type="button" className="ui-composer-file-remove" aria-label={`移除 ${f.name}`} onClick={() => removeFile(f.path)}>×</button>
                    </span>
                  );
                }
                return (
                  <span key={f.path} className="ui-composer-file" title={f.path}>
                    <span className={`ui-composer-file-icon ui-composer-file-icon--${kind}`}>
                      {kind === 'file' ? <ClipIcon /> : KIND_GLYPH[kind]}
                    </span>
                    <span className="ui-composer-file-info">
                      <span className="ui-composer-file-name">{f.name}</span>
                      <span className="ui-composer-file-type">{typeLabel(f.name)}</span>
                    </span>
                    <button type="button" className="ui-composer-file-remove" aria-label={`移除 ${f.name}`} onClick={() => removeFile(f.path)}>×</button>
                  </span>
                );
              })}
            </div>
            {sourceLabel && <div className="ui-composer-attachment-source"><FolderIcon />{sourceLabel}</div>}
          </div>
        )}

        <TextArea
          ref={textareaRef}
          className="ui-composer-input"
          data-testid="composer-input"
          rows={1}
          placeholder="随心输入"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />

        <div className="ui-composer-toolbar">
          <div className="ui-composer-toolbar-left">
            <button type="button" className="ui-icon-btn ui-composer-plus" aria-label="上传文件" title="上传本地文件" onClick={pickFiles}><PlusIcon /></button>
            <button type="button" className="ui-composer-ws-btn" data-testid="composer-workspace" onClick={onChooseWorkspace} title={workspacePath ?? ''}>
              <FolderIcon />
              <span className="ui-composer-ws-name" data-testid="workspace-path">{name}</span>
            </button>
          </div>
          <ContextUsageBar contextUsage={contextUsage} isCompacting={isCompacting} />
          <div className="ui-composer-toolbar-right">
            <ModelEffortControl {...modelProps} />
            <button
              type="button"
              className="ui-composer-send"
              data-testid="composer-send"
              aria-label={canStop ? (stopping ? '停止中' : '停止') : '发送'}
              disabled={actionDisabled}
              onClick={canStop ? onStop : send}
            >
              {canStop ? <StopIcon /> : <ArrowUpIcon />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
