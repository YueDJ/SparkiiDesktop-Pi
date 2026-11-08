// G3 · downloader 单测：下载进度累加、取消清理 .part 且不丢已完成包；
// sha512/bytes 终检失败拒绝入 pending/；磁盘预检；迁移前后双验；伴生清单落下。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAuditThrottle } from '../../electron/main/update/audit.js';
import { pendingVersionDir } from '../../electron/main/update/dirs.js';
import {
  cancelDownload, finalizeDownload, planDownload, ProgressAccumulator, verifyArtifactBytes,
} from '../../electron/main/update/downloader.js';
import type { ReleaseJson } from '../../electron/main/update/types.js';

const VERSION = '0.3.0';
const NAME = 'Sparkii-0.3.0-win-x64.exe';
const ARTIFACT = Buffer.from('ARTIFACT-BYTES-0123456789-ABCDEF-XYZ');
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
    requires: { minOSBuild: '10.0.0', minFreeDiskBytes: 100 },
    ...over,
  };
}

describe('ProgressAccumulator', () => {
  it('字节累加与百分比（0..100 钳制）', () => {
    const p = new ProgressAccumulator(100);
    expect(p.snapshot(null).percent).toBe(0);
    p.add(30);
    expect(p.bytesDownloaded).toBe(30);
    expect(p.percent()).toBe(30);
    p.add(70);
    expect(p.percent()).toBe(100);
    p.add(50);
    expect(p.percent()).toBe(100); // 钳制
    expect(p.snapshot('C:/x').savePath).toBe('C:/x');
  });
  it('bytesTotal=0 不除零', () => {
    expect(new ProgressAccumulator(0).percent()).toBe(0);
  });
});

describe('verifyArtifactBytes', () => {
  let dir: string;
  let file: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sparkii-vab-')); file = join(dir, 'a.bin'); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('sha512 + bytes 一致 → ok', async () => {
    writeFileSync(file, ARTIFACT);
    expect(await verifyArtifactBytes(file, SHA512, ARTIFACT.length)).toEqual({ ok: true });
  });
  it('字节被篡改（sha512 不符）→ 失败', async () => {
    const b = Buffer.from(ARTIFACT); b[0] ^= 0xff;
    writeFileSync(file, b);
    expect((await verifyArtifactBytes(file, SHA512, ARTIFACT.length)).ok).toBe(false);
  });
  it('size 不符 → 失败', async () => {
    writeFileSync(file, ARTIFACT);
    expect((await verifyArtifactBytes(file, SHA512, ARTIFACT.length - 1)).ok).toBe(false);
  });
  it('文件不存在 → 失败', async () => {
    expect((await verifyArtifactBytes(join(dir, 'missing'), SHA512, ARTIFACT.length)).ok).toBe(false);
  });
});

describe('planDownload', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sparkii-plan-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('准备 pending/<v>/、.part 命名、bytesCap=artifact.bytes', async () => {
    const plan = await planDownload({ dataDir: dir, release: release(), freeDiskBytes: 10 ** 12 });
    expect(plan.ok).toBe(true);
    expect(plan.bytesCap).toBe(ARTIFACT.length);
    expect(plan.expectedSha512).toBe(SHA512);
    expect(plan.partPath.endsWith(`${NAME}.part`)).toBe(true);
    expect(plan.finalPath.endsWith(NAME)).toBe(true);
    expect(plan.pendingDir).toBe(pendingVersionDir(dir, VERSION));
    expect(existsSync(plan.pendingDir)).toBe(true);
  });

  it('磁盘预检不足 → ok:false REQUIRES_UNMET', async () => {
    const plan = await planDownload({ dataDir: dir, release: release(), freeDiskBytes: 0 });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe('REQUIRES_UNMET');
  });
});

describe('finalizeDownload', () => {
  let dir: string;
  let plan: Awaited<ReturnType<typeof planDownload>>;
  let cached: string;
  const audit = { append: vi.fn(async () => ({})) };
  const releaseBytes = Buffer.from('{"release":1}');
  const channelBytes = Buffer.from('{"channel":1}');
  const releaseSigText = '{"kid":"k","signature":"s"}';
  const channelSigText = '{"kid":"k","signature":"c"}';

  beforeEach(async () => {
    resetAuditThrottle();
    dir = mkdtempSync(join(tmpdir(), 'sparkii-final-'));
    plan = await planDownload({ dataDir: dir, release: release(), freeDiskBytes: 10 ** 12 });
    cached = join(dir, 'updater-cache', 'download.part');
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(cached, ARTIFACT);
    audit.append.mockClear();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const common = () => ({
    dataDir: dir, plan, cachedFilePath: cached,
    releaseBytes, releaseSigText, channelBytes, channelSigText, audit,
  });

  it('迁移前后各验一次 → 落包 + 落伴生清单（4 个文件），清理缓存/.part', async () => {
    const r = await finalizeDownload(common());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.artifactPath).toBe(plan.finalPath);
    expect(readFileSync(plan.finalPath).equals(ARTIFACT)).toBe(true);
    expect(readFileSync(join(plan.pendingDir, 'release.json')).equals(releaseBytes)).toBe(true);
    expect(readFileSync(join(plan.pendingDir, 'release.json.sig'), 'utf8')).toBe(releaseSigText);
    expect(readFileSync(join(plan.pendingDir, 'channel.json')).equals(channelBytes)).toBe(true);
    expect(readFileSync(join(plan.pendingDir, 'channel.json.sig'), 'utf8')).toBe(channelSigText);
    expect(existsSync(cached)).toBe(false);
    expect(existsSync(plan.partPath)).toBe(false);
  });

  it('迁移前 sha512 不符 → 拒绝入 pending/，删坏包 + 写审计', async () => {
    const bad = Buffer.from(ARTIFACT); bad[0] ^= 0xff;
    writeFileSync(cached, bad);
    const r = await finalizeDownload(common());
    expect(r.ok).toBe(false);
    expect(existsSync(plan.finalPath)).toBe(false);
    expect(existsSync(cached)).toBe(false);
    expect(audit.append).toHaveBeenCalled();
  });

  it('迁移前 bytes 不符 → 拒绝入 pending/', async () => {
    writeFileSync(cached, ARTIFACT.subarray(1));
    const r = await finalizeDownload(common());
    expect(r.ok).toBe(false);
    expect(existsSync(plan.finalPath)).toBe(false);
  });
});

describe('cancelDownload', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sparkii-cancel-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('只清 .part，回 available 且不丢已完成的包与伴生清单', async () => {
    const vdir = pendingVersionDir(dir, VERSION);
    mkdirSync(vdir, { recursive: true });
    writeFileSync(join(vdir, `${NAME}.part`), 'partial-download');
    writeFileSync(join(vdir, NAME), ARTIFACT);            // 已完成的包
    writeFileSync(join(vdir, 'release.json'), 'companion'); // 伴生清单
    const removed = await cancelDownload(dir, VERSION);
    expect(removed).toBe(1);
    expect(existsSync(join(vdir, `${NAME}.part`))).toBe(false);
    expect(existsSync(join(vdir, NAME))).toBe(true);        // 不丢
    expect(existsSync(join(vdir, 'release.json'))).toBe(true);
  });

  it('无 pending 目录时安全返回 0', async () => {
    expect(await cancelDownload(dir, '9.9.9')).toBe(0);
  });
});
