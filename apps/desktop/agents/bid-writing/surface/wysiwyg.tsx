/**
 * WYSIWYG manuscript editor (product §8.1 / I8, tech design T4).
 *
 * Markdown stays the authoritative underlying format. The rendered view is
 * read-only; clicking anywhere in the body switches the whole chapter to a
 * Markdown textarea. The checkmark in the top-right bar saves through the
 * caller (single-chapter saveChapter + version snapshot) and returns to the
 * rendered view. No per-block inline textarea and no mode tabs.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { SparkiiApi } from '../../../src/types/sparkii-api.js';
import { parseBlocks, type Block } from './block-merge.js';

function api(): SparkiiApi {
  return ((window as unknown as { sparkii?: SparkiiApi }).sparkii ?? {}) as SparkiiApi;
}

interface VisibleImageProps {
  src: string;
  alt: string;
  sessionId: string | null;
  onEdit: (src: string) => void;
  onEditStart: () => void;
}

/** Render a workspace image as a visible block by loading bytes via P1 read. */
function VisibleImage({ src, alt, sessionId, onEdit, onEditStart }: VisibleImageProps) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    if (!sessionId || !src || /^https?:/i.test(src)) { setUrl(null); return; }
    // Figure refs are stored as `figures/<name>.png` inside the manuscript MD;
    // the actual bytes live in `output/figures/` (same mapping used by the
    // compiler in ipc.ts). Resolve both shapes so the visible block loads.
    const clean = src.replace(/^\.\//, '');
    const workspacePath = clean.startsWith('figures/')
      ? `output/${clean}`
      : `output/manuscript/${clean}`;
    const readBytes = api().workspaceReadBytes;
    if (typeof readBytes !== 'function') return;
    // Figures live in the fixed workspace, so load bytes through the fenced P1
    // workspace IPC (workspace-relative path). `readDocumentBytes` requires an
    // absolute/granted path and would deny a relative path (architect review 2).
    void Promise.resolve(readBytes({ sessionId, path: workspacePath })).then((r: any) => {
      if (cancelled || !r?.ok || typeof r.bytesBase64 !== 'string') return;
      const bin = atob(r.bytesBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'image/png' });
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => {});
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [src, sessionId]);
  const startEdit = (event: { stopPropagation(): void }) => {
    event.stopPropagation(); // figure editing must not switch the chapter to source mode
    onEditStart();
    onEdit(src);
  };
  return (
    <span className="bw-fig" title="点击编辑图表源">
      {url ? <img src={url} alt={alt} className="bw-fig-img" onClick={startEdit} /> : <span className="bw-fig-ph" onClick={startEdit}>[图：{alt}]（点击编辑）</span>}
      <button className="bw-fig-edit" onClick={startEdit}>编辑图源</button>
    </span>
  );
}

/** One chapter's markdown for the read-only whole-manuscript view. */
export interface ReadonlyChapter {
  chapterId: string;
  markdown: string;
}

export interface WysiwygScrollTarget {
  /** `<chapterId>::<blockId>` — DOM-only anchor, never written back to markdown. */
  anchor: string;
  nonce: number;
}

export interface WysiwygProps {
  /** Current single-chapter source (used while editing). */
  value: string;
  sessionId: string | null;
  onChange: (next: string) => void;
  /** Checkmark action: caller saves the single chapter and snapshots it. */
  onSave?: () => void | Promise<void>;
  onEditFigure: (src: string) => void;
  placeholder?: string;
  /** All chapter sources for the read-only view; editing stays single-chapter. */
  chapters?: ReadonlyChapter[];
  /** null = full read-only view; a chapter id = that chapter in source mode. */
  editingChapterId?: string | null;
  onEditChapter?: (chapterId: string) => void;
  scrollTarget?: WysiwygScrollTarget;
}

export default function WysiwygEditor({
  value, sessionId, onChange, onSave, onEditFigure, placeholder,
  chapters, editingChapterId, onEditChapter, scrollTarget,
}: WysiwygProps) {
  const [localEditing, setLocalEditing] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const controlled = editingChapterId !== undefined;
  const editing = controlled ? Boolean(editingChapterId) : localEditing;
  const blocks: Block[] = useMemo(() => {
    const parsed = parseBlocks(value);
    return parsed.length ? parsed : [{ id: 'blk-1', content: value }];
  }, [value]);

  const chapterBlocks = useMemo(
    () => (chapters ?? []).map((doc) => {
      const parsed = parseBlocks(doc.markdown);
      return { chapterId: doc.chapterId, blocks: parsed.length ? parsed : [{ id: 'blk-1', content: doc.markdown }] as Block[] };
    }),
    [chapters],
  );

  useEffect(() => {
    if (!scrollTarget || editing) return;
    const nodes = bodyRef.current?.querySelectorAll('[data-anchor]');
    const node = Array.from(nodes ?? []).find((n) => n.getAttribute('data-anchor') === scrollTarget.anchor);
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'start' });
  }, [scrollTarget, editing, chapterBlocks]);

  const beginEdit = (chapterId?: string) => {
    if (controlled) onEditChapter?.(chapterId ?? chapters?.[0]?.chapterId ?? '');
    else setLocalEditing(true);
  };

  const handleSave = async () => {
    try { await onSave?.(); } finally { if (!controlled) setLocalEditing(false); }
  };

  const renderBlock = (b: Block, chapterId?: string) => (
    <div
      key={chapterId ? `${chapterId}::${b.id}` : b.id}
      className="bw-block"
      data-block-id={b.id}
      data-chapter-id={chapterId}
      data-anchor={chapterId ? `${chapterId}::${b.id}` : undefined}
      onClick={chapterId ? (event) => { event.stopPropagation(); beginEdit(chapterId); } : undefined}
    >
      <div className="bw-block-view">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            img: ({ src, alt }) => (
              <VisibleImage
                src={String(src ?? '')}
                alt={String(alt ?? '图')}
                sessionId={sessionId}
                onEditStart={() => beginEdit(chapterId)}
                onEdit={onEditFigure}
              />
            ),
          }}
        >
          {b.content}
        </ReactMarkdown>
      </div>
    </div>
  );

  return (
    <div className="bw-wysiwyg">
      <div className="bw-wysiwyg-bar">
        <span className="bw-wysiwyg-hint">{editing ? '编辑整章 Markdown' : '点击正文进入源码编辑'}</span>
        {editing && (
          <button type="button" className="bw-save-check" title="保存并返回渲染态" aria-label="保存并返回渲染态" onClick={() => void handleSave()}>✓</button>
        )}
      </div>
      {editing ? (
        <textarea
          className="bw-editor"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoFocus
        />
      ) : (
        <div
          className="bw-wysiwyg-body"
          ref={bodyRef}
          onClick={(event) => {
            const fromBlock = (event.target as HTMLElement).closest('[data-chapter-id]');
            beginEdit(fromBlock?.getAttribute('data-chapter-id') ?? chapters?.[0]?.chapterId);
          }}
        >
          {chapterBlocks.length > 0
            ? chapterBlocks.flatMap((doc) => doc.blocks.map((b) => renderBlock(b, doc.chapterId)))
            : (value.trim() === '' ? <div className="bw-hint">{placeholder}</div> : blocks.map((b) => renderBlock(b)))}
        </div>
      )}
    </div>
  );
}
