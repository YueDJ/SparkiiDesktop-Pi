/**
 * 第 1 轮审核（R2 · B2 / R1 · Minor-3）的回归钉：`version` 作为路径段的穿越面。
 * 这条之所以要单独成文：四条各自为政的宽正则曾经**同时**允许 `..`，
 * 于是一次 IPC 调用就能删掉整棵 updates 树（含防降级状态）并把裸放的清单当成合法包。
 */

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isSafeVersionSegment, pendingVersionDir, updatesDir } from '../electron/main/update/dirs.js';
import { clearPending, scanPending, verifyCompanion } from '../electron/main/update/local-artifacts.js';
import { resetAuditThrottle } from '../electron/main/update/audit.js';
import { deriveLatestYml, signatureInput, validateChannelPointer } from '../electron/main/update/verifier.js';
import { initUpdateService, type UpdateDeps } from '../electron/main/update/service.js';

const HOSTILE = ['..', '.', '.../', '../..', '0.1;rm -rf', '..\\..\\..\\Windows', '0.2.0/..', '', '0', '0.2', '0.2.0..', '~/x'];
const SAFE = ['0.1.0', '0.2.0', '0.0.5', '10.20.30', '1.0.0-beta.1', '1.0.0+build.7'];

describe('isSafeVersionSegment：路径段判据（R2 · B2）', () => {
  it('拒绝一切点段与注入形态', () => {
    for (const v of HOSTILE) expect(isSafeVersionSegment(v), v).toBe(false);
  });

  it('接受真实 semver 形态', () => {
    for (const v of SAFE) expect(isSafeVersionSegment(v), v).toBe(true);
  });

  it('pendingVersionDir 对非法段抛错，绝不拼出 updates 根或越界路径', () => {
    for (const v of HOSTILE) {
      expect(() => pendingVersionDir('C:\\data', v), v).toThrow(/unsafe version segment/);
    }
    // 合法段仍老老实实落在 pending/<version>/ 之下
    expect(pendingVersionDir('C:\\data', '0.2.0')).toBe(join('C:\\data', 'updates', 'pending', '0.2.0'));
  });
});

describe('clearPending / IPC clearDownloaded 不能再删整棵 updates 树', () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    resetAuditThrottle();
    dir = mkdtempSync(join(tmpdir(), 'sparkii-traversal-'));
    const pending = pendingVersionDir(dir, '0.2.0');
    mkdirSync(pending, { recursive: true });
    writeFileSync(join(pending, 'Sparkii-0.2.0-win-x64.exe'), 'pkg', 'utf8');
    statePath = join(updatesDir(dir), 'update-state.json');
    writeFileSync(statePath, '{"v":1,"payload":{},"mac":"x"}', 'utf8');
    mkdirSync(join(updatesDir(dir), 'feed'), { recursive: true });
    writeFileSync(join(updatesDir(dir), 'feed', 'latest.yml'), 'version: 0.2.0', 'utf8');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('clearPending("..") 是空操作：状态文件、feed、包全部存活', async () => {
    await clearPending(dir, '..');
    expect(existsSync(statePath)).toBe(true);
    expect(existsSync(join(updatesDir(dir), 'feed', 'latest.yml'))).toBe(true);
    expect(existsSync(pendingVersionDir(dir, '0.2.0'))).toBe(true);
  });

  it('合法版本仍可正常清理（不是把功能一并关掉）', async () => {
    await clearPending(dir, '0.2.0');
    expect(existsSync(pendingVersionDir(dir, '0.2.0'))).toBe(false);
    expect(existsSync(statePath)).toBe(true);   // 只清该版本目录，绝不影响兄弟内容
  });

  it('service.clearDownloaded / installUpdate / downloadUpdate 对非法 version 一律结构化拒绝，不抛给 Renderer', async () => {
    const deps = {
      dataDir: dir,
      currentVersion: '0.1.0',
      resourcesPath: join(dir, 'resources'),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      audit: { append: vi.fn(async () => ({})) },
      sendEvent: vi.fn(),
      loadSettings: async () => ({ update: { autoCheck: false } }) as never,
      saveSettings: vi.fn(async () => {}),
      keyringSecret: async () => Buffer.alloc(32, 3),
      now: () => Date.now(),
    } as unknown as UpdateDeps;
    const svc = initUpdateService(deps);
    for (const version of ['..', '../..', '0.2.0/..', '0.1;rm -rf']) {
      const cleared = await svc.clearDownloaded({ version });
      expect(cleared.ok, version).toBe(false);
      expect(cleared.reason, version).toBe('POINTER_INVALID');
      const installed = await svc.installUpdate({ version });
      expect(installed.ok, version).toBe(false);
      expect(installed.reason, version).toBe('POINTER_INVALID');
      const downloaded = await svc.downloadUpdate({ version });
      expect(downloaded.ok, version).toBe(false);
      expect(downloaded.reason, version).toBe('POINTER_INVALID');
    }
    // 攻击尝试之后，现场必须完好无损
    expect(existsSync(statePath)).toBe(true);
    expect(existsSync(pendingVersionDir(dir, '0.2.0'))).toBe(true);
  });
});

