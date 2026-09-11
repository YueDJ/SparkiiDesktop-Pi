import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const childProcessMock = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', () => ({
  default: { spawn: childProcessMock.spawn },
  spawn: childProcessMock.spawn,
}));

import {
  DOCUMENT_PARSE_ARCHIVE_NAME,
  documentParseArchivePath,
  ensureDocumentParse,
  needsDocumentParse,
  resolveDocumentParsePaths,
} from '../electron/main/document-parse-layout.js';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'sparkii-dp-'));
}

function placeReady(root: string): void {
  const paths = resolveDocumentParsePaths({ SPARKII_RUNTIME_ROOT: root });
  mkdirSync(join(paths.root, 'bin'), { recursive: true });
  mkdirSync(join(paths.root, 'models', 'baseline'), { recursive: true });
  writeFileSync(paths.exe, 'exe');
  writeFileSync(paths.ready, 'ok');
}

function writeChecksumsFor(archivePath: string, dir: string): string {
  const hash = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  const checksums = join(dir, 'checksums.json');
  writeFileSync(checksums, JSON.stringify({ archive: hash }));
  return checksums;
}

function stubSpawnExtract(): void {
  childProcessMock.spawn.mockImplementation((_archive: string, args: string[]) => {
    const destArg = args.find((a) => a.startsWith('-o')) ?? '';
    const dest = destArg.slice(2);
    mkdirSync(join(dest, 'bin'), { recursive: true });
    mkdirSync(join(dest, 'models', 'baseline'), { recursive: true });
    writeFileSync(join(dest, 'bin', 'sparkii-document-parse.exe'), 'exe');
    writeFileSync(join(dest, 'models', 'baseline', 'READY'), 'ok');
    const child = new EventEmitter();
    setImmediate(() => child.emit('close', 0));
    return child;
  });
}

describe('resolveDocumentParsePaths', () => {
  it('places exe and READY under SPARKII_RUNTIME_ROOT/document-parse', () => {
    const paths = resolveDocumentParsePaths({ SPARKII_RUNTIME_ROOT: 'D:/sparkii/runtime' });
    expect(paths.root).toBe(join('D:/sparkii/runtime', 'document-parse'));
    expect(paths.exe).toBe(join('D:/sparkii/runtime', 'document-parse', 'bin', 'sparkii-document-parse.exe'));
    expect(paths.ready).toBe(join('D:/sparkii/runtime', 'document-parse', 'models', 'baseline', 'READY'));
    expect(paths.models).toBe(join('D:/sparkii/runtime', 'document-parse', 'models'));
  });

  it('uses the same LOCALAPPDATA root as Portable Git', () => {
    const paths = resolveDocumentParsePaths({ LOCALAPPDATA: 'C:/Users/x/AppData/Local' });
    expect(paths.root).toBe(join('C:/Users/x/AppData/Local', 'SparkiiDesktop', 'runtime', 'document-parse'));
  });
});

describe('needsDocumentParse', () => {
  it('is true when READY is missing', () => {
    const root = tempRoot();
    const paths = resolveDocumentParsePaths({ SPARKII_RUNTIME_ROOT: root });
    mkdirSync(join(paths.root, 'bin'), { recursive: true });
    writeFileSync(paths.exe, 'exe');
    expect(needsDocumentParse({ SPARKII_RUNTIME_ROOT: root })).toBe(true);
  });

  it('is true when the exe is missing', () => {
    const root = tempRoot();
    const paths = resolveDocumentParsePaths({ SPARKII_RUNTIME_ROOT: root });
    mkdirSync(join(paths.root, 'models', 'baseline'), { recursive: true });
    writeFileSync(paths.ready, 'ok');
    expect(needsDocumentParse({ SPARKII_RUNTIME_ROOT: root })).toBe(true);
  });

  it('is false when exe and READY exist', () => {
    const root = tempRoot();
    placeReady(root);
    expect(needsDocumentParse({ SPARKII_RUNTIME_ROOT: root })).toBe(false);
  });
});

describe('documentParseArchivePath', () => {
  it('honors SPARKII_DOCUMENT_PARSE_ARCHIVE when the file exists', () => {
    const root = tempRoot();
    const archive = join(root, DOCUMENT_PARSE_ARCHIVE_NAME);
    writeFileSync(archive, 'sfx');
    expect(documentParseArchivePath({ SPARKII_DOCUMENT_PARSE_ARCHIVE: archive })).toBe(archive);
  });

  it('looks under resourcesPath/runtime/document-parse', () => {
    const resources = tempRoot();
    const archive = join(resources, 'runtime', 'document-parse', DOCUMENT_PARSE_ARCHIVE_NAME);
    mkdirSync(join(resources, 'runtime', 'document-parse'), { recursive: true });
    writeFileSync(archive, 'sfx');
    expect(documentParseArchivePath({}, resources)).toBe(archive);
  });

  it('returns null when SPARKII_DOCUMENT_PARSE_ARCHIVE is set but missing', () => {
    expect(documentParseArchivePath({ SPARKII_DOCUMENT_PARSE_ARCHIVE: join(tempRoot(), 'missing.7z.exe') })).toBeNull();
  });

  it('falls back to the repo runtime archive when env is unset', () => {
    const found = documentParseArchivePath({});
    if (!existsSync(join(desktopRoot, 'runtime/document-parse', DOCUMENT_PARSE_ARCHIVE_NAME))) {
      expect(found).toBeNull();
      return;
    }
    expect(found).toMatch(/sparkii-document-parse\.7z\.exe$/);
  });
});

