import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  documentKindOf,
  grantDocumentPath,
  isDocumentPathAllowed,
  readGrantedDocumentBytes,
  resetGrantedDocumentPaths,
} from '../electron/main/document-bytes.js';

afterEach(() => {
  resetGrantedDocumentPaths();
});

describe('documentKindOf', () => {
  it('maps preview extensions only', () => {
    expect(documentKindOf('a.pdf')).toBe('pdf');
    expect(documentKindOf('a.DOCX')).toBe('docx');
    expect(documentKindOf('a.txt')).toBe('txt');
    expect(documentKindOf('a.xlsx')).toBeNull();
    expect(documentKindOf('a.md')).toBeNull();
    expect(documentKindOf('a.doc')).toBeNull();
  });
});

describe('readGrantedDocumentBytes', () => {
  it('denies paths that were not chosen or in the session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doc-bytes-'));
    const path = join(dir, 'secret.txt');
    await writeFile(path, 'nope');
    await expect(readGrantedDocumentBytes(path, {})).resolves.toEqual({ error: 'denied' });
  });

  it('reads a granted txt file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doc-bytes-'));
    const path = join(dir, 'contract.txt');
    await writeFile(path, 'hello contract');
    grantDocumentPath(path);
    const result = await readGrantedDocumentBytes(path, {});
    expect(result).toMatchObject({ kind: 'txt', fileName: 'contract.txt', fileSize: 14 });
    if ('error' in result) throw new Error('expected bytes');
    expect(new TextDecoder().decode(result.bytes)).toBe('hello contract');
  });

  it('allows a session input without a prior grant', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doc-bytes-'));
    const path = join(dir, 'input.txt');
    await writeFile(path, 'from-session');
    const result = await readGrantedDocumentBytes(path, { inputs: [{ path }] });
    expect(result).toMatchObject({ kind: 'txt', fileName: 'input.txt' });
  });

  it('allows a file inside the session workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doc-bytes-'));
    const path = join(dir, 'inside.txt');
    await writeFile(path, 'ws');
    const result = await readGrantedDocumentBytes(path, { workspacePath: dir });
    expect(result).toMatchObject({ kind: 'txt', fileName: 'inside.txt' });
  });

  it('rejects unsupported extensions even when granted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doc-bytes-'));
    const path = join(dir, 'sheet.xlsx');
    await writeFile(path, 'xlsx');
    grantDocumentPath(path);
    await expect(readGrantedDocumentBytes(path, {})).resolves.toEqual({ error: 'unsupported' });
  });

  it('returns missing when the granted file is gone', async () => {
    const path = join(tmpdir(), `gone-${Date.now()}.txt`);
    grantDocumentPath(path);
    await expect(readGrantedDocumentBytes(path, {})).resolves.toEqual({ error: 'missing' });
  });

  it('returns too_large when the file exceeds the cap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doc-bytes-'));
    const path = join(dir, 'big.txt');
    await writeFile(path, 'too-big');
    grantDocumentPath(path);
    await expect(readGrantedDocumentBytes(path, {}, { maxBytes: 3 })).resolves.toEqual({ error: 'too_large' });
  });

  it('treats slash-normalized paths as the same grant', () => {
    grantDocumentPath('C:\\tmp\\a.txt');
    expect(isDocumentPathAllowed('C:/tmp/a.txt', {})).toBe(true);
  });
});
