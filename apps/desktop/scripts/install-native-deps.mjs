// Local `pnpm install` must not invoke node-gyp / Visual Studio.
// better-sqlite3@13 ships N-API prebuilds; load those for Electron and Node.
// `pnpm dist --` / SPARKII_REBUILD_NATIVE=1 still runs electron-builder rebuild
// for machines that need a compiled addon (no matching prebuild).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function desktopRootFromMeta(metaUrl = import.meta.url, cwd = process.cwd()) {
  if (typeof metaUrl === 'string' && metaUrl.startsWith('file:')) {
    return resolve(fileURLToPath(new URL('..', metaUrl)));
  }
  return cwd.endsWith('desktop') ? cwd : join(cwd, 'apps/desktop');
}

export function prebuildTarget({
  platform = process.platform,
  arch = process.arch,
  musl = false,
} = {}) {
  const os = platform === 'linux' && musl ? 'linuxmusl' : platform;
  return `${os}-${arch}`;
}

export function findPrebuild(pkgRoot, target) {
  if (!pkgRoot || !target) return null;
  const file = join(pkgRoot, 'prebuilds', `${target}.node`);
  return existsSync(file) ? file : null;
}

export function shouldSkipRebuild({ rebuildRequested = false, prebuildPath = null } = {}) {
  return !rebuildRequested && Boolean(prebuildPath);
}

export function resolveBetterSqlite3Root(requireFrom) {
  const req = requireFrom ?? createRequire(join(desktopRootFromMeta(), 'package.json'));
  try {
    return dirname(req.resolve('better-sqlite3/package.json'));
  } catch {
    return null;
  }
}

function isLinuxMusl() {
  return process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime;
}

function runElectronRebuild() {
  const result = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'electron-builder', 'install-app-deps'],
    { cwd: desktopRootFromMeta(), stdio: 'inherit', shell: process.platform === 'win32' },
  );
  return result.status ?? 1;
}

function main(argv = process.argv.slice(2), env = process.env) {
  const rebuildRequested = argv.includes('--rebuild') || env.SPARKII_REBUILD_NATIVE === '1';
  const pkgRoot = resolveBetterSqlite3Root();
  const prebuildPath = findPrebuild(pkgRoot, prebuildTarget({ musl: isLinuxMusl() }));

  if (shouldSkipRebuild({ rebuildRequested, prebuildPath })) {
    console.log(`[sparkii] using better-sqlite3 prebuild (${prebuildPath})`);
    return 0;
  }

  if (!rebuildRequested && !prebuildPath) {
    console.warn('[sparkii] no better-sqlite3 prebuild for this platform; trying electron-builder install-app-deps');
  }

  const status = runElectronRebuild();
  if (status === 0) return 0;

  const fallback = findPrebuild(pkgRoot, prebuildTarget({ musl: isLinuxMusl() }));
  if (fallback) {
    console.warn(`[sparkii] native rebuild failed; continuing with package prebuild (${fallback})`);
    return 0;
  }

  console.error(
    '[sparkii] better-sqlite3 has no prebuild and rebuild failed. Local start does not need Visual Studio when the package prebuild is present; delete node_modules and retry. Packaging on an unsupported platform still needs a C++ toolchain.',
  );
  return status;
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exit(main());
}