/**
 * 真签名写入器。R3 · Major 指出旧写法用假签名信封（`{kid:'k',signature:'sig'}`）且没传 `keys`，
 * `verifyCompanion` 在 `SIGNATURE_INVALID` 一步就返回了 ⇒ I-30 新增的「目录段必须等于清单版本」
 * 分支**从未被执行到**。这里签真 Ed25519，失败原因只可能来自落点。
 */
const KID = 'rk-traversal';
const { publicKey: PUB_PEM, privateKey: PRIV_PEM } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const KEYS = {
  [KID]: { pem: PUB_PEM as string, notBefore: '2000-01-01T00:00:00.000Z', notAfter: '2099-12-31T23:59:59.000Z' },
};
const ART_NAME = 'Sparkii-0.9.9-win-x64.exe';
const ARTIFACT = Buffer.from('TRAVERSAL-PAYLOAD-0123456789-ABCDEF');
const SHA512 = createHash('sha512').update(ARTIFACT).digest('base64');

function signEnvelope(bytes: Buffer): string {
  const sig = sign(null, signatureInput(bytes, KID), PRIV_PEM).toString('base64');
  return JSON.stringify({ kid: KID, signature: sig });
}

/** 把一套「签名完全有效」的清单 + 包体写进 targetDir；清单里声明的版本恒为 0.9.9。 */
function writeSignedCompanion(targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  const release = {
    schemaVersion: 2, product: 'Sparkii', channel: 'stable', platform: 'win-x64',
    sequence: 9, nonce: 'n-9',
    publishedAt: new Date(Date.now() - 3_600_000).toISOString(),
    expiresAt: new Date(Date.now() + 72 * 3_600_000).toISOString(),
    version: '0.9.9', minSupportedVersion: '0.1.0',
    rollback: false, allowDowngrade: false, mandatory: false, mandatoryAfter: null,
    rollout: { percentage: 100, salt: 's' },
    releaseNotes: { summary: 'x', highlights: [] },
    artifact: { name: ART_NAME, bytes: ARTIFACT.length, sha512: SHA512, url: `releases/0.9.9/${ART_NAME}` },
    requires: { minOSBuild: '10.0.0', minFreeDiskBytes: 0 },
  };
  const releaseBytes = Buffer.from(JSON.stringify(release), 'utf8');
  const channel = {
    schemaVersion: 1, product: 'Sparkii', channel: 'stable', platform: 'win-x64',
    sequence: release.sequence, targetVersion: release.version,
    manifestPath: 'releases/0.9.9/release.json',
    manifestSha256: createHash('sha256').update(releaseBytes).digest('hex'),
    signaturePath: 'releases/0.9.9/release.json.sig',
    publishedAt: release.publishedAt,
  };
  const channelBytes = Buffer.from(JSON.stringify(channel), 'utf8');
  writeFileSync(join(targetDir, 'release.json'), releaseBytes);
  writeFileSync(join(targetDir, 'release.json.sig'), signEnvelope(releaseBytes), 'utf8');
  writeFileSync(join(targetDir, 'channel.json'), channelBytes);
  writeFileSync(join(targetDir, 'channel.json.sig'), signEnvelope(channelBytes), 'utf8');
  writeFileSync(join(targetDir, ART_NAME), ARTIFACT);
}

