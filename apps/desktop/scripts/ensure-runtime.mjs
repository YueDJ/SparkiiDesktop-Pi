// 下载 Portable Git 自解压包，并解压到 %LOCALAPPDATA%\SparkiiDesktop\runtime\portable-git。
// 同时把归档放到 apps/desktop/runtime/portable-git.7z.exe，供 electron-builder 打包进 resources/runtime。
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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
const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
const runtimeRoot = process.env.SPARKII_RUNTIME_ROOT ?? join(localAppData, 'SparkiiDesktop', 'runtime');
const portableGitDir = join(runtimeRoot, 'portable-git');

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

function extract(archive, dest) {
  const result = spawnSync(archive, [`-o${dest}`, '-y'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Portable Git extraction failed with exit code ${result.status}`);
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

console.log(`runtime ready: ${portableGitDir}`);
