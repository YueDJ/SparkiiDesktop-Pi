import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

export const PORTABLE_GIT_ARCHIVE_SHA256 =
  'ab00566336b5472120f9a52d34f2e79c5406535792acb0548001ffd0bd090e5d';

export async function verifySha256File(filePath, expectedSha256) {
  const actual = createHash('sha256').update(await readFile(filePath)).digest('hex');
  if (actual !== expectedSha256) {
    throw new Error(`checksum mismatch for ${basename(filePath)}: ${actual}`);
  }
}
