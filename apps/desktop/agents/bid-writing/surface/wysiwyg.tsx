/**
 * WYSIWYG manuscript editor (product §8.1 / I8, tech design T4).
 *
 * Markdown stays the authoritative underlying format. In WYSIWYG mode each
 * block is rendered via react-markdown (images are visible blocks, no raw
 * `![](...)` shown) and becomes an inline textarea only while being edited.
 * "查看源码" switches the whole chapter to a plain Markdown textarea for
 * advanced users. MD is preserved byte-for-byte for untouched blocks.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { SparkiiApi } from '../../../src/types/sparkii-api.js';
import { parseBlocks, serializeBlocks, type Block } from './block-merge.js';

function api(): SparkiiApi {
  return ((window as unknown as { sparkii?: SparkiiApi }).sparkii ?? {}) as SparkiiApi;
}

interface VisibleImageProps {
  src: string;
  alt: string;
  sessionId: string | null;
  onEdit: (src: string) => void;
}

/** Render a workspace image as a visible block by loading bytes via P1 read. */
function VisibleImage({ src, alt, sessionId, onEdit }: VisibleImageProps) {
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
  return (
    <span className="bw-fig" title="点击编辑图表源">
      {url ? <img src={url} alt={alt} className="bw-fig-img" onClick={() => onEdit(src)} /> : <span className="bw-fig-ph">[图：{alt}]（点击编辑）</span>}
      <button className="bw-fig-edit" onClick={() => onEdit(src)}>编辑图源</button>
    </span>
  );
}

export interface WysiwygProps {
  value: string;
  sessionId: string | null;
  onChange: (next: string) => void;
  onEditFigure: (src: string) => void;
  placeholder?: string;
}

export default function WysiwygEditor({ value, sessionId, onChange, onEditFigure, placeholder }: WysiwygProps) {
  const [mode, setMode] = useState<'wysiwyg' | 'source'>('wysiwyg');
  const [editing, setEditing] = useState<string | null>(null);
  const blocks: Block[] = useMemo(() => {
    const parsed = parseBlocks(value);
    return parsed.length ? parsed : [{ id: 'blk-1', content: value }];
  }, [value]);

  const updateBlock = (id: string, content: string) => {
    onChange(serializeBlocks(blocks.map((b) => (b.id === id ? { ...b, content } : b))));
  };

  return (
    <div className="bw-wysiwyg">
      <div className="bw-wysiwyg-bar">
        <button className={`bw-mode${mode === 'wysiwyg' ? ' active' : ''}`} onClick={() => setMode('wysiwyg')}>所见即所得</button>
        <button className={`bw-mode${mode === 'source' ? ' active' : ''}`} onClick={() => setMode('source')}>查看源码</button>
      </div>
      {mode === 'source' ? (
        <textarea
          className="bw-editor"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      ) : (
        <div className="bw-wysiwyg-body">
          {value.trim() === '' && <div className="bw-hint">{placeholder}</div>}
          {blocks.map((b) => (
            <div key={b.id} className={`bw-block${editing === b.id ? ' editing' : ''}`}>
              {editing === b.id ? (
                <textarea
                  className="bw-block-input"
                  value={b.content}
                  autoFocus
                  onChange={(e) => updateBlock(b.id, e.target.value)}
                  onBlur={() => setEditing(null)}
                />
              ) : (
                <div className="bw-block-view" onClick={() => setEditing(b.id)}>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      img: ({ src, alt }) => (
                        <VisibleImage
                          src={String(src ?? '')}
                          alt={String(alt ?? '图')}
                          sessionId={sessionId}
                          onEdit={(s) => { setEditing(null); onEditFigure(s); }}
                        />
                      ),
                    }}
                  >
                    {b.content}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
