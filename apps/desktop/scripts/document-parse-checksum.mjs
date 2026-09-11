import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';

const HEX64 = /^[0-9a-fA-F]{64}$/;

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

export function readExpectedArchiveHash(checksumsPath) {
  if (!checksumsPath || !existsSync(checksumsPath)) {
    throw new Error('document-parse checksums.json missing');
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(checksumsPath, 'utf8'));
  } catch {
    throw new Error('document-parse checksums.json archive must be a 64-hex sha256');
  }
  const expected = parsed?.archive;
  if (typeof expected !== 'string' || !HEX64.test(expected)) {
    throw new Error('document-parse checksums.json archive must be a 64-hex sha256');
  }
  return expected;
}

export async function verifyArchiveChecksum(archivePath, checksumsPath) {
  const expected = readExpectedArchiveHash(checksumsPath);
  const actual = await sha256File(archivePath);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`document-parse checksum mismatch: ${actual}`);
  }
  return actual;
}
