import { readFile } from 'node:fs/promises';
import { ConnectorError } from '../types.js';

export function pdfPagesToMarkdown(pages: string[]): string {
  return pages.map((text, i) => `# 第 ${i + 1} 页\n${text}`).join('\n\n');
}

export async function xlsxToMarkdown(path: string): Promise<string> {
  const buf = await readFile(path).catch((e) => {
    throw new ConnectorError('CONNECTOR_IO', `cannot read ${path}: ${(e as Error).message}`);
  });
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer' });
  return wb.SheetNames.map((n) => `## ${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`).join('\n\n');
}

export async function probePdf(path: string): Promise<{
  textLayer: string | null;
  pageCount: number;
  pages: string[];
}> {
  try {
    const buf = await readFile(path);
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await getDocument({ data: new Uint8Array(buf) }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it: { str?: string }) => String(it.str ?? '')).join(' '));
    }
    if (pages.length === 0) return { textLayer: null, pageCount: doc.numPages, pages: [] };
    return { textLayer: pages.join('\n'), pageCount: doc.numPages, pages };
  } catch {
    return { textLayer: null, pageCount: 0, pages: [] };
  }
}
