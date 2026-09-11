import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeDocumentRead, documentReadAuditSummary } from '../electron/main/document-read.js';
import {
  DOCUMENT_PARSE_DISK_FULL,
  DOCUMENT_PARSE_NOT_READY,
} from '../electron/main/document-parse-layout.js';
import {
  DOCUMENT_PARSE_SPAWN_FAILED,
  DOCUMENT_PARSE_STOPPED,
} from '../electron/main/document-parse-supervisor.js';

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const nativeDocxFixture = join(fixtureDir, 'fixtures', 'native.docx');

const ctx = { profileId: 'contract-review', sessionId: 's1', actor: 'tester', agentDisplayName: '合同审核' };

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs.length = 0;
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'doc-read-'));
  dirs.push(dir);
  return dir;
}

async function writeDocx(path: string): Promise<void> {
  await copyFile(nativeDocxFixture, path);
}

describe('executeDocumentRead', () => {
  it('parses txt natively without enqueueParse', async () => {
    const dir = await tempDir();
    const path = join(dir, 'a.txt');
    await writeFile(path, 'hello contract');
    const enqueueParse = vi.fn();
    const out = await executeDocumentRead({ documents: [path] }, ctx, { enqueueParse });
    expect(out.ok).toBe(true);
    const data = out.data as { text: string; engine: string; kind: string; meta: { fileName: string; quality?: unknown } };
    expect(data.engine).toBe('native');
    expect(data.kind).toBe('text');
    expect(data.text).toContain('hello contract');
    expect(data.meta.fileName).toBe('a.txt');
    expect(data.meta.quality).toBeUndefined();
    expect(enqueueParse).not.toHaveBeenCalled();
  });

  it('parses docx natively without enqueueParse', async () => {
    const dir = await tempDir();
    const path = join(dir, 'a.docx');
    await writeDocx(path);
    const enqueueParse = vi.fn();
    const out = await executeDocumentRead({ documents: [path] }, ctx, { enqueueParse });
    expect(out.ok).toBe(true);
    const data = out.data as { text: string; engine: string };
    expect(data.engine).toBe('native');
    expect(data.text).toContain('docx body text');
    expect(enqueueParse).not.toHaveBeenCalled();
  });

  it('routes jpg to structure and copies quality from pages', async () => {
    const dir = await tempDir();
    const path = join(dir, 'scan.jpg');
    await writeFile(path, Buffer.from([0xff, 0xd8, 0xff]));
    const enqueueParse = vi.fn(async () => ({ markdown: '# photo', pages: [{ page: 1, score: 0.91 }] }));
    const out = await executeDocumentRead({ documents: [path] }, ctx, {
      enqueueParse,
      needsDocumentParse: () => false,
      ensureDocumentParse: async () => {},
      diskFreeBytes: async () => 10 * 1024 ** 3,
    });
    expect(enqueueParse).toHaveBeenCalledTimes(1);
    expect(enqueueParse).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      path,
      fileName: 'scan.jpg',
      modules: ['baseline'],
      total: 1,
    }));
    expect(out.ok).toBe(true);
    const data = out.data as {
      text: string;
      kind: string;
      engine: string;
      meta: { quality: { score: number; level: string }; fileName: string };
      blocks?: unknown;
      tables?: unknown;
    };
    expect(data.engine).toBe('structure');
    expect(data.kind).toBe('image');
    expect(data.text).toBe('# photo');
    expect(data.meta.fileName).toBe('scan.jpg');
    expect(data.meta.quality.score).toBeCloseTo(0.91);
    expect(data.meta.quality.level).toBe('high');
    expect(data.blocks).toBeUndefined();
    expect(data.tables).toBeUndefined();
  });

  it('routes a short text-layer pdf to structure', async () => {
    const enqueueParse = vi.fn(async () => ({ markdown: '# scan', pages: [{ page: 1, score: 0.8 }] }));
    const out = await executeDocumentRead({ documents: ['/tmp/short.pdf'] }, ctx, {
      enqueueParse,
      needsDocumentParse: () => false,
      ensureDocumentParse: async () => {},
      diskFreeBytes: async () => 10 * 1024 ** 3,
      probePdf: async () => ({ textLayer: 'a'.repeat(5), pageCount: 2, pages: ['aaaaa', ''] }),
    });
    expect(enqueueParse).toHaveBeenCalledTimes(1);
    expect(enqueueParse).toHaveBeenCalledWith(expect.objectContaining({ total: 2 }));
    expect(out.ok).toBe(true);
    expect((out.data as { engine: string }).engine).toBe('structure');
  });

  it('uses native text for a six-page selectable contract without enqueueParse', async () => {
    const page = '甲方应当在本合同生效后十个工作日内支付预付款。';
    const enqueueParse = vi.fn();
    const out = await executeDocumentRead({ documents: ['/tmp/contract.pdf'] }, ctx, {
      enqueueParse,
      probePdf: async () => ({
        textLayer: Array.from({ length: 6 }, () => page).join('\n'),
        pageCount: 6,
        pages: Array.from({ length: 6 }, () => page),
      }),
    });
    expect(enqueueParse).not.toHaveBeenCalled();
    expect(out.ok).toBe(true);
    expect((out.data as { engine: string }).engine).toBe('native');
  });

  it('falls back to parse without a stale total when probePdf throws', async () => {
    const enqueueParse = vi.fn(async () => ({ markdown: '# scan', pages: [{ page: 1, score: 0.8 }] }));
    const out = await executeDocumentRead({ documents: ['/tmp/x.pdf'] }, ctx, {
      enqueueParse,
      needsDocumentParse: () => false,
      ensureDocumentParse: async () => {},
      diskFreeBytes: async () => 10 * 1024 ** 3,
      probePdf: async () => { throw new Error('无法读取该文件。'); },
    });
    expect(enqueueParse).toHaveBeenCalledTimes(1);
    expect(enqueueParse.mock.calls[0][0].total).toBeUndefined();
    expect(out.ok).toBe(true);
    expect((out.data as { engine: string }).engine).toBe('structure');
  });

  it('keeps a dense electronic pdf native and does not enqueue', async () => {
    const enqueueParse = vi.fn();
    const page = '合同条款'.repeat(40);
    const out = await executeDocumentRead({ documents: ['/tmp/dense.pdf'] }, ctx, {
      enqueueParse,
      probePdf: async () => ({ textLayer: page + page, pageCount: 2, pages: [page, page] }),
    });
    expect(enqueueParse).not.toHaveBeenCalled();
    expect(out.ok).toBe(true);
    const data = out.data as { text: string; engine: string; meta: { quality?: unknown } };
    expect(data.engine).toBe('native');
    expect(data.text).toContain('# 第 1 页');
    expect(data.text).toContain('# 第 2 页');
    expect(data.meta.quality).toBeUndefined();
  });

  it('sets ignoredCount when two documents are provided', async () => {
    const dir = await tempDir();
    const first = join(dir, 'a.txt');
    const second = join(dir, 'b.txt');
    await writeFile(first, 'keep');
    await writeFile(second, 'ignore');
    const enqueueParse = vi.fn();
    const out = await executeDocumentRead({ documents: [first, second] }, ctx, { enqueueParse });
    expect(out.ok).toBe(true);
    expect((out.data as { meta: { ignoredCount: number } }).meta.ignoredCount).toBe(1);
    expect(enqueueParse).not.toHaveBeenCalled();
  });

  it('returns ok false without data.text when enqueue throws', async () => {
    const dir = await tempDir();
    const path = join(dir, 'scan.png');
    await writeFile(path, 'x');
    const out = await executeDocumentRead({ documents: [path] }, ctx, {
      enqueueParse: async () => {
        throw new Error(DOCUMENT_PARSE_SPAWN_FAILED);
      },
      needsDocumentParse: () => false,
      ensureDocumentParse: async () => {},
      diskFreeBytes: async () => 10 * 1024 ** 3,
    });
    expect(out.ok).toBe(false);
    expect(out.data).toBeUndefined();
    expect((out.data as { text?: string } | undefined)?.text).toBeUndefined();
    expect(out.error?.message).toBe(DOCUMENT_PARSE_SPAWN_FAILED);
    expect(out.error?.message).toBe('内存不足或文档解析无法启动，请到设置 → 文档解析查看。');
  });

  it('fails with 尚未就绪 when needsDocumentParse is true and ensure is stubbed', async () => {
    const dir = await tempDir();
    const path = join(dir, 'scan.jpg');
    await writeFile(path, 'x');
    const enqueueParse = vi.fn();
    const out = await executeDocumentRead({ documents: [path] }, ctx, {
      enqueueParse,
      needsDocumentParse: () => true,
      ensureDocumentParse: async () => {
        throw new Error(DOCUMENT_PARSE_NOT_READY);
      },
      diskFreeBytes: async () => 10 * 1024 ** 3,
    });
    expect(out).toEqual({ ok: false, error: { code: 'CONNECTOR_IO', message: DOCUMENT_PARSE_NOT_READY } });
    expect(out.error?.message).toBe('文档解析尚未就绪，请到设置 → 文档解析查看。');
    expect(enqueueParse).not.toHaveBeenCalled();
  });

  it('fails with 尚未就绪 when ensure skips and needs remains true', async () => {
    const dir = await tempDir();
    const path = join(dir, 'scan.jpg');
    await writeFile(path, 'x');
    const enqueueParse = vi.fn();
    const out = await executeDocumentRead({ documents: [path] }, ctx, {
      enqueueParse,
      needsDocumentParse: () => true,
      ensureDocumentParse: async () => {},
      diskFreeBytes: async () => 10 * 1024 ** 3,
    });
    expect(out).toEqual({ ok: false, error: { code: 'CONNECTOR_IO', message: DOCUMENT_PARSE_NOT_READY } });
    expect(out.error?.message).toBe('文档解析尚未就绪，请到设置 → 文档解析查看。');
    expect(enqueueParse).not.toHaveBeenCalled();
  });

  it('fails with 磁盘空间不足 when diskFreeBytes is under 2GB', async () => {
    const dir = await tempDir();
    const path = join(dir, 'scan.jpg');
    await writeFile(path, 'x');
    const enqueueParse = vi.fn();
    const out = await executeDocumentRead({ documents: [path] }, ctx, {
      enqueueParse,
      needsDocumentParse: () => true,
      ensureDocumentParse: async () => {},
      diskFreeBytes: async () => 1024 ** 3,
    });
    expect(out).toEqual({ ok: false, error: { code: 'CONNECTOR_IO', message: DOCUMENT_PARSE_DISK_FULL } });
    expect(out.error?.message).toBe('磁盘空间不足，无法准备文档解析。');
    expect(enqueueParse).not.toHaveBeenCalled();
  });

  it('fails with locked 已停止 copy when enqueue rejects as stopped', async () => {
    const dir = await tempDir();
    const path = join(dir, 'scan.jpg');
    await writeFile(path, 'x');
    const out = await executeDocumentRead({ documents: [path] }, ctx, {
      enqueueParse: async () => {
        throw new Error(DOCUMENT_PARSE_STOPPED);
      },
      needsDocumentParse: () => false,
      ensureDocumentParse: async () => {},
      diskFreeBytes: async () => 10 * 1024 ** 3,
    });
    expect(out).toEqual({ ok: false, error: { code: 'CONNECTOR_IO', message: DOCUMENT_PARSE_STOPPED } });
    expect(out.error?.message).toBe('文档解析已停止。');
  });

  it('rejects an empty documents list', async () => {
    const out = await executeDocumentRead({ documents: [] }, ctx, { enqueueParse: vi.fn() });
    expect(out).toEqual({ ok: false, error: { code: 'CONNECTOR_IO', message: 'no document provided' } });
  });
});

