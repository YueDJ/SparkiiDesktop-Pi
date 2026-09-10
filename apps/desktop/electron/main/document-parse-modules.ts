import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { resolveDocumentParsePaths } from './document-parse-layout.js';

export const DOWNLOAD_UNREACHABLE = '网络不可达，请改用导入离线包。';
export const IMPORT_UNRECOGNIZED = '无法识别该离线包。';

export const PRODUCTION_DOWNLOAD_HOSTS = [
  'paddle-model-ecology.bj.bcebos.com',
  'paddleocr.bj.bcebos.com',
] as const;

const SHA256_HEX = /^[0-9a-f]{64}$/i;

export type DocumentParseModuleDef = {
  id: string;
  label: string;
  bundled?: boolean;
  minBytes?: number;
  target?: string;
  url?: string;
  sha256?: string;
};

export type DocumentParseModuleInfo = DocumentParseModuleDef & {
  installed: boolean;
  canDownload: boolean;
};

export type DocumentParseModulesOpts = {
  catalog?: DocumentParseModuleDef[];
  catalogPath?: string;
  modelsDir?: string;
  extraAllowedHosts?: string[];
  fetchImpl?: typeof fetch;
};

export function defaultModulesCatalogPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '../../runtime/document-parse/modules.json');
}

export function moduleCanDownload(mod: DocumentParseModuleDef): boolean {
  return Boolean(mod.url && mod.sha256 && SHA256_HEX.test(mod.sha256));
}

export function isBlockedDownloadHost(hostname: string): boolean {
  const host = hostname.replace(/\.$/, '').toLowerCase();
  return host === 'huggingface.co'
    || host.endsWith('.huggingface.co')
    || host === 'hf.co'
    || host.endsWith('.hf.co');
}

export function assertDownloadHostAllowed(url: string, extraAllowedHosts: string[] = []): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(DOWNLOAD_UNREACHABLE);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(DOWNLOAD_UNREACHABLE);
  }
  const host = parsed.hostname.replace(/\.$/, '').toLowerCase();
  if (isBlockedDownloadHost(host)) {
    throw new Error(DOWNLOAD_UNREACHABLE);
  }
  const allowed = new Set<string>([...PRODUCTION_DOWNLOAD_HOSTS, ...extraAllowedHosts]);
  if (!allowed.has(host)) {
    throw new Error(DOWNLOAD_UNREACHABLE);
  }
}

export async function loadModulesCatalog(opts: DocumentParseModulesOpts = {}): Promise<DocumentParseModuleDef[]> {
  if (opts.catalog) return opts.catalog;
  const path = opts.catalogPath ?? defaultModulesCatalogPath();
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { modules?: DocumentParseModuleDef[] };
    return Array.isArray(raw.modules) ? raw.modules : [];
  } catch {
    return [];
  }
}

export async function listInstalledOptional(modelsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(modelsDir, 'optional'), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function listDocumentParseModules(
  opts: DocumentParseModulesOpts = {},
): Promise<DocumentParseModuleInfo[]> {
  const catalog = await loadModulesCatalog(opts);
  const modelsDir = opts.modelsDir ?? resolveDocumentParsePaths().models;
  const installed = new Set(await listInstalledOptional(modelsDir));
  return catalog.map((mod) => ({
    ...mod,
    installed: mod.bundled === true || installed.has(mod.id),
    canDownload: moduleCanDownload(mod),
  }));
}

function optionalDir(modelsDir: string, id: string): string {
  return join(modelsDir, 'optional', id);
}

async function placePayload(modelsDir: string, id: string, sourcePath: string): Promise<void> {
  const destDir = optionalDir(modelsDir, id);
  await mkdir(destDir, { recursive: true });
  const dest = join(destDir, basename(sourcePath));
  await cp(sourcePath, dest, { recursive: true });
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export async function downloadDocumentParseModule(
  id: string,
  opts: DocumentParseModulesOpts = {},
): Promise<{ ok: true; destDir: string }> {
  const catalog = await loadModulesCatalog(opts);
  const mod = catalog.find((m) => m.id === id);
  if (!mod || !moduleCanDownload(mod) || !mod.url || !mod.sha256) {
    throw new Error(DOWNLOAD_UNREACHABLE);
  }
  assertDownloadHostAllowed(mod.url, opts.extraAllowedHosts);
  const modelsDir = opts.modelsDir ?? resolveDocumentParsePaths().models;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const tmpRoot = join(modelsDir, '.download-tmp', `${id}-${Date.now()}`);
  await mkdir(tmpRoot, { recursive: true });
  const tmpFile = join(tmpRoot, basename(new URL(mod.url).pathname) || `${id}.bin`);
  try {
    let res: Response;
    try {
      res = await fetchImpl(mod.url, { redirect: 'error' });
    } catch {
      throw new Error(DOWNLOAD_UNREACHABLE);
    }
    if (!res.ok) throw new Error(DOWNLOAD_UNREACHABLE);
    const body = res.body;
    if (!body) throw new Error(DOWNLOAD_UNREACHABLE);
    try {
      await pipeline(
        Readable.fromWeb(body as import('node:stream/web').ReadableStream),
        createWriteStream(tmpFile),
      );
    } catch {
      throw new Error(DOWNLOAD_UNREACHABLE);
    }

    const buf = await readFile(tmpFile);
    if (sha256Hex(buf) !== mod.sha256.toLowerCase()) {
      throw new Error('sha256 mismatch');
    }
    const minBytes = typeof mod.minBytes === 'number' ? mod.minBytes : 0;
    if (buf.length < minBytes) {
      throw new Error(DOWNLOAD_UNREACHABLE);
    }
    await placePayload(modelsDir, id, tmpFile);
    return { ok: true, destDir: optionalDir(modelsDir, id) };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

function stem(fileName: string): string {
  const base = basename(fileName);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

export function matchModuleByFilename(
  filePath: string,
  catalog: DocumentParseModuleDef[],
): DocumentParseModuleDef | undefined {
  const base = basename(filePath);
  const name = stem(base);
  return catalog.find((m) => {
    if (m.bundled) return false;
    const targetName = m.target ? basename(m.target) : m.id;
    return base === m.id
      || name === m.id
      || base === targetName
      || name === targetName
      || base.startsWith(`${m.id}.`)
      || base.startsWith(`${targetName}.`);
  });
}

export async function importDocumentParseModule(
  filePath: string,
  opts: DocumentParseModulesOpts = {},
): Promise<{ ok: true; id: string; destDir: string }> {
  const catalog = await loadModulesCatalog(opts);
  const mod = matchModuleByFilename(filePath, catalog);
  if (!mod) throw new Error(IMPORT_UNRECOGNIZED);
  let info: { size: number; isDirectory: boolean };
  try {
    const st = await stat(filePath);
    info = { size: st.size, isDirectory: st.isDirectory() };
  } catch {
    throw new Error(IMPORT_UNRECOGNIZED);
  }
  const minBytes = typeof mod.minBytes === 'number' ? mod.minBytes : 0;
  if (!info.isDirectory && info.size < minBytes) {
    throw new Error(IMPORT_UNRECOGNIZED);
  }
  const modelsDir = opts.modelsDir ?? resolveDocumentParsePaths().models;
  await placePayload(modelsDir, mod.id, filePath);
  return { ok: true, id: mod.id, destDir: optionalDir(modelsDir, mod.id) };
}
