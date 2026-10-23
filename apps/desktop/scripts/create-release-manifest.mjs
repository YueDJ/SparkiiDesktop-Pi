import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolve)
      .on('error', reject);
  });
  return hash.digest('hex');
}

function atomicWrite(filePath, content) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, content, 'utf8');
  renameSync(tempPath, filePath);
}

export async function createReleaseManifest({
  artifactPath,
  outputDir,
  version,
  commit,
  builtAt,
  dirty = false,
}) {
  const stat = statSync(artifactPath);
  if (!stat.isFile()) throw new Error(`release artifact is not a file: ${artifactPath}`);

  const artifact = basename(artifactPath);
  const manifest = {
    schemaVersion: 1,
    product: 'Sparkii',
    version,
    platform: 'win-x64',
    commit,
    builtAt,
    worktreeDirty: dirty,
    unsigned: true,
    artifact,
    bytes: stat.size,
    sha256: await sha256File(artifactPath),
  };

  atomicWrite(join(outputDir, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  atomicWrite(join(outputDir, 'SHA256SUMS.txt'), `${manifest.sha256}  ${artifact}\n`);
  return manifest;
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: desktopRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

function isWorktreeDirty() {
  try {
    return execFileSync('git', ['status', '--porcelain'], {
      cwd: desktopRoot,
      encoding: 'utf8',
    }).trim().length > 0;
  } catch {
    return true;
  }
}

function findInstaller(outputDir) {
  const candidates = readdirSync(outputDir)
    .filter((name) => /^Sparkii-.*-win-x64\.exe$/.test(name))
    .map((name) => join(outputDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (candidates.length === 0) throw new Error(`no Windows installer found in ${outputDir}`);
  return candidates[0];
}

async function main() {
  const outputDir = join(desktopRoot, 'out');
  const pkg = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8'));
  const artifactPath = readOption('--artifact') ?? findInstaller(outputDir);
  const manifest = await createReleaseManifest({
    artifactPath,
    outputDir,
    version: readOption('--version') ?? pkg.version,
    commit: readOption('--commit') ?? readCommit(),
    builtAt: readOption('--built-at') ?? new Date().toISOString(),
    dirty: isWorktreeDirty(),
  });
  console.log(`release manifest: ${join(outputDir, 'release-manifest.json')}`);
  console.log(`sha256: ${manifest.sha256}`);
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
