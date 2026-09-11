// Extract sparkii-document-parse.7z.exe to %LOCALAPPDATA%\SparkiiDesktop\runtime\document-parse.
// Only SPARKII_DOCUMENT_PARSE_ARCHIVE (must exist + sha256 match) or
// apps/desktop/runtime/document-parse/sparkii-document-parse.7z.exe (sha256 match).
// If neither archive is on disk yet, skip with exit 0 so `pnpm start` stays usable.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(__dirname, '..');
const ARCHIVE_NAME = 'sparkii-document-parse.7z.exe';
const runtimeArchive = join(desktopRoot, 'runtime', 'document-parse', ARCHIVE_NAME);
const checksumsPath = join(desktopRoot, 'runtime', 'document-parse', 'checksums.json');

const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
const runtimeRoot = process.env.SPARKII_RUNTIME_ROOT ?? join(localAppData, 'SparkiiDesktop', 'runtime');
const dest = join(runtimeRoot, 'document-parse');
const exe = join(dest, 'bin', 'sparkii-document-parse.exe');
const ready = join(dest, 'models', 'baseline', 'READY');

if (existsSync(exe) && existsSync(ready)) {
  console.log(`document-parse already ready: ${dest}`);
  process.exit(0);
}

const override = process.env.SPARKII_DOCUMENT_PARSE_ARCHIVE;
const archiveCandidates = [
  override,
  override ? undefined : runtimeArchive,
].filter(Boolean);

const archivePath = archiveCandidates.find((p) => existsSync(p));

if (override && !existsSync(override)) {
  throw new Error(`document-parse archive missing: ${override}`);
}

if (!archivePath) {
  console.log('document-parse archive missing; skip');
  process.exit(0);
}

const expected = JSON.parse(readFileSync(checksumsPath, 'utf8')).archive;
if (typeof expected !== 'string' || !/^[0-9a-fA-F]{64}$/.test(expected)) {
  throw new Error('document-parse checksums.json archive must be a 64-hex sha256');
}

const actual = await sha256File(archivePath);
if (actual.toLowerCase() !== expected.toLowerCase()) {
  throw new Error(`document-parse checksum mismatch: ${actual}`);
}
console.log(`document-parse checksum ok: ${actual}`);

console.log(`extracting document-parse to ${dest}`);
mkdirSync(dest, { recursive: true });
const result = spawnSync(archivePath, [`-o${dest}`, '-y'], { stdio: 'inherit' });
if (result.status !== 0) {
  throw new Error(`document-parse extraction failed with exit code ${result.status}`);
}
console.log(`document-parse ready: ${dest}`);

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}