const scanOpts = (audit = { append: vi.fn(async () => ({})) }) => ({
  currentVersion: '0.1.0', keys: KEYS, lastSeenSequence: null, nonceFor: () => null,
  now: () => Date.now(), audit, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
});
const pendingRootOf = (dataDir: string) => join(updatesDir(dataDir), 'pending');

describe('落点判据：签名合法 ≠ 落点合法（不变量 4）', () => {
  let dir: string;
  beforeEach(() => { resetAuditThrottle(); dir = mkdtempSync(join(tmpdir(), 'sparkii-mismatch-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('对照组：目录段等于清单版本 ⇒ 同一套字节判为合法（证明下一条的失败只可能来自落点）', async () => {
    const good = pendingVersionDir(dir, '0.9.9');
    writeSignedCompanion(good);
    const verdict = await verifyCompanion(good, scanOpts() as never);
    expect(verdict.ok).toBe(true);
  });

  it('目录段是 0.9.8、清单声明 0.9.9 ⇒ 失败原因精确是 POINTER_INVALID 并写审计', async () => {
    const wrong = pendingVersionDir(dir, '0.9.8');
    writeSignedCompanion(wrong);
    const audit = { append: vi.fn(async () => ({})) };
    const verdict = await verifyCompanion(wrong, scanOpts(audit) as never);
    expect(verdict).toEqual({ ok: false, reason: 'POINTER_INVALID' });
    const logged = (audit.append.mock.calls as Array<[Record<string, unknown>]>)
      .some((c) => c[0].action === 'update.verify-failed'
        && String(c[0].payloadSummary).includes('POINTER_INVALID'));
    expect(logged).toBe(true);
  });

  it('裸放在 updates/ 根下的一套真签名清单同样被拒（旧写法根本走不到这条分支）', async () => {
    writeSignedCompanion(updatesDir(dir));
    const verdict = await verifyCompanion(updatesDir(dir), scanOpts() as never);
    expect(verdict).toEqual({ ok: false, reason: 'POINTER_INVALID' });
  });

  it('scanPending：留名字一致的包、删落点非法的那个、未知目录一概不动', async () => {
    writeSignedCompanion(pendingVersionDir(dir, '0.9.9'));
    writeSignedCompanion(pendingVersionDir(dir, '0.9.8'));          // 落点非法
    const stray = join(pendingRootOf(dir), '0.2.0.tmp');            // 不是合法版本段
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, 'note.txt'), 'someone else is here', 'utf8');

    const found = await scanPending(dir, scanOpts() as never);
    expect(found.map((f) => f.version)).toEqual(['0.9.9']);
    expect(existsSync(pendingVersionDir(dir, '0.9.8'))).toBe(false);          // 坏包按 §6.5 删除
    expect(existsSync(join(stray, 'note.txt'))).toBe(true);                   // 未知目录不删
    expect(existsSync(pendingVersionDir(dir, '0.9.9'))).toBe(true);           // 合法包不动
  });

  it('遗留的非 semver 目录不会让整次扫描抛错（R3 · Major 的现场形态）', async () => {
    for (const junk of ['Thumbs.db', '0.2.0.tmp', 'notes']) {
      mkdirSync(join(pendingRootOf(dir), junk), { recursive: true });
    }
    await expect(scanPending(dir, scanOpts() as never)).resolves.toEqual([]);
    for (const junk of ['Thumbs.db', '0.2.0.tmp', 'notes']) {
      expect(existsSync(join(pendingRootOf(dir), junk)), junk).toBe(true);
    }
  });
});

