// 下载 Portable Git 自解压包，并解压到 %LOCALAPPDATA%\SparkiiDesktop\runtime\portable-git。
// 同时下载 fd/rg 到 apps/desktop/runtime/tools，并预置到运行时 runtime/tools。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import https from 'node:https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(__dirname, '..');

// Git for Windows 的发布标签形如 v2.55.0.windows.3，对应归档 PortableGit-2.55.0.3-64-bit.7z.exe。
const VERSION = process.env.PORTABLE_GIT_VERSION ?? '2.55.0.windows.3';
const ASSET = `PortableGit-${VERSION.replace('.windows.', '.')}-64-bit.7z.exe`;
const URL = `https://github.com/git-for-windows/git/releases/download/v${VERSION}/${ASSET}`;

const archiveDir = join(desktopRoot, 'runtime');
const archivePath = join(archiveDir, 'portable-git.7z.exe');
const toolsDir = join(archiveDir, 'tools');
const licenseDir = join(toolsDir, 'licenses');
const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
const runtimeRoot = process.env.SPARKII_RUNTIME_ROOT ?? join(localAppData, 'SparkiiDesktop', 'runtime');
const portableGitDir = join(runtimeRoot, 'portable-git');

const searchTools = [
  {
    name: 'fd',
    exe: 'fd.exe',
    archiveName: 'fd-v10.5.0-x86_64-pc-windows-msvc.zip',
    url: 'https://github.com/sharkdp/fd/releases/download/v10.5.0/fd-v10.5.0-x86_64-pc-windows-msvc.zip',
    sha256: 'a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7',
    licenseFiles: ['LICENSE-APACHE', 'LICENSE-MIT'],
  },
  {
    name: 'rg',
    exe: 'rg.exe',
    archiveName: 'ripgrep-15.2.0-x86_64-pc-windows-msvc.zip',
    url: 'https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-pc-windows-msvc.zip',
    sha256: '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5',
    licenseFiles: ['LICENSE-MIT', 'UNLICENSE'],
  },
];

function download(url, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  return new Promise((resolve, reject) => {
    const follow = (current, redirects) => {
      if (redirects > 5) {
        reject(new Error(`too many redirects for ${url}`));
        return;
      }
      https.get(current, (res) => {
        const { statusCode, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume();
          const next = new NodeURL(headers.location, current).toString();
          follow(next, redirects + 1);
          return;
        }
        if (statusCode !== 200) {
          res.resume();
          reject(new Error(`download failed: HTTP ${statusCode} for ${current}`));
          return;
        }
        pipeline(res, createWriteStream(dest)).then(resolve, reject);
      }).on('error', reject);
    };
    follow(url, 0);
  });
}

async function verifySha256(dest, expectedSha256) {
  const actual = createHash('sha256').update(await readFile(dest)).digest('hex');
  if (actual !== expectedSha256) {
    throw new Error(`checksum mismatch for ${basename(dest)}: ${actual}`);
  }
}

async function downloadVerified(url, dest, expectedSha256) {
  await download(url, dest);
  await verifySha256(dest, expectedSha256);
}

function extract(archive, dest) {
  const result = spawnSync(archive, [`-o${dest}`, '-y'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Portable Git extraction failed with exit code ${result.status}`);
}

function extractZip(archive, dest) {
  mkdirSync(dest, { recursive: true });
  const result = spawnSync('tar', ['-xf', archive, '-C', dest], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`zip extraction failed with exit code ${result.status}`);
}

async function ensureSearchTools() {
  const runtimeToolsDir = join(runtimeRoot, 'tools');
  const legacyDataDir = process.env.SPARKII_DATA_DIR ?? join(localAppData, 'SparkiiDesktop', 'data');
  const legacyPiAgentBinDir = join(legacyDataDir, 'pi-agent', 'bin');
  mkdirSync(toolsDir, { recursive: true });
  mkdirSync(runtimeToolsDir, { recursive: true });

  for (const tool of searchTools) {
    const targetExe = join(toolsDir, tool.exe);
    if (!existsSync(targetExe)) {
      const archive = join(archiveDir, tool.archiveName);
      if (!existsSync(archive)) {
        console.log(`downloading ${tool.url}`);
        await downloadVerified(tool.url, archive, tool.sha256);
      }
      await verifySha256(archive, tool.sha256);
      const extractDir = join(archiveDir, `.extract-${tool.name}`);
      rmSync(extractDir, { recursive: true, force: true });
      extractZip(archive, extractDir);
      const extractedRoot = join(extractDir, tool.archiveName.replace(/\.zip$/, ''));
      copyFileSync(join(extractedRoot, tool.exe), targetExe);
      const toolLicenseDir = join(licenseDir, tool.name);
      mkdirSync(toolLicenseDir, { recursive: true });
      for (const licenseFile of tool.licenseFiles) {
        copyFileSync(join(extractedRoot, licenseFile), join(toolLicenseDir, basename(licenseFile)));
      }
    }
    copyFileSync(targetExe, join(runtimeToolsDir, tool.exe));
    const legacyExe = join(legacyPiAgentBinDir, tool.exe);
    if (existsSync(legacyExe)) rmSync(legacyExe, { force: true });
  }
}

const hasArchive = existsSync(archivePath);
const hasRuntime = existsSync(join(portableGitDir, 'bin', 'bash.exe'))
  && existsSync(join(portableGitDir, 'cmd', 'git.exe'));

if (!hasArchive) {
  console.log(`downloading ${URL}`);
  await download(URL, archivePath);
}

if (!hasRuntime) {
  console.log(`extracting to ${portableGitDir}`);
  mkdirSync(portableGitDir, { recursive: true });
  extract(archivePath, portableGitDir);
}

await ensureSearchTools();

console.log(`runtime ready: ${portableGitDir}`);
console.log(`search tools ready: ${toolsDir}`);
