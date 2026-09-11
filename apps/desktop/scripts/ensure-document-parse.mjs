// Extract sparkii-document-parse.7z.exe to %LOCALAPPDATA%\SparkiiDesktop\runtime\document-parse.
// Only SPARKII_DOCUMENT_PARSE_ARCHIVE (must exist + sha256 match) or
// apps/desktop/runtime/document-parse/sparkii-document-parse.7z.exe (sha256 match).
// If neither archive is on disk yet, skip with exit 0 so `pnpm start` stays usable.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyArchiveChecksum } from './document-parse-checksum.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(__dirname, '..');
const ARCHIVE_NAME = 'sparkii-document-parse.7z.exe';
const runtimeArchive = join(desktopRoot, 'runtime', 'document-parse', ARCHIVE_NAME);
const defaultChecksumsPath = join(desktopRoot, 'runtime', 'document-parse', 'checksums.json');
const checksumsPath = process.env.SPARKII_DOCUMENT_PARSE_CHECKSUMS ?? defaultChecksumsPath;

const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
const runtimeRoot = process.env.SPARKII_RUNTIME_ROOT ?? join(localAppData, 'SparkiiDesktop', 'runtime');
const dest = join(runtimeRoot, 'document-parse');
const exe = join(dest, 'bin', 'sparkii-document-parse.exe');
const ready = join(dest, 'models', 'baseline', 'READY');

const override = process.env.SPARKII_DOCUMENT_PARSE_ARCHIVE;
let verifiedOverride = false;

if (override) {
  if (!existsSync(override)) {
    throw new Error(`document-parse archive missing: ${override}`);
  }
  if (existsSync(checksumsPath)) {
    const actual = await verifyArchiveChecksum(override, checksumsPath);
    console.log(`document-parse checksum ok: ${actual}`);
    verifiedOverride = true;
  }
}

if (existsSync(exe) && existsSync(ready)) {
  console.log(`document-parse already ready: ${dest}`);
  process.exit(0);
}

const archivePath = override || (existsSync(runtimeArchive) ? runtimeArchive : null);

if (!archivePath) {
  console.log('document-parse archive missing; skip');
  process.exit(0);
}

if (!verifiedOverride) {
  const actual = await verifyArchiveChecksum(archivePath, checksumsPath);
  console.log(`document-parse checksum ok: ${actual}`);
}

console.log(`extracting document-parse to ${dest}`);
mkdirSync(dest, { recursive: true });
const result = spawnSync(archivePath, [`-o${dest}`, '-y'], { stdio: 'inherit' });
if (result.status !== 0) {
  throw new Error(`document-parse extraction failed with exit code ${result.status}`);
}
console.log(`document-parse ready: ${dest}`);
