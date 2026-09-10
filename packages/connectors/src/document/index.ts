import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { ConnectorError, type Connector, type ToolHandler } from '../types.js';
import type { ParsedDocument } from './types.js';

export type {
  DocumentEngine,
  DocumentKind,
  ParsedDocument,
  RecognitionLevel,
  RecognitionQuality,
} from './types.js';
export { averageQuality, recognitionLevel } from './quality.js';
export { shouldUseStructure } from './route.js';
export { pdfPagesToMarkdown, probePdf, xlsxToMarkdown } from './native-markdown.js';

export async function parseDocument(path: string): Promise<ParsedDocument> {
  const ext = extname(path).toLowerCase();
  if (!['.txt', '.md', '.csv', '.pdf', '.docx', '.xlsx'].includes(ext)) {
    throw new ConnectorError('CONNECTOR_UNSUPPORTED', `unsupported extension: ${ext}`);
  }
  const buf = await readFile(path).catch((e) => {
    throw new ConnectorError('CONNECTOR_IO', `cannot read ${path}: ${(e as Error).message}`);
  });
  const fileName = basename(path);
  if (ext === '.txt' || ext === '.md' || ext === '.csv') {
    return { text: buf.toString('utf8'), kind: 'text', engine: 'native', meta: { fileName } };
  }
  if (ext === '.pdf') return parsePdf(path, buf, fileName);
  if (ext === '.docx') return parseDocx(path, buf, fileName);
  if (ext === '.xlsx') return parseXlsx(path, buf, fileName);
  throw new ConnectorError('CONNECTOR_UNSUPPORTED', `unsupported extension: ${ext}`);
}

async function parsePdf(path: string, buf: Buffer, fileName: string): Promise<ParsedDocument> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({ data: new Uint8Array(buf) }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it: any) => it.str).join(' '));
  }
  return {
    text: pages.join('\n'),
    kind: 'pdf',
    engine: 'native',
    meta: { fileName, pageCount: doc.numPages },
  };
}

async function parseDocx(path: string, buf: Buffer, fileName: string): Promise<ParsedDocument> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ buffer: buf });
  return { text: value, kind: 'docx', engine: 'native', meta: { fileName } };
}

async function parseXlsx(path: string, buf: Buffer, fileName: string): Promise<ParsedDocument> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer' });
  const text = wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n');
  return { text, kind: 'xlsx', engine: 'native', meta: { fileName } };
}

const handler: ToolHandler = async () => ({
  ok: false,
  error: { code: 'CONNECTOR_DENIED', message: 'document.read must run on main' },
});

export const documentConnector: Connector = {
  id: 'document',
  tools: [{
    name: 'document.read',
    description: '读取并解析本地文档（PDF/Word/Excel/文本/图片）为纯文本。',
    params: { type: 'object', properties: { documents: { type: 'array', items: { type: 'string' } } }, required: ['documents'] },
    sideEffect: 'read',
    host: 'main',
    handler,
  }],
  async init() {},
};
