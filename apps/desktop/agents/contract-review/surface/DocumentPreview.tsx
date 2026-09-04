import { useEffect, useRef } from 'react';

export type PreviewKind = 'pdf' | 'docx' | 'txt';

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function kindLabel(kind: PreviewKind): string {
  if (kind === 'pdf') return 'PDF';
  if (kind === 'docx') return 'Word';
  return 'TXT';
}

function decodeTxt(bytes: ArrayBuffer): string {
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gb18030').decode(bytes);
  } catch {
    return utf8;
  }
}

function PdfPreview({ bytes }: { bytes: ArrayBuffer }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let cancelled = false;
    root.replaceChildren();
    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        // Import the worker into this thread. Electron's file:// origin is
        // "null", so a module Worker (or import of a hashed file URL) is
        // blocked on Windows and can take the window down.
        await import('pdfjs-dist/build/pdf.worker.min.mjs');
        const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
        if (cancelled) return;
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const width = Math.max(root.clientWidth - 8, 240);
          const viewport = page.getViewport({ scale: width / base.width });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.className = 'contract-doc-page';
          root.append(canvas);
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        }
      } catch {
        if (!cancelled) root.textContent = '无法渲染该 PDF。';
      }
    })();
    return () => { cancelled = true; };
  }, [bytes]);
  return <div ref={ref} className="contract-doc-preview contract-doc-preview--pdf" data-testid="document-preview" data-kind="pdf" />;
}

function DocxPreview({ bytes }: { bytes: ArrayBuffer }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let cancelled = false;
    root.replaceChildren();
    void (async () => {
      try {
        const { renderAsync } = await import('docx-preview');
        if (cancelled) return;
        await renderAsync(bytes, root, undefined, {
          className: 'contract-docx',
          inWrapper: true,
          ignoreWidth: true,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
        });
      } catch {
        if (!cancelled) root.textContent = '无法渲染该 Word 文档。';
      }
    })();
    return () => { cancelled = true; };
  }, [bytes]);
  return <div ref={ref} className="contract-doc-preview contract-doc-preview--docx" data-testid="document-preview" data-kind="docx" />;
}

export function DocumentPreview(props: { kind: PreviewKind; bytes: ArrayBuffer }) {
  if (props.kind === 'txt') {
    return (
      <pre className="contract-doc-preview contract-doc-preview--txt" data-testid="document-preview" data-kind="txt">
        {decodeTxt(props.bytes)}
      </pre>
    );
  }
  if (props.kind === 'pdf') return <PdfPreview bytes={props.bytes} />;
  return <DocxPreview bytes={props.bytes} />;
}
