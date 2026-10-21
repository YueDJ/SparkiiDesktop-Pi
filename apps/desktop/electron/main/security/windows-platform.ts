import {
  lstat,
  realpath,
  stat,
  type Stats,
} from 'node:fs/promises';
import { win32 } from 'node:path';
import type {
  ProtectedRoot,
  WorkspacePathInfo,
  WorkspacePathProbe,
} from '@sparkii/approval';

export interface WindowsPlatformOptions {
  home: string;
  windowsDir: string;
  programFiles: string;
  programFilesX86?: string;
  programData?: string;
  appData: string;
  localAppData: string;
  dataDir: string;
  volumes?: string[];
  credentialDirs?: string[];
}

const WINDOWS_DEVICE_PATH = /^\\\\[.?]\\(?!UNC\\)/i;
const WINDOWS_DEVICE_NAME =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR']);

function stripExtendedPrefix(value: string): string {
  if (/^\\\\\?\\UNC\\/i.test(value)) return `\\\\${value.slice(8)}`;
  if (/^\\\\\?\\[a-z]:/i.test(value)) return value.slice(4);
  return value;
}

function normalizedWindowsPath(value: string): string {
  const stripped = stripExtendedPrefix(String(value).trim());
  const normalized = win32.normalize(stripped.replace(/\//g, '\\'));
  return normalized.length > 3
    ? normalized.replace(/[\\/]+$/, '')
    : normalized;
}

function validateWindowsPath(value: string): string {
  const original = String(value ?? '').trim();
  if (WINDOWS_DEVICE_PATH.test(original)) {
    throw new Error('Windows device paths are not allowed');
  }
  if (!original || !win32.isAbsolute(original)) {
    throw new Error('Windows path must be absolute');
  }
  const normalized = normalizedWindowsPath(original);
  const afterRoot = normalized.slice(2);
  if (afterRoot.includes(':')) {
    throw new Error('Windows alternate data streams are not allowed');
  }
  for (const segment of normalized.split(/[\\/]+/)) {
    if (WINDOWS_DEVICE_NAME.test(segment)) {
      throw new Error('Windows reserved device names are not allowed');
    }
  }
  return normalized;
}

export function windowsPathKey(value: string): string {
  const normalized = normalizedWindowsPath(value).replace(/\\/g, '/');
  return normalized.replace(/\/+$/, normalized.endsWith('/') ? '/' : '').toLowerCase();
}

function objectIdentity(stats: Stats): string {
  const big = stats as Stats & { dev?: bigint; ino?: bigint };
  if (big.ino && big.ino !== 0n) return `win-object:${big.dev ?? 0}:${big.ino}`;
  return `win-stat:${stats.mode}:${stats.size}:${stats.mtimeMs}`;
}

async function nearestExisting(target: string): Promise<{
  path: string;
  missing: string[];
}> {
  let current = target;
  const missing: string[] = [];
  while (true) {
    try {
      await lstat(current, { bigint: true });
      return { path: current, missing };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !MISSING_CODES.has(code)) throw error;
      const parent = win32.dirname(current);
      if (parent === current) throw error;
      missing.unshift(win32.basename(current));
      current = parent;
    }
  }
}

function isSameOrDescendantKey(root: string, target: string): boolean {
  const normalizedRoot = windowsPathKey(root);
  const normalizedTarget = windowsPathKey(target);
  if (normalizedTarget === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith('/')
    ? normalizedRoot
    : `${normalizedRoot}/`;
  return normalizedTarget.startsWith(prefix);
}

export function createWindowsPathProbe(
  _opts: WindowsPlatformOptions,
): WorkspacePathProbe {
  const inspect = async (value: string): Promise<WorkspacePathInfo> => {
    const target = validateWindowsPath(value);
    const nearest = await nearestExisting(target);
    const nearestReal = normalizedWindowsPath(await realpath(nearest.path));
    const nearestStats = await stat(nearest.path, { bigint: true });
    const nearestLink = await lstat(nearest.path, { bigint: true });
    const exists = nearest.missing.length === 0;
    const canonical = exists
      ? nearestReal
      : win32.join(nearestReal, ...nearest.missing);
    const closestIdentity = objectIdentity(nearestStats);
    return {
      displayPath: String(value),
      canonicalPath: normalizedWindowsPath(canonical),
      identity: exists
        ? closestIdentity
        : `missing:${closestIdentity}:${windowsPathKey(
          win32.relative(nearestReal, canonical),
        )}`,
      nearestExistingAncestor: nearestReal,
      isDirectory: exists ? nearestStats.isDirectory() : false,
      isReparsePoint: nearestLink.isSymbolicLink(),
      exists,
    };
  };

  return {
    inspect,
    async isSameOrDescendant(root, target) {
      const [left, right] = await Promise.all([inspect(root), inspect(target)]);
      return isSameOrDescendantKey(left.canonicalPath, right.canonicalPath);
    },
    async isSameObject(left, right) {
      const [a, b] = await Promise.all([inspect(left), inspect(right)]);
      if (a.exists && b.exists) return a.identity === b.identity;
      return windowsPathKey(a.canonicalPath) === windowsPathKey(b.canonicalPath);
    },
  };
}

export function windowsProtectedRoots(
  opts: WindowsPlatformOptions,
): ProtectedRoot[] {
  const credentials = opts.credentialDirs ?? [
    win32.join(opts.home, '.ssh'),
    win32.join(opts.home, '.aws'),
    win32.join(opts.home, '.config'),
    win32.join(opts.home, '.gnupg'),
    win32.join(opts.home, '.git-credentials'),
    win32.join(opts.home, '.gitconfig'),
  ];
  const rawRoots: ProtectedRoot[] = [
    { path: opts.home, policy: 'boundary' },
    ...(opts.volumes ?? []).map((path) => ({
      path,
      policy: 'boundary' as const,
    })),
    { path: opts.windowsDir, policy: 'closure' },
    { path: opts.programFiles, policy: 'closure' },
    ...(opts.programFilesX86
      ? [{ path: opts.programFilesX86, policy: 'closure' as const }]
      : []),
    ...(opts.programData
      ? [{ path: opts.programData, policy: 'closure' as const }]
      : []),
    { path: opts.appData, policy: 'closure' },
    { path: opts.localAppData, policy: 'closure' },
    { path: opts.dataDir, policy: 'closure' },
    ...credentials.map((path) => ({ path, policy: 'closure' as const })),
  ];

  const seen = new Set<string>();
  return rawRoots.map((root) => ({
    ...root,
    path: normalizedWindowsPath(root.path).replace(/\\/g, '/'),
  })).filter((root) => {
    const key = windowsPathKey(root.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
