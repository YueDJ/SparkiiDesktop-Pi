// G3 · updater-adapter 单测：
//  autoDownload===false / disableDifferentialDownload===true；executor 注入在 setFeedURL 之前；
//  request() 只接受约定本地路径、其它 scheme 抛错；
//  download() 拒绝重定向 / host 不符 / 超字节 / sha512 不符；crossCheckUpdateInfo 二次比对；
//  writeDerivedFeed 返回 file:// URL。
// 用离线 http.createServer 模拟静态源；不联网、不真实服务器；不 mock 验签本身。

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAuditThrottle } from '../../electron/main/update/audit.js';
import { latestYmlPath } from '../../electron/main/update/dirs.js';
import {
  createLocalFeedExecutor, createUpdater, crossCheckUpdateInfo, writeDerivedFeed,
  type NsisUpdaterLike, type RequestOptions,
} from '../../electron/main/update/updater-adapter.js';
import type { ReleaseJson } from '../../electron/main/update/types.js';

const VERSION = '0.3.0';
const NAME = 'Sparkii-0.3.0-win-x64.exe';
const ARTIFACT = Buffer.from('ARTIFACT-BYTES-0123456789-ABCDEF');
const SHA512 = createHash('sha512').update(ARTIFACT).digest('base64');

function release(over: Partial<ReleaseJson> = {}): ReleaseJson {
  return {
    schemaVersion: 2, product: 'Sparkii', channel: 'stable', platform: 'win-x64',
    sequence: 1, nonce: 'n', publishedAt: '2026-11-06T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z', version: VERSION,
    minSupportedVersion: '0.1.0', rollback: false, allowDowngrade: false,
    mandatory: false, mandatoryAfter: null, rollout: { percentage: 100, salt: 's' },
    releaseNotes: { summary: '', highlights: [] },
    artifact: { name: NAME, bytes: ARTIFACT.length, sha512: SHA512, url: `releases/${VERSION}/${NAME}` },
    requires: { minOSBuild: '10.0.0', minFreeDiskBytes: 0 },
    ...over,
  };
}

const YML = [
  `version: ${VERSION}`,
  'files:',
  `  - url: http://127.0.0.1:1/releases/${VERSION}/${NAME}`,
  `    sha512: ${SHA512}`,
  `    size: ${ARTIFACT.length}`,
  `path: ${NAME}`,
  `sha512: ${SHA512}`,
  `size: ${ARTIFACT.length}`,
  "releaseDate: '2026-11-06T00:00:00.000Z'",
  '',
].join('\n');

/** 记录 httpExecutor 赋值与 setFeedURL 调用顺序的 fake updater。 */
function fakeUpdater(): NsisUpdaterLike & {
  order: string[]; feedConfig: { provider: string; url: string } | null;
} {
  const rec = {
    // 哨兵初值：createUpdater 必须把它显式写成 false（证明赋值真实发生）。
    autoDownload: 'unset' as unknown as boolean,
    autoInstallOnAppQuit: 'unset' as unknown as boolean,
    disableDifferentialDownload: 'unset' as unknown as boolean,
    httpExecutor: undefined as unknown,
    order: [] as string[],
    feedConfig: null as { provider: string; url: string } | null,
    set httpExecutor(_v: unknown) { /* 由 Object.defineProperty 覆盖 */ },
  };
  // 用显式 setter 捕获赋值时机。
  let executorValue: unknown;
  Object.defineProperty(rec, 'httpExecutor', {
    get: () => executorValue,
    set: (v: unknown) => { executorValue = v; rec.order.push('inject'); },
    enumerable: true,
    configurable: true,
  });
  Object.assign(rec, {
    setFeedURL(cfg: { provider: string; url: string }) {
      rec.order.push('setFeedURL');
      rec.feedConfig = cfg;
    },
    async checkForUpdates() { return { updateInfo: {} }; },
    async downloadUpdate() { return []; },
    on() { return rec; },
    removeListener() { return rec; },
  });
  return rec as unknown as NsisUpdaterLike & {
    order: string[]; feedConfig: { provider: string; url: string } | null;
  };
}

interface ServerHandle {
  baseUrl: string;
  close(): Promise<void>;
  setHandler(fn: (req: http.IncomingMessage, res: http.ServerResponse) => void): void;
}

