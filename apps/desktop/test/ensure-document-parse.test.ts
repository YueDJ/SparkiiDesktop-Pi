import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_PARSE_ARCHIVE_NAME } from '../electron/main/document-parse-layout.js';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(desktopRoot, '../..');
const ensureScript = join(desktopRoot, 'scripts/ensure-document-parse.mjs');
const checksumsPath = join(desktopRoot, 'runtime/document-parse/checksums.json');

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'sparkii-dp-ensure-'));
}

function runEnsure(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [ensureScript], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
}

function withTempChecksums(archive: string, run: () => void): void {
  const existed = existsSync(checksumsPath);
  const previous = existed ? readFileSync(checksumsPath, 'utf8') : null;
  writeFileSync(checksumsPath, JSON.stringify({ archive }));
  try {
    run();
  } finally {
    if (previous === null) {
      unlinkSync(checksumsPath);
    } else {
      writeFileSync(checksumsPath, previous);
    }
  }
}

describe('ensure-document-parse.mjs', () => {
  it('does not accept sibling repo-root or sparkii-document-parse-dist archives', () => {
    const src = readFileSync(ensureScript, 'utf8');
    expect(src).not.toContain('sparkii-document-parse-dist');
    expect(src).not.toMatch(/join\(\s*repoRoot\s*,\s*['"]\.\.['"]\s*,\s*ARCHIVE_NAME\s*\)/);
    expect(src).not.toContain(`join(repoRoot, '..', ARCHIVE_NAME)`);
    expect(src).not.toContain(join(repoRoot, '..', DOCUMENT_PARSE_ARCHIVE_NAME).replace(/\\/g, '\\\\'));
  });

  it('fails when SPARKII_DOCUMENT_PARSE_ARCHIVE points at a checksum mismatch', () => {
    const root = tempRoot();
    const badArchive = join(root, DOCUMENT_PARSE_ARCHIVE_NAME);
    const payload = 'not-a-valid-document-parse-sfx';
    writeFileSync(badArchive, payload);
    const badHash = createHash('sha256').update(payload).digest('hex');
    const expected = 'a'.repeat(64);

    withTempChecksums(expected, () => {
      const result = runEnsure({
        SPARKII_DOCUMENT_PARSE_ARCHIVE: badArchive,
        SPARKII_RUNTIME_ROOT: join(root, 'runtime'),
      });

      expect(result.status).not.toBe(0);
      const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      expect(combined).toMatch(/checksum mismatch/i);
      expect(combined.toLowerCase()).toContain(badHash);
    });
  });
});
