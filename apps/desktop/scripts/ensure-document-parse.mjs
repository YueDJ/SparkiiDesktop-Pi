// Extract sparkii-document-parse.7z.exe to %LOCALAPPDATA%\SparkiiDesktop\runtime\document-parse.
// If the archive is not in the repo yet, skip with exit 0 so `pnpm dist` stays green.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(__dirname, '..');
const ARCHIVE_NAME = 'sparkii-document-parse.7z.exe';

const archiveCandidates = [
  process.env.SPARKII_DOCUMENT_PARSE_ARCHIVE,
  join(desktopRoot, 'runtime', 'document-parse', ARCHIVE_NAME),
].filter(Boolean);

const archivePath = archiveCandidates.find((p) => existsSync(p));

if (!archivePath) {
  console.log('document-parse archive missing; skip');
  process.exit(0);
}

const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
const runtimeRoot = process.env.SPARKII_RUNTIME_ROOT ?? join(localAppData, 'SparkiiDesktop', 'runtime');
const dest = join(runtimeRoot, 'document-parse');
const exe = join(dest, 'bin', 'sparkii-document-parse.exe');
const ready = join(dest, 'models', 'baseline', 'READY');

if (existsSync(exe) && existsSync(ready)) {
  console.log(`document-parse already ready: ${dest}`);
  process.exit(0);
}

console.log(`extracting document-parse to ${dest}`);
mkdirSync(dest, { recursive: true });
const result = spawnSync(archivePath, [`-o${dest}`, '-y'], { stdio: 'inherit' });
if (result.status !== 0) {
  throw new Error(`document-parse extraction failed with exit code ${result.status}`);
}
console.log(`document-parse ready: ${dest}`);
