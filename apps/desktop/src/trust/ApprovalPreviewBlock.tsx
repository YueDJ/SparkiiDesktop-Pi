import { useState } from 'react';
import type { ApprovalViewModel } from './present.js';
import { DiffView } from '../workbench/DiffView.js';

export function ApprovalPreviewBlock({ preview }: { preview: ApprovalViewModel['preview'] }) {
  const [expanded, setExpanded] = useState(false);
  if (preview.kind === 'none' || preview.lines.length === 0) return null;
  const shown = expanded ? preview.lines : preview.visibleLines;
  const text = shown.join('\n');
  return (
    <div className="ui-approval-preview">
      {preview.kind === 'diff' ? <DiffView diff={text} /> : <pre className="ui-approval-preview-text">{text}</pre>}
      {preview.hiddenCount > 0 && (
        <button type="button" className="ui-btn ui-btn--sm ui-approval-preview-more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收起' : `还有 ${preview.hiddenCount} 行 · 展开`}
        </button>
      )}
    </div>
  );
}
