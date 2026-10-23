import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PORTABLE_GIT_ARCHIVE_SHA256,
  verifySha256File,
} from '../scripts/runtime-checksums.mjs';

describe('packaged runtime checksums', () => {
  it('accepts a file with the expected SHA256', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sparkii-checksum-'));
    const file = join(root, 'archive.exe');
    writeFileSync(file, '');

    await expect(verifySha256File(
      file,
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )).resolves.toBeUndefined();
  });

  it('rejects a file whose SHA256 does not match', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sparkii-checksum-'));
    const file = join(root, 'archive.exe');
    writeFileSync(file, '');

    await expect(verifySha256File(
      file,
      '0000000000000000000000000000000000000000000000000000000000000000',
    )).rejects.toThrow('checksum mismatch for archive.exe');
  });

  it('pins the current Portable Git archive', () => {
    expect(PORTABLE_GIT_ARCHIVE_SHA256).toBe(
      'ab00566336b5472120f9a52d34f2e79c5406535792acb0548001ffd0bd090e5d',
    );
  });
});
