import { basename, extname } from 'node:path';
import {
  averageQuality,
  parseDocument,
  pdfPagesToMarkdown,
  probePdf as probePdfDefault,
  shouldUseStructure,
  xlsxToMarkdown,
  ConnectorError,
  type DocumentKind,
  type ParsedDocument,
  type ToolResult,
} from '@sparkii/connectors';
import {
  DOCUMENT_PARSE_DISK_FULL,
  DOCUMENT_PARSE_NOT_READY,
  MIN_DOCUMENT_PARSE_DISK_BYTES,
  diskFreeBytes as diskFreeBytesDefault,
  ensureDocumentParse as ensureDocumentParseDefault,
  needsDocumentParse as needsDocumentParseDefault,
} from './document-parse-layout.js';
import { getDocumentParseSupervisor, type DocumentParseJob } from './document-parse-supervisor.js';
import type { ParseResult } from './document-parse-rpc.js';

export type ProbePdfResult = {
  textLayer: string;
  pageCount: number;
  pages: string[];
};

export type ExecuteDocumentReadDeps = {
  enqueueParse?: (job: DocumentParseJob) => Promise<ParseResult>;
  diskFreeBytes?: () => Promise<number>;
  needsDocumentParse?: () => boolean;
  ensureDocumentParse?: () => Promise<void>;
  probePdf?: (path: string) => Promise<ProbePdfResult>;
};

const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);
const OFFICE_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.docx', '.xlsx']);

function kindOf(ext: string): DocumentKind | null {
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (ext === '.xlsx') return 'xlsx';
  if (ext === '.txt' || ext === '.md' || ext === '.csv') return 'text';
  if (PHOTO_EXTENSIONS.has(ext)) return 'image';
  return null;
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, error: { code, message } };
}

/** Audit payload for `tool.read` / `document.read`. Never includes markdown or file contents. */
export function documentReadAuditSummary(
  args: Record<string, unknown>,
  result: ToolResult,
): string {
  const first = Array.isArray(args.documents) ? args.documents[0] : undefined;
  const fileName = typeof first === 'string' && first.length > 0 ? basename(first) : undefined;
  const summary: {
    fileName?: string;
    engine?: string;
    pageCount?: number;
    score?: number;
    skippedModules?: string[];
    error?: string;
  } = {};
  if (fileName) summary.fileName = fileName;

  if (!result.ok) {
    const message = result.error?.message;
    if (typeof message === 'string' && message.length > 0) summary.error = message;
    return JSON.stringify(summary);
  }

  const data = result.data;
  if (data && typeof data === 'object') {
    const rec = data as {
      engine?: unknown;
      meta?: {
        pageCount?: unknown;
        quality?: { score?: unknown };
        skippedModules?: unknown;
      };
    };
    if (typeof rec.engine === 'string') summary.engine = rec.engine;
    const meta = rec.meta;
    if (meta && typeof meta === 'object') {
      if (typeof meta.pageCount === 'number') summary.pageCount = meta.pageCount;
      const score = meta.quality?.score;
      if (typeof score === 'number') summary.score = score;
      if (Array.isArray(meta.skippedModules)) {
        summary.skippedModules = meta.skippedModules.filter((item): item is string => typeof item === 'string');
      }
    }
  }
  return JSON.stringify(summary);
}

function withIgnored(
  meta: ParsedDocument['meta'],
  documents: unknown[],
): ParsedDocument['meta'] {
  const ignoredCount = documents.length - 1;
  if (ignoredCount > 0) return { ...meta, ignoredCount };
  return meta;
}

function connectorFail(err: unknown): ToolResult {
  if (err instanceof ConnectorError) {
    return fail(err.code, err.message);
  }
  const message = err instanceof Error && err.message.trim().length > 0
    ? err.message
    : DOCUMENT_PARSE_NOT_READY;
  return fail('CONNECTOR_IO', message);
}

async function nativeDocument(path: string, ext: string, probed: ProbePdfResult | null): Promise<ParsedDocument> {
  const fileName = basename(path);
  if (ext === '.xlsx') {
    const text = await xlsxToMarkdown(path);
    return { text, kind: 'xlsx', engine: 'native', meta: { fileName } };
  }
  if (ext === '.pdf') {
    const pages = probed?.pages ?? [];
    return {
      text: pdfPagesToMarkdown(pages),
      kind: 'pdf',
      engine: 'native',
      meta: { fileName, pageCount: probed?.pageCount || pages.length },
    };
  }
  return parseDocument(path);
}

