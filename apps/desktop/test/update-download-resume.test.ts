/**
 * 主 Agent 集成单测：httpExecutor 的 Range 断点续传、超时口径与 .part 语义（§7.6 / C1 / §5.2）。
 * 用真实 loopback http.Server（含 Range 支持），不 mock 验签、不 mock 下载。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAuditThrottle } from '../electron/main/update/audit.js';
import {
  createLocalFeedExecutor, STALL_TIMEOUT_MS, type CustomHttpExecutor,
} from '../electron/main/update/updater-adapter.js';
import { PART_SUFFIX } from '../electron/main/update/downloader.js';
import type { ReleaseJson } from '../electron/main/update/types.js';

const VERSION = '0.3.0';
const NAME = 'Sparkii-0.3.0-win-x64.exe';
const BODY = Buffer.concat([Buffer.from('RESUME-'), Buffer.alloc(4096, 0x41), Buffer.from('-TAIL')]);
const SHA512 = createHash('sha512').update(BODY).digest('base64');

function release(): ReleaseJson {
  return {
    schemaVersion: 2, product: 'Sparkii', channel: 'stable', platform: 'win-x64',
    sequence: 3, nonce: 'n-3',
    publishedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    version: VERSION, minSupportedVersion: '0.1.0',
    rollback: false, allowDowngrade: false, mandatory: false, mandatoryAfter: null,
    rollout: { percentage: 100, salt: 's' },
    releaseNotes: { summary: 'x', highlights: [] },
    artifact: { name: NAME, bytes: BODY.length, sha512: SHA512, url: `releases/${VERSION}/${NAME}` },
    requires: { minOSBuild: '10.0.0', minFreeDiskBytes: 0 },
  };
}

interface ServerHandle {
  baseUrl: string;
  url(path: string): URL;
  close(): Promise<void>;
}

/** 支持 Range 的最小静态服务；ignoreRange=true 时故意只回整包，slow=true 时分块慢发。 */
async function startServer(opts: { ignoreRange?: boolean; hang?: boolean; slow?: boolean; fakePartial?: boolean } = {}): Promise<ServerHandle> {
  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? '').split('?')[0];
    if (pathname !== `/releases/${VERSION}/${NAME}`) { res.writeHead(404); res.end('nf'); return; }
    if (opts.hang) return; // 不发响应头，用于连接超时
    const range = req.headers.range;
    // 服务端**没被要求 Range 却自己回 206**（CDN / 反代坏配置的一种形态）：
    // executor 必须拒——那 206 声称是"部分内容"，但我们手里根本没有可比的对端偏移。
    if (opts.fakePartial && !range) {
      res.writeHead(206, { 'content-length': String(BODY.length), 'content-range': `bytes 0-${BODY.length - 1}/${BODY.length}` });
      res.end(BODY);
      return;
    }
    if (range && !opts.ignoreRange) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(String(range));
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : BODY.length - 1;
      if (start >= BODY.length || end >= BODY.length || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${BODY.length}` });
        res.end();
        return;
      }
      const slice = BODY.subarray(start, end + 1);
      res.writeHead(206, { 'content-length': String(slice.length), 'content-range': `bytes ${start}-${end}/${BODY.length}` });
      res.end(slice);
      return;
    }
    if (!opts.slow) {
      res.writeHead(200, { 'content-length': String(BODY.length) });
      res.end(BODY);
      return;
    }
    // 慢速模式：先回响应头，再每 10ms 滴一块，便于稳定地在流中间取消
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    let offset = 0;
    const drip = () => {
      if (offset >= BODY.length) { res.end(); return; }
      const next = BODY.subarray(offset, Math.min(BODY.length, offset + 256));
      offset += next.length;
      res.write(next);
      setTimeout(drip, 10);
    };
    drip();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}/`;
  return {
    baseUrl,
    url: (p: string) => new URL(p, baseUrl),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('updater 缺件与投毒信号的区分（§5.2 / §6.5）', () => {
  it('UpdaterUnavailableError 被 isUpdaterUnavailable 认出；普通错误不被误判', async () => {
    const { UpdaterUnavailableError, isUpdaterUnavailable } = await import('../electron/main/update/updater-adapter.js');
    expect(isUpdaterUnavailable(new UpdaterUnavailableError('module missing'))).toBe(true);
    // 鸭子形态也要认（跨模块边界 / 打包后 instanceof 可能失效）
    expect(isUpdaterUnavailable(Object.assign(new Error('x'), { updaterUnavailable: true }))).toBe(true);
    expect(isUpdaterUnavailable(new Error('ARTIFACT_INVALID: sha512 mismatch'))).toBe(false);
    expect(isUpdaterUnavailable(null)).toBe(false);
    expect(isUpdaterUnavailable(undefined)).toBe(false);
    expect(new UpdaterUnavailableError('m').message).toContain('updater unavailable');
  });
});

describe('httpExecutor.download · Range 断点续传（§7.6）', () => {
  let dir: string;
  let server: ServerHandle;
  let executor: CustomHttpExecutor;
  let dest: string;
  const audit = { append: vi.fn(async () => ({})) };

  beforeEach(async () => {
    resetAuditThrottle();
    dir = mkdtempSync(join(tmpdir(), 'sparkii-resume-'));
    server = await startServer();
    dest = join(dir, NAME);
    audit.append.mockClear();
    executor = createLocalFeedExecutor({
      dataDir: dir, baseUrl: server.baseUrl, release: release(), audit,
    });
  });
  afterEach(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const dl = (over: Record<string, unknown> = {}) => executor.download(
    server.url(`releases/${VERSION}/${NAME}`), dest,
    { expectedBytes: BODY.length, expectedSha512: SHA512, timeoutMs: 3000, ...over },
  );

  it('无 .part → 整包 200 下载，成功后 .part 已被改名清除', async () => {
    const out = await dl();
    expect(out).toBe(dest);
    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(existsSync(`${dest}${PART_SUFFIX}`)).toBe(false);
  });

  it('已有前缀 .part → 带 Range 续传，终检按整文件 sha512 通过', async () => {
    const head = BODY.subarray(0, 1000);
    writeFileSync(`${dest}${PART_SUFFIX}`, head);
    const progress: number[] = [];
    await dl({ onProgress: (p: { bytesDownloaded: number }) => progress.push(p.bytesDownloaded) });
    expect(readFileSync(dest).equals(BODY)).toBe(true);
    // 续传时首次上报的字节数就是已有前缀（不从头计数）
    expect(progress[0]).toBe(head.length);
    expect(progress[progress.length - 1]).toBe(BODY.length);
    expect(existsSync(`${dest}${PART_SUFFIX}`)).toBe(false);
  });

  it('服务端忽略 Range（回 200 整包）→ 丢弃预热哈希、整包重写且校验通过', async () => {
    await server.close();
    server = await startServer({ ignoreRange: true });
    executor = createLocalFeedExecutor({
      dataDir: dir, baseUrl: server.baseUrl, release: release(), audit,
    });
    writeFileSync(`${dest}${PART_SUFFIX}`, BODY.subarray(0, 500));
    await executor.download(server.url(`releases/${VERSION}/${NAME}`), dest, {
      expectedBytes: BODY.length, expectedSha512: SHA512, timeoutMs: 3000,
    });
    expect(readFileSync(dest).equals(BODY)).toBe(true);
  });

  it('服务端没被要求 Range 却回 206 ⇒ 一律拒绝，不拿它当"续传成功"（R14 · Minor：这条分支此前零覆盖）', async () => {
    await server.close();
    server = await startServer({ fakePartial: true });
    executor = createLocalFeedExecutor({
      dataDir: dir, baseUrl: server.baseUrl, release: release(), audit,
    });
    // 现场：本地**没有** .part（resumed=0），而服务器自称回的是部分内容。
    // 收下它就等于把一个无法证明偏移的字节流当成整包 ⇒ 必须拒。
    await expect(executor.download(server.url(`releases/${VERSION}/${NAME}`), dest, {
      expectedBytes: BODY.length, expectedSha512: SHA512, timeoutMs: 3000,
    })).rejects.toThrow(/206 without a Range/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}${PART_SUFFIX}`)).toBe(false);
  });

  it('.part 已被写坏（内容不对）→ 终检 sha512 失败并删除 .part，绝不留半成品', async () => {
    writeFileSync(`${dest}${PART_SUFFIX}`, Buffer.alloc(1000, 0x42)); // 长度对但内容错
    await expect(dl()).rejects.toThrow(/sha512 mismatch/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}${PART_SUFFIX}`)).toBe(false);
    expect(audit.append).toHaveBeenCalled();
  });

  it('.part 已 ≥ 包体大小（不可能有效）→ 直接重下而不是硬拼', async () => {
    writeFileSync(`${dest}${PART_SUFFIX}`, Buffer.alloc(BODY.length + 10, 0x42));
    await dl();
    expect(readFileSync(dest).equals(BODY)).toBe(true);
  });

  it('cancellationToken 取消 → 删 .part（取消不保留现场）', async () => {
    await server.close();
    server = await startServer({ slow: true });
    executor = createLocalFeedExecutor({
      dataDir: dir, baseUrl: server.baseUrl, release: release(), audit,
    });
    let cancelCb: (() => void) | null = null;
    const token = { cancelled: false, onCancelled(cb: () => void) { cancelCb = cb; } };
    const pending = executor.download(server.url(`releases/${VERSION}/${NAME}`), dest, {
      expectedBytes: BODY.length, expectedSha512: SHA512, timeoutMs: 3000, cancellationToken: token,
    });
    await vi.waitFor(() => expect(existsSync(`${dest}${PART_SUFFIX}`)).toBe(true));
    token.cancelled = true;
    cancelCb?.();
    await expect(pending).rejects.toThrow();
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}${PART_SUFFIX}`)).toBe(false);
  });

  it('响应头超时只约束「连接+响应头」，不会把慢速整包误杀（§5.2）', async () => {
    await server.close();
    server = await startServer({ hang: true });
    executor = createLocalFeedExecutor({
      dataDir: dir, baseUrl: server.baseUrl, release: release(), audit,
    });
    const started = Date.now();
    await expect(executor.download(server.url(`releases/${VERSION}/${NAME}`), dest, {
      expectedBytes: BODY.length, expectedSha512: SHA512, timeoutMs: 200,
    })).rejects.toThrow();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(STALL_TIMEOUT_MS); // 远小于停滞看门狗 ⇒ 是连接超时在起作用
  });
});