describe('startupScan 与遗留目录共存（抛错会被 index.ts 吞掉 ⇒ 更新静默失效）', () => {
  let dir: string;
  beforeEach(() => { resetAuditThrottle(); dir = mkdtempSync(join(tmpdir(), 'sparkii-scan-junk-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('pending/ 下有 0.2.0.tmp 时 startupScan 照样成功，合法包显示可安装', async () => {
    writeSignedCompanion(pendingVersionDir(dir, '0.9.9'));
    mkdirSync(join(pendingRootOf(dir), '0.2.0.tmp'), { recursive: true });
    const svc = initUpdateService({
      dataDir: dir,
      currentVersion: '0.1.0',
      resourcesPath: join(dir, 'resources'),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      audit: { append: vi.fn(async () => ({})) },
      sendEvent: vi.fn(),
      loadSettings: async () => ({ update: { autoCheck: false } }) as never,
      saveSettings: vi.fn(async () => {}),
      keyringSecret: async () => Buffer.alloc(32, 5),
      keys: KEYS,
      now: () => Date.now(),
    } as unknown as UpdateDeps);
    await expect(svc.startupScan()).resolves.toBeUndefined();
    const st = await svc.getState();
    expect(st.local?.version).toBe('0.9.9');
    expect(st.phase).toBe('readyToInstall');
    expect(existsSync(join(pendingRootOf(dir), '0.2.0.tmp'))).toBe(true);
  });
});

describe('wire-format 判据同样收敛到 dirs.ts 的 choke point（I-42）', () => {
  // verifier.ts 曾留着自己的 `VERSION_RE = /^[0-9A-Za-z.+-]+$/`，**允许 `..`**；
  // 它不参与落盘路径，但参与 `releases/<version>/<name>` 的 URL 构造与指针形态校验，
  // 属 R2 · B2 点名的「同一件事多条判据」漂移 ⇒ 现在两处都直接调用 isSafeVersionSegment。
  const channelFor = (targetVersion: string) => ({
    schemaVersion: 1, product: 'Sparkii', channel: 'stable', platform: 'win-x64',
    sequence: 9, targetVersion, manifestPath: 'releases/x/release.json',
    manifestSha256: 'a'.repeat(64), signaturePath: 'releases/x/release.json.sig',
    publishedAt: new Date().toISOString(),
  });
  const releaseFor = (version: string) => ({
    schemaVersion: 2, product: 'Sparkii', channel: 'stable', platform: 'win-x64',
    sequence: 9, nonce: 'n-9', version,
    publishedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    minSupportedVersion: '0.1.0', rollback: false, allowDowngrade: false,
    mandatory: false, mandatoryAfter: null, rollout: { percentage: 100, salt: 's' },
    releaseNotes: { summary: 'x', highlights: [] },
    artifact: { name: 'Sparkii-0.1.0-win-x64.exe', bytes: 3, sha512: 'AAA', url: 'releases/x/a.exe' },
    requires: { minOSBuild: '10.0.0', minFreeDiskBytes: 0 },
  });

  it('对照组：正常 semver 在两条判据下都放行（收紧没有把正路一起关掉）', () => {
    expect(validateChannelPointer(channelFor('0.9.9') as never, 'http://localhost/').ok).toBe(true);
    expect(deriveLatestYml(releaseFor('0.9.9') as never, 'http://localhost/sparkii-updates/').ok).toBe(true);
  });

  it('`..` / `.` 等点段在指针校验与 URL 派生两处一律被拒', () => {
    for (const v of ['..', '.', '../..', '0.1.0/..', '0.1;rm -rf']) {
      const pointer = validateChannelPointer(channelFor(v) as never, 'http://localhost/');
      expect(pointer.ok, v).toBe(false);
      const derived = deriveLatestYml(releaseFor(v) as never, 'http://localhost/sparkii-updates/');
      expect(derived.ok, v).toBe(false);
    }
  });
});