async function runStructure(
  path: string,
  kind: DocumentKind,
  ctx: { profileId: string; sessionId: string; agentDisplayName?: string },
  documents: unknown[],
  pageCount: number,
  deps: Required<Pick<ExecuteDocumentReadDeps, 'enqueueParse' | 'diskFreeBytes' | 'needsDocumentParse' | 'ensureDocumentParse'>>,
): Promise<ToolResult> {
  try {
    if (deps.needsDocumentParse()) {
      const free = await deps.diskFreeBytes();
      if (free < MIN_DOCUMENT_PARSE_DISK_BYTES) {
        return fail('CONNECTOR_IO', DOCUMENT_PARSE_DISK_FULL);
      }
    }
    await deps.ensureDocumentParse();
    if (deps.needsDocumentParse()) {
      return fail('CONNECTOR_IO', DOCUMENT_PARSE_NOT_READY);
    }
    const fileName = basename(path);
    const result = await deps.enqueueParse({
      sessionId: ctx.sessionId,
      agentDisplayName: ctx.agentDisplayName ?? ctx.profileId,
      fileName,
      path,
      modules: ['baseline'],
      ...(pageCount > 0 ? { total: pageCount } : {}),
    });
    const pages = Array.isArray(result.pages) ? result.pages : [];
    const data: ParsedDocument = {
      text: result.markdown,
      kind,
      engine: 'structure',
      meta: withIgnored(
        {
          fileName,
          ...(pages.length > 0 ? { pageCount: pages.length } : {}),
          quality: averageQuality(pages),
        },
        documents,
      ),
    };
    return { ok: true, data };
  } catch (err) {
    return connectorFail(err);
  }
}

export async function executeDocumentRead(
  args: Record<string, unknown>,
  ctx: { profileId: string; sessionId: string; actor?: string; requestId?: string; agentDisplayName?: string },
  deps?: ExecuteDocumentReadDeps,
): Promise<ToolResult> {
  const documents = args.documents;
  if (!Array.isArray(documents) || documents.length === 0) {
    return fail('CONNECTOR_IO', 'no document provided');
  }
  const path = String(documents[0] ?? '');
  if (!path) return fail('CONNECTOR_IO', 'no document provided');

  const ext = extname(path).toLowerCase();
  const kind = kindOf(ext);
  if (!kind) return fail('CONNECTOR_UNSUPPORTED', `unsupported extension: ${ext || '(none)'}`);

  const enqueueParse = deps?.enqueueParse
    ?? ((job: DocumentParseJob) => getDocumentParseSupervisor().enqueueParse(job));
  const diskFreeBytes = deps?.diskFreeBytes ?? (() => diskFreeBytesDefault());
  const needs = deps?.needsDocumentParse ?? (() => needsDocumentParseDefault());
  const ensure = deps?.ensureDocumentParse ?? (() => ensureDocumentParseDefault());
  const probePdf = deps?.probePdf ?? probePdfDefault;

  try {
    let probed: ProbePdfResult | null = null;
    let textLayer: string | null = '';
    let pageCount = 1;
    if (ext === '.pdf') {
      try {
        probed = await probePdf(path);
        textLayer = probed.textLayer;
        pageCount = probed.pageCount || 0;
      } catch {
        textLayer = null;
        pageCount = 0;
      }
    } else if (OFFICE_EXTENSIONS.has(ext)) {
      textLayer = '';
      pageCount = 1;
    } else if (PHOTO_EXTENSIONS.has(ext)) {
      textLayer = '';
      pageCount = 1;
    }

    if (shouldUseStructure({ ext, textLayer: ext === '.pdf' ? textLayer : (PHOTO_EXTENSIONS.has(ext) ? '' : ''), pageCount })) {
      return runStructure(path, kind, ctx, documents, pageCount, {
        enqueueParse,
        diskFreeBytes,
        needsDocumentParse: needs,
        ensureDocumentParse: ensure,
      });
    }

    const doc = await nativeDocument(path, ext, probed);
    return {
      ok: true,
      data: {
        ...doc,
        engine: 'native',
        meta: withIgnored({ ...doc.meta, fileName: basename(path) }, documents),
      } satisfies ParsedDocument,
    };
  } catch (err) {
    return connectorFail(err);
  }
}
