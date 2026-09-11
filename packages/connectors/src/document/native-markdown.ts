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
  textLayer: string;
  pageCount: number;
  pages: string[];
}> {
  try {
    const buf = await readFile(path);
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await getDocument({
      data: new Uint8Array(buf),
      disableWorker: true,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: true,
    }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it: { str?: string }) => String(it.str ?? '')).join(' '));
    }
    const textLayer = pages.every((p) => p === '') ? '' : pages.join('\n');
    return { textLayer, pageCount: doc.numPages, pages };
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    throw new ConnectorError('CONNECTOR_IO', '无法读取该文件。');
  }
}