describe('ensureDocumentParse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not throw when the archive is missing', async () => {
    const root = tempRoot();
    await expect(ensureDocumentParse(
      { SPARKII_RUNTIME_ROOT: root, SPARKII_DOCUMENT_PARSE_ARCHIVE: join(root, 'missing.7z.exe') },
      { archivePath: null },
    )).resolves.toBeUndefined();
    expect(childProcessMock.spawn).not.toHaveBeenCalled();
    expect(needsDocumentParse({ SPARKII_RUNTIME_ROOT: root })).toBe(true);
  });

  it('extracts a present archive to dest; needs is false after READY+exe', async () => {
    const root = tempRoot();
    const archive = join(root, DOCUMENT_PARSE_ARCHIVE_NAME);
    writeFileSync(archive, 'sfx');
    stubSpawnExtract();

    const env = {
      SPARKII_RUNTIME_ROOT: root,
      SPARKII_DOCUMENT_PARSE_ARCHIVE: archive,
      SPARKII_DOCUMENT_PARSE_CHECKSUMS: writeChecksumsFor(archive, root),
    };
    await ensureDocumentParse(env);

    const dest = join(root, 'document-parse');
    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      archive,
      [`-o${dest}`, '-y'],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(existsSync(join(dest, 'bin', 'sparkii-document-parse.exe'))).toBe(true);
    expect(existsSync(join(dest, 'models', 'baseline', 'READY'))).toBe(true);
    expect(needsDocumentParse(env)).toBe(false);
  });

  it('skips extract when already ready', async () => {
    const root = tempRoot();
    placeReady(root);
    const archive = join(root, DOCUMENT_PARSE_ARCHIVE_NAME);
    writeFileSync(archive, 'sfx');

    await ensureDocumentParse({
      SPARKII_RUNTIME_ROOT: root,
      SPARKII_DOCUMENT_PARSE_ARCHIVE: archive,
    });

    expect(childProcessMock.spawn).not.toHaveBeenCalled();
  });

  it('does not extract when checksums.json is missing', async () => {
    const root = tempRoot();
    const archive = join(root, DOCUMENT_PARSE_ARCHIVE_NAME);
    writeFileSync(archive, 'sfx');

    await expect(ensureDocumentParse({
      SPARKII_RUNTIME_ROOT: root,
      SPARKII_DOCUMENT_PARSE_ARCHIVE: archive,
      SPARKII_DOCUMENT_PARSE_CHECKSUMS: join(root, 'missing-checksums.json'),
    })).rejects.toThrow(/checksums\.json missing/);
    expect(childProcessMock.spawn).not.toHaveBeenCalled();
  });

  it('does not extract when the archive hash mismatches', async () => {
    const root = tempRoot();
    const archive = join(root, DOCUMENT_PARSE_ARCHIVE_NAME);
    writeFileSync(archive, 'sfx');
    const checksums = join(root, 'checksums.json');
    writeFileSync(checksums, JSON.stringify({ archive: 'c'.repeat(64) }));

    await expect(ensureDocumentParse({
      SPARKII_RUNTIME_ROOT: root,
      SPARKII_DOCUMENT_PARSE_ARCHIVE: archive,
      SPARKII_DOCUMENT_PARSE_CHECKSUMS: checksums,
    })).rejects.toThrow(/checksum mismatch/);
    expect(childProcessMock.spawn).not.toHaveBeenCalled();
  });
});

describe('document-parse release archive', () => {
  it('keeps the default archive under 100 MiB when present', () => {
    const archive = join(desktopRoot, 'runtime/document-parse', DOCUMENT_PARSE_ARCHIVE_NAME);
    if (!existsSync(archive)) return;
    expect(statSync(archive).size).toBeLessThanOrEqual(100 * 1024 * 1024);
  });

  it('pins a real 64-hex archive sha256 when checksums.json exists', async () => {
    const archive = join(desktopRoot, 'runtime/document-parse', DOCUMENT_PARSE_ARCHIVE_NAME);
    const checksums = join(desktopRoot, 'runtime/document-parse/checksums.json');
    if (!existsSync(checksums)) return;
    const raw = readFileSync(checksums, 'utf8');
    const parsed = JSON.parse(raw) as { archive?: string };
    expect(parsed.archive).toMatch(/^[0-9a-fA-F]{64}$/);
    expect(parsed.archive).not.toMatch(/REPLACE/i);
    if (!existsSync(archive)) return;
    const { verifyArchiveChecksum } = await import('../scripts/document-parse-checksum.mjs');
    await expect(verifyArchiveChecksum(archive, checksums)).resolves.toBe(parsed.archive.toLowerCase());
  });
});