describe('documentReadAuditSummary', () => {
  it('includes fileName, engine, and score without the full text', () => {
    const fullText = '# 合同正文\n\n甲方应当按照约定履行付款义务。'.repeat(30);
    const summary = documentReadAuditSummary(
      { documents: ['/docs/contracts/scan.pdf'] },
      {
        ok: true,
        data: {
          text: fullText,
          kind: 'pdf',
          engine: 'structure',
          meta: {
            fileName: 'scan.pdf',
            pageCount: 3,
            quality: { score: 0.78, level: 'mid', pages: [{ page: 1, score: 0.78, level: 'mid' }] },
            skippedModules: ['seal'],
          },
        },
      },
    );
    expect(summary).toContain('scan.pdf');
    expect(summary).toContain('structure');
    expect(summary).toContain('0.78');
    expect(summary).toContain('seal');
    expect(summary).not.toContain(fullText);
    expect(summary).not.toContain('甲方应当按照约定履行付款义务');
  });

  it('includes the error message on fail and never file contents', () => {
    const fullText = '# leaked markdown from the scan';
    const summary = documentReadAuditSummary(
      { documents: ['C:/secret/invoice.jpg'] },
      { ok: false, error: { code: 'CONNECTOR_IO', message: DOCUMENT_PARSE_SPAWN_FAILED } },
    );
    expect(summary).toContain('invoice.jpg');
    expect(summary).toContain(DOCUMENT_PARSE_SPAWN_FAILED);
    expect(summary).not.toContain(fullText);
    expect(summary).not.toContain('C:/secret/invoice.jpg');
  });
});