async function startServer(): Promise<ServerHandle> {
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) => {
    res.writeHead(200, { 'content-length': String(ARTIFACT.length) }); res.end(ARTIFACT);
  };
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/`,
    setHandler(fn) { handler = fn; },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('writeDerivedFeed', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sparkii-feed-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('原子写 latest.yml 并返回 file:// feed URL', async () => {
    const url = await writeDerivedFeed(dir, YML);
    expect(url.startsWith('file://')).toBe(true);
    expect(url.endsWith('/feed/')).toBe(true);
    expect(existsSync(latestYmlPath(dir))).toBe(true);
    expect(readFileSync(latestYmlPath(dir), 'utf8')).toBe(YML);
  });
});

describe('createUpdater（§5.2 定案 A 三开关 + 注入顺序）', () => {
  let dir: string;
  let server: ServerHandle;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sparkii-updater-'));
    server = await startServer();
  });
  afterEach(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('autoDownload===false / autoInstallOnAppQuit===false / disableDifferentialDownload===true', () => {
    const fake = fakeUpdater();
    createUpdater({
      dataDir: dir, feedUrl: 'file:///C:/feed/', baseUrl: server.baseUrl,
      release: release(), updater: fake,
    });
    expect(fake.autoDownload).toBe(false);
    expect(fake.autoInstallOnAppQuit).toBe(false);
    expect(fake.disableDifferentialDownload).toBe(true);
  });

  it('executor 注入在 setFeedURL 之前（order = [inject, setFeedURL]）', () => {
    const fake = fakeUpdater();
    createUpdater({
      dataDir: dir, feedUrl: 'file:///C:/feed/', baseUrl: server.baseUrl,
      release: release(), updater: fake,
    });
    expect(fake.order).toEqual(['inject', 'setFeedURL']);
    expect(fake.feedConfig).toEqual({ provider: 'generic', url: 'file:///C:/feed/' });
  });

  it('三个开关由哨兵值被显式改写为 false/false/true（证明赋值真实发生）', () => {
    const fake = fakeUpdater();
    expect(fake.autoDownload).not.toBe(false);
    createUpdater({
      dataDir: dir, feedUrl: 'file:///C:/feed/', baseUrl: server.baseUrl,
      release: release(), updater: fake,
    });
    expect(fake.autoDownload).toBe(false);
    expect(fake.autoInstallOnAppQuit).toBe(false);
    expect(fake.disableDifferentialDownload).toBe(true);
  });
});

describe('createLocalFeedExecutor.request()', () => {
  let dir: string;
  let server: ServerHandle;
  let executor: ReturnType<typeof createLocalFeedExecutor>;
  let feedUrl: string;
  beforeEach(async () => {
    resetAuditThrottle();
    dir = mkdtempSync(join(tmpdir(), 'sparkii-exec-'));
    server = await startServer();
    feedUrl = await writeDerivedFeed(dir, YML);
    executor = createLocalFeedExecutor({ dataDir: dir, baseUrl: server.baseUrl, release: release() });
  });
  afterEach(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const fileOpts = (path: string): RequestOptions => ({
    protocol: 'file:', hostname: '', path,
  });

  it('只接受约定本地 latest.yml 路径（含 ?noCache= query）→ 返回派生文件 Buffer', async () => {
    // 模拟 configureRequestUrl 写入的 options：path 带 ?noCache=
    const p = latestYmlPath(dir).replace(/\\/g, '/');
    const opts: RequestOptions = fileOpts(`/${p}?noCache=abc`);
    const buf = await executor.request(opts);
    expect(buf.toString('utf8')).toBe(YML);
  });

  it('file: 但路径非 latest.yml（越界）→ 抛错 fail closed', async () => {
    const p = join(dir, 'updates', 'feed', 'other.yml').replace(/\\/g, '/');
    await expect(executor.request(fileOpts(`/${p}`))).rejects.toThrow();
  });

  it('其它 scheme（http/https）→ 抛错 fail closed', async () => {
    await expect(executor.request({
      protocol: 'http:', hostname: '127.0.0.1', path: '/channel.json',
    })).rejects.toThrow(/only file/);
    await expect(executor.request({ url: new URL('https://evil.invalid/x') })).rejects.toThrow(/only file/);
  });

  it('maxRedirects 恒为 0', () => {
    expect(executor.maxRedirects).toBe(0);
  });
});

describe('createLocalFeedExecutor.download()', () => {
  let dir: string;
  let server: ServerHandle;
  let executor: ReturnType<typeof createLocalFeedExecutor>;
  let dest: string;
  const audit = { append: vi.fn(async () => ({})) };

  beforeEach(async () => {
    resetAuditThrottle();
    dir = mkdtempSync(join(tmpdir(), 'sparkii-dl-'));
    server = await startServer();
    dest = join(dir, 'out.part');
    audit.append.mockClear();
    executor = createLocalFeedExecutor({
      dataDir: dir, baseUrl: server.baseUrl, release: release(), audit,
    });
  });
  afterEach(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const dl = (url: URL, over: Record<string, unknown> = {}) =>
    executor.download(url, dest, {
      expectedBytes: ARTIFACT.length, expectedSha512: SHA512, timeoutMs: 3000, ...over,
    });

  it('正常 200 + sha512/bytes 一致 → 落盘且返回 destination', async () => {
    const result = await dl(new URL(`releases/${VERSION}/${NAME}`, server.baseUrl));
    expect(result).toBe(dest);
    expect(readFileSync(dest).equals(ARTIFACT)).toBe(true);
  });

  it('onProgress 累加字节与百分比', async () => {
    const progress: number[] = [];
    await dl(new URL(`releases/${VERSION}/${NAME}`, server.baseUrl), {
      onProgress: (p: { bytesDownloaded: number }) => progress.push(p.bytesDownloaded),
    });
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(ARTIFACT.length);
  });

  it('拒绝 3xx 重定向（不跟随）', async () => {
    server.setHandler((_req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1:1/evil' }); res.end('go');
    });
    await expect(dl(new URL(`releases/${VERSION}/${NAME}`, server.baseUrl))).rejects.toThrow();
    expect(existsSync(dest)).toBe(false);
  });

  it('host 不符 → 抛错（url 与 baseUrl 不同 host/port）', async () => {
    await expect(dl(new URL('http://127.0.0.1:1/x.exe'))).rejects.toThrow(/origin mismatch/);
  });

  it('超字节（expectedBytes 小于实际）→ 立即 abort 并删除坏包', async () => {
    await expect(executor.download(new URL(`releases/${VERSION}/${NAME}`, server.baseUrl), dest, {
      expectedBytes: ARTIFACT.length - 1, expectedSha512: SHA512, timeoutMs: 3000,
    })).rejects.toThrow();
    expect(existsSync(dest)).toBe(false);
  });

  it('sha512 不符 → 复核失败、删除坏包、写审计', async () => {
    await expect(executor.download(new URL(`releases/${VERSION}/${NAME}`, server.baseUrl), dest, {
      expectedBytes: ARTIFACT.length, expectedSha512: createHash('sha512').update('wrong').digest('base64'),
      timeoutMs: 3000,
    })).rejects.toThrow();
    expect(existsSync(dest)).toBe(false);
    expect(audit.append).toHaveBeenCalled();
  });

  it('https→http 降级：baseUrl 为 https 时拒绝 http url', async () => {
    const httpsExec = createLocalFeedExecutor({
      dataDir: dir, baseUrl: 'https://127.0.0.1:443/', release: release(),
    });
    await expect(httpsExec.download(new URL('http://127.0.0.1/x.exe'), dest, {
      expectedBytes: ARTIFACT.length, expectedSha512: SHA512,
    })).rejects.toThrow();
  });
});

describe('crossCheckUpdateInfo（§6.5 二次保险）', () => {
  const rel = release();
  it('逐字段一致 → ok', () => {
    expect(crossCheckUpdateInfo({
      version: VERSION, path: NAME, sha512: SHA512, size: ARTIFACT.length,
      files: [{ url: `http://x/releases/${VERSION}/${NAME}`, sha512: SHA512, size: ARTIFACT.length }],
    }, rel)).toEqual({ ok: true });
  });
  it('version 不符 → 失败', () => {
    expect(crossCheckUpdateInfo({ version: '9.9.9', path: NAME, sha512: SHA512, size: ARTIFACT.length }, rel).ok).toBe(false);
  });
  it('path 不符 → 失败', () => {
    expect(crossCheckUpdateInfo({ version: VERSION, path: 'evil.exe', sha512: SHA512, size: ARTIFACT.length }, rel).ok).toBe(false);
  });
  it('sha512 不符 → 失败', () => {
    expect(crossCheckUpdateInfo({ version: VERSION, path: NAME, sha512: 'AAAA', size: ARTIFACT.length }, rel).ok).toBe(false);
  });
  it('size 不符 → 失败', () => {
    expect(crossCheckUpdateInfo({ version: VERSION, path: NAME, sha512: SHA512, size: 1 }, rel).ok).toBe(false);
  });
  it('空 info → 失败', () => {
    expect(crossCheckUpdateInfo(null, rel).ok).toBe(false);
  });
});
