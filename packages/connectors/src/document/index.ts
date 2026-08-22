import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { ConnectorError, type Connector, type ToolHandler } from '../types.js';

export interface ParsedDocument {
  text: string;
  kind: 'pdf' | 'docx' | 'xlsx' | 'text';
  meta: { fileName: string; pageCount?: number };
}

export async function parseDocument(path: string): Promise<ParsedDocument> {
  const ext = extname(path).toLowerCase();
  if (!['.txt', '.md', '.csv', '.pdf', '.docx', '.xlsx'].includes(ext)) {
    throw new ConnectorError('CONNECTOR_UNSUPPORTED', `unsupported extension: ${ext}`);
  }
  const buf = await readFile(path).catch((e) => {
    throw new ConnectorError('CONNECTOR_IO', `cannot read ${path}: ${(e as Error).message}`);
  });
  if (ext === '.txt' || ext === '.md' || ext === '.csv') {
    return { text: buf.toString('utf8'), kind: 'text', meta: { fileName: path } };
  }
  if (ext === '.pdf') return parsePdf(path, buf);
  if (ext === '.docx') return parseDocx(path, buf);
  if (ext === '.xlsx') return parseXlsx(path, buf);
  throw new ConnectorError('CONNECTOR_UNSUPPORTED', `unsupported extension: ${ext}`);
}

async function parsePdf(path: string, buf: Buffer): Promise<ParsedDocument> {
  // 用 pdfjs-dist 提取文本；这里是确定的实现骨架
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({ data: new Uint8Array(buf) }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it: any) => it.str).join(' '));
  }
  return { text: pages.join('\n'), kind: 'pdf', meta: { fileName: path, pageCount: doc.numPages } };
}

async function parseDocx(path: string, buf: Buffer): Promise<ParsedDocument> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ buffer: buf });
  return { text: value, kind: 'docx', meta: { fileName: path } };
}

async function parseXlsx(path: string, buf: Buffer): Promise<ParsedDocument> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer' });
  const text = wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n');
  return { text, kind: 'xlsx', meta: { fileName: path } };
}

const handler: ToolHandler = async (args) => {
  try {
    const docs = args.documents as string[] | undefined;
    if (!docs || docs.length === 0) return { ok: false, error: { code: 'CONNECTOR_IO', message: 'no document provided' } };
    const doc = await parseDocument(docs[0]);
    return { ok: true, data: doc };
  } catch (e) {
    const err = e as ConnectorError;
    return { ok: false, error: { code: err.code ?? 'CONNECTOR_IO', message: err.message } };
  }
};

export const documentConnector: Connector = {
  id: 'document',
  tools: [{
    name: 'document.read',
    description: '读取并解析本地文档（PDF/Word/Excel/文本）为纯文本。',
    params: { type: 'object', properties: { documents: { type: 'array', items: { type: 'string' } } }, required: ['documents'] },
    sideEffect: 'read',
    handler,
  }],
  async init() {},
};
