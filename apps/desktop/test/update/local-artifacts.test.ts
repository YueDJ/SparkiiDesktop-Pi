// G3 · local-artifacts 单测：关机重开从 pending/ 推导出「可安装」（不重新下载、不依赖状态文件）；
// 坏包被删且写 update.verify-failed；verifyCompanion 逐项校验。
// 离线 Ed25519 测试密钥 + mkdtempSync 临时目录；全程零网络；不 mock 验签本身。

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAuditThrottle } from '../../electron/main/update/audit.js';
import { ARTIFACT_NAME_RE, isSafeArtifactName, pendingVersionDir, stateFilePath } from '../../electron/main/update/dirs.js';
import { clearPending, scanPending, verifyCompanion, type ScanOptions } from '../../electron/main/update/local-artifacts.js';
import type { ChannelJson, ReleaseJson } from '../../electron/main/update/types.js';
import { deriveLatestYml, signatureInput } from '../../electron/main/update/verifier.js';

const KID = 'test-key-1';
const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const KEYS = {
  [KID]: {
    pem: publicKey as string,
    notBefore: '2000-01-01T00:00:00.000Z',
    notAfter: '2099-12-31T23:59:59.000Z',
  },
};
function signEnvelope(bytes: Buffer, kid = KID): string {
  const sig = sign(null, signatureInput(bytes, kid), privateKey).toString('base64');
  return JSON.stringify({ kid, signature: sig });
}

const VERSION = '0.3.0';
/** 包名由版本推出（发布侧同一口径），这样带构建元数据的版本能被原样造出来验判据。 */
const nameFor = (version: string): string => `Sparkii-${version}-win-x64.exe`;
const NAME = nameFor(VERSION);
const ARTIFACT = Buffer.from('ARTIFACT-LOCAL-0123456789-ABCDEF');
const SHA512 = createHash('sha512').update(ARTIFACT).digest('base64');
const NOW = Date.parse('2026-11-06T05:00:00.000Z');

interface Companion {
  release: ReleaseJson;
  channel: ChannelJson;
  releaseBytes: Buffer;
  channelBytes: Buffer;
  releaseSigText: string;
  channelSigText: string;
  files: Record<string, Buffer>;
}

function buildCompanion(now: number, over: Partial<ReleaseJson> = {}, version = VERSION): Companion {
  const name = nameFor(version);
  const release: ReleaseJson = {
    schemaVersion: 2, product: 'Sparkii', channel: 'stable', platform: 'win-x64',
    sequence: 7, nonce: 'nonce-A',
    publishedAt: new Date(now - 3600_000).toISOString(),
    expiresAt: new Date(now + 72 * 3600_000).toISOString(),
    version, minSupportedVersion: '0.1.0',
    rollback: false, allowDowngrade: false, mandatory: false, mandatoryAfter: null,
    rollout: { percentage: 100, salt: 's' },
    releaseNotes: { summary: 's', highlights: ['h'] },
    artifact: { name, bytes: ARTIFACT.length, sha512: SHA512, url: `releases/${version}/${name}` },
    requires: { minOSBuild: '10.0.0', minFreeDiskBytes: 0 },
    ...over,
  };
  const releaseBytes = Buffer.from(JSON.stringify(release), 'utf8');
  const channel: ChannelJson = {
    schemaVersion: 1, product: 'Sparkii', channel: 'stable', platform: 'win-x64',
    sequence: release.sequence, targetVersion: release.version,
    manifestPath: `releases/${release.version}/release.json`,
    manifestSha256: createHash('sha256').update(releaseBytes).digest('hex'),
    signaturePath: `releases/${release.version}/release.json.sig`,
    publishedAt: release.publishedAt,
  };
  const channelBytes = Buffer.from(JSON.stringify(channel), 'utf8');
  const releaseSigText = signEnvelope(releaseBytes);
  const channelSigText = signEnvelope(channelBytes);
  return {
    release, channel, releaseBytes, channelBytes, releaseSigText, channelSigText,
    files: {
      'release.json': releaseBytes,
      'release.json.sig': Buffer.from(releaseSigText),
      'channel.json': channelBytes,
      'channel.json.sig': Buffer.from(channelSigText),
      [release.artifact.name]: ARTIFACT,
    },
  };
}

function writePending(dataDir: string, files: Record<string, Buffer>, version = VERSION): string {
  const vdir = pendingVersionDir(dataDir, version);
  mkdirSync(vdir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(vdir, name), body);
  return vdir;
}

describe('local-artifacts derived state 扫描', () => {
  let dir: string;
  let companion: Companion;
  let audit: { append: ReturnType<typeof vi.fn> };
  let scanOpts: ScanOptions;

  beforeEach(() => {
    resetAuditThrottle();
    dir = mkdtempSync(join(tmpdir(), 'sparkii-local-'));
    companion = buildCompanion(NOW);
    audit = { append: vi.fn(async () => ({})) };
    scanOpts = {
      currentVersion: '0.1.0',
      keys: KEYS,
      lastSeenSequence: null,
      nonceFor: () => null,
      now: () => NOW,
      audit,
    };
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('关机重开：无 update-state.json、零网络，从 pending/ 推导出「可安装」', async () => {
    writePending(dir, companion.files);
    // 明确没有状态文件：证明 derived state 不依赖 update-state.json
    expect(existsSync(stateFilePath(dir))).toBe(false);
    const locals = await scanPending(dir, scanOpts);
    expect(locals).toHaveLength(1);
    expect(locals[0]!.valid).toBe(true);
    expect(locals[0]!.version).toBe(VERSION);
    expect(locals[0]!.sequence).toBe(7);
    expect(locals[0]!.nonce).toBe('nonce-A');
    expect(locals[0]!.bytes).toBe(ARTIFACT.length);
    expect(locals[0]!.sha512).toBe(SHA512);
    expect(locals[0]!.artifactPath).toBe(join(pendingVersionDir(dir, VERSION), NAME));
    // 不重新下载：包与伴生清单原样保留
    expect(readFileSync(locals[0]!.artifactPath).equals(ARTIFACT)).toBe(true);
  });

  it('坏包（release.json 被篡改）→ 删除整个目录 + 写 update.verify-failed，不显示可安装', async () => {
    const bad: Record<string, Buffer> = { ...companion.files };
    const b = Buffer.from(companion.releaseBytes);
    b[10] = b[10]! ^ 0xff;
    bad['release.json'] = b;
    const vdir = writePending(dir, bad);
    const locals = await scanPending(dir, scanOpts);
    expect(locals).toHaveLength(0); // 不显示「可安装」
    expect(existsSync(vdir)).toBe(false); // 坏包被删
    expect(audit.append).toHaveBeenCalled();
    const calls = audit.append.mock.calls as Array<[Record<string, unknown>]>;
    expect(calls.some((c) => c[0].action === 'update.verify-failed')).toBe(true);
  });

  it('坏包（清单 .sig 被篡改）→ 删除 + 写审计', async () => {
    const bad: Record<string, Buffer> = {
      ...companion.files,
      'release.json.sig': Buffer.from('{"kid":"k1","signature":"AAAA"}'),
    };
    const vdir = writePending(dir, bad);
    const locals = await scanPending(dir, scanOpts);
    expect(locals).toHaveLength(0);
    expect(existsSync(vdir)).toBe(false);
    expect(audit.append).toHaveBeenCalled();
  });

  it('sequence 回退（低于 lastSeenSequence）→ 坏包被删', async () => {
    writePending(dir, companion.files);
    const locals = await scanPending(dir, { ...scanOpts, lastSeenSequence: 8 });
    expect(locals).toHaveLength(0);
    expect(existsSync(pendingVersionDir(dir, VERSION))).toBe(false);
  });

  it('同 sequence 且 nonce 绑定一致 → 放行；不一致 → 删除', async () => {
    writePending(dir, companion.files);
    const ok = await scanPending(dir, { ...scanOpts, lastSeenSequence: 7, nonceFor: () => 'nonce-A' });
    expect(ok).toHaveLength(1);
    const bad = await scanPending(dir, { ...scanOpts, lastSeenSequence: 7, nonceFor: () => 'other' });
    expect(bad).toHaveLength(0);
    expect(existsSync(pendingVersionDir(dir, VERSION))).toBe(false);
  });

  it('expiresAt 过期 → 坏包被删', async () => {
    const expired = buildCompanion(NOW, { expiresAt: new Date(NOW - 1000).toISOString() });
    writePending(dir, expired.files);
    const locals = await scanPending(dir, scanOpts);
    expect(locals).toHaveLength(0);
  });

  it('version < currentVersion（且非允许降级）→ 坏包被删', async () => {
    const lower = buildCompanion(NOW, {
      version: '0.0.5',
      artifact: { ...companion.release.artifact, name: 'Sparkii-0.0.5-win-x64.exe', url: 'releases/0.0.5/x' },
    });
    // 目录名仍是 VERSION，但 release.version 更低
    const vdir = pendingVersionDir(dir, VERSION);
    mkdirSync(vdir, { recursive: true });
    for (const [name, body] of Object.entries(lower.files)) writeFileSync(join(vdir, name), body);
    const locals = await scanPending(dir, { ...scanOpts, currentVersion: '0.1.0' });
    expect(locals).toHaveLength(0);
    expect(existsSync(vdir)).toBe(false);
  });
});

describe('verifyCompanion 直测', () => {
  let dir: string;
  let companion: Companion;
  beforeEach(() => {
    resetAuditThrottle();
    dir = mkdtempSync(join(tmpdir(), 'sparkii-companion-'));
    companion = buildCompanion(NOW);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const opts = (): ScanOptions => ({
    currentVersion: '0.1.0', keys: KEYS, lastSeenSequence: null,
    nonceFor: () => null, now: () => NOW,
  });

  it('合法伴生清单 → ok + release/channel', async () => {
    const vdir = writePending(dir, companion.files);
    const r = await verifyCompanion(vdir, opts());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.release.version).toBe(VERSION);
      expect(r.channel.sequence).toBe(7);
    }
  });

  it('manifestSha256 不符 → MANIFEST_HASH_MISMATCH', async () => {
    const bad = { ...companion.files };
    const ch = { ...companion.channel, manifestSha256: '0'.repeat(64) };
    const chBytes = Buffer.from(JSON.stringify(ch), 'utf8');
    bad['channel.json'] = chBytes;
    bad['channel.json.sig'] = Buffer.from(signEnvelope(chBytes));
    const vdir = writePending(dir, bad);
    const r = await verifyCompanion(vdir, opts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('MANIFEST_HASH_MISMATCH');
  });

  it('包体 sha512 不符 → ARTIFACT_INVALID', async () => {
    const bad = { ...companion.files, [NAME]: Buffer.from('TAMPERED') };
    const vdir = writePending(dir, bad);
    const r = await verifyCompanion(vdir, opts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ARTIFACT_INVALID');
  });

  it('缺少伴生文件 → 拒绝', async () => {
    const bad = { ...companion.files };
    delete (bad as Record<string, Buffer>)['channel.json.sig'];
    const vdir = writePending(dir, bad);
    const r = await verifyCompanion(vdir, opts());
    expect(r.ok).toBe(false);
  });
});

describe('clearPending', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sparkii-clear-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  it('删除指定版本目录', async () => {
    const vdir = writePending(dir, buildCompanion(NOW).files);
    expect(existsSync(vdir)).toBe(true);
    await clearPending(dir, VERSION);
    expect(existsSync(vdir)).toBe(false);
  });
  it('非法 version（路径穿越）→ 不删任何东西', async () => {
    const vdir = writePending(dir, buildCompanion(NOW).files);
    await clearPending(dir, '../evil');
    expect(existsSync(vdir)).toBe(true);
  });
});

// R8 · Major-2：客户端曾把「包名 / 路径文件名段」的字符集各抄一份且都不含 `+`，
// 于是发布自检放行、客户端 100% 拒收 —— 一个带构建元数据的合法版本永远装不上，且没有任何报错指向原因。
describe('包名与版本段的构建元数据（R8 · Major-2）', () => {
  const PLUS_VERSION = '0.3.0+build.7';
  const PLUS_NAME = nameFor(PLUS_VERSION);

  let dir: string;
  let audit: { append: ReturnType<typeof vi.fn> };
  let scanOpts: ScanOptions;
  beforeEach(() => {
    resetAuditThrottle();
    dir = mkdtempSync(join(tmpdir(), 'sparkii-local-plus-'));
    audit = { append: vi.fn(async () => ({})) };
    scanOpts = {
      currentVersion: '0.1.0', keys: KEYS, lastSeenSequence: null,
      nonceFor: () => null, now: () => NOW, audit,
    };
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('scanPending：0.3.0+build.7 的合法包被认成可安装，且原样保留（不删、不重下）', async () => {
    const c = buildCompanion(NOW, {}, PLUS_VERSION);
    expect(c.release.artifact.name).toBe(PLUS_NAME);
    const vdir = writePending(dir, c.files, PLUS_VERSION);
    const locals = await scanPending(dir, scanOpts);
    expect(locals).toHaveLength(1);
    expect(locals[0]!.valid).toBe(true);
    expect(locals[0]!.version).toBe(PLUS_VERSION);
    expect(locals[0]!.artifactPath).toBe(join(pendingVersionDir(dir, PLUS_VERSION), PLUS_NAME));
    expect(existsSync(vdir)).toBe(true);
    expect(audit.append).not.toHaveBeenCalled();   // 合法名字绝不能再触发 verify-failed
  });

  it('verifyCompanion 对同一条清单直接放行；clearPending 也能按该版本删干净', async () => {
    const c = buildCompanion(NOW, {}, PLUS_VERSION);
    const vdir = writePending(dir, c.files, PLUS_VERSION);
    const r = await verifyCompanion(vdir, { ...scanOpts, currentVersion: '0.1.0' });
    expect(r.ok).toBe(true);
    await clearPending(dir, PLUS_VERSION);
    expect(existsSync(vdir)).toBe(false);
  });

  it('名字里塞路径分隔符 / 空格 / 括号一律 ARTIFACT_INVALID，且判据发生在拼路径之前', async () => {
    // 合法的那个先落在自己的版本目录里
    const good = buildCompanion(NOW, {}, PLUS_VERSION);
    const goodDir = writePending(dir, good.files, PLUS_VERSION);
    for (const hostileName of ['..\\evil.exe', '../evil.exe', 'Sparkii 0.3.0-win-x64.exe',
      'Sparkii[0.3.0]-win-x64.exe', 'Sparkii-0.3.0-win-x64.exe,x']) {
      const c = buildCompanion(NOW, { artifact: { name: hostileName, bytes: ARTIFACT.length, sha512: SHA512, url: `releases/${VERSION}/${hostileName}` } });
      // 故意**不写包体本身**：若判据是在读包之后才生效，这里会先命中「文件不存在」而不是 ARTIFACT_INVALID。
      const companionOnly = {
        'release.json': c.files['release.json']!,
        'release.json.sig': c.files['release.json.sig']!,
        'channel.json': c.files['channel.json']!,
        'channel.json.sig': c.files['channel.json.sig']!,
      };
      const vdir = writePending(dir, companionOnly, VERSION);
      const r = await verifyCompanion(vdir, scanOpts);
      expect(r.ok, hostileName).toBe(false);
      if (!r.ok) expect(r.reason, hostileName).toBe('ARTIFACT_INVALID');
      expect(existsSync(goodDir)).toBe(true);   // 逐条 verify 不动别的目录
    }
  });

  it('清单把包名写成 ".." 时按 ARTIFACT_INVALID 拒绝（字符集放过它，显式判据才挡住）', async () => {
    // '..' 全是合法字符 ⇒ 若只靠字符集，join(pendingDir, '..') 会指向 pending 根，
    // 只剩「读目录报错」这种偶然失败兜着。这里要求**在拼路径之前**就给出结构化拒绝。
    const c = buildCompanion(NOW, {
      artifact: { name: '..', bytes: ARTIFACT.length, sha512: SHA512, url: `releases/${VERSION}/..` },
    });
    const vdir = writePending(dir, {
      'release.json': c.files['release.json']!,
      'release.json.sig': c.files['release.json.sig']!,
      'channel.json': c.files['channel.json']!,
      'channel.json.sig': c.files['channel.json.sig']!,
    }, VERSION);
    const r = await verifyCompanion(vdir, scanOpts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ARTIFACT_INVALID');
  });

  // R13 指出上一条其实**不承重**：把显式 `..` 判据删掉后，`join(vdir,'..')` 落在 pending 根上，
  // 读目录照样报同一个 ARTIFACT_INVALID ⇒ 删掉判据这条用例仍绿。下面这条才是真正钉住它的现场：
  // 名字写成 `../outside.bin`，而那个文件**真实存在且哈希对得上**——没有显式判据时包会被判成合法可安装。
  it('包名写成 "../outside.bin" 且该文件真的存在、字节也对得上时，仍必须 ARTIFACT_INVALID（R13：让判据承重）', async () => {
    const escName = '../outside.bin';
    const c = buildCompanion(NOW, {
      artifact: { name: escName, bytes: ARTIFACT.length, sha512: SHA512, url: `releases/${VERSION}/${escName}` },
    });
    // 伴生文件写在版本目录里，包体本身落在 pending **根**目录（越出一层）。
    const vdir = writePending(dir, {
      'release.json': c.files['release.json']!,
      'release.json.sig': c.files['release.json.sig']!,
      'channel.json': c.files['channel.json']!,
      'channel.json.sig': c.files['channel.json.sig']!,
    }, VERSION);
    const escaped = join(dir, 'updates', 'pending', 'outside.bin');
    writeFileSync(escaped, ARTIFACT);
    // 先证明"这个现场本身是会被通过的形态"：字节、长度、sha512 全都对得上。
    expect(escaped.startsWith(vdir)).toBe(false);

    const r = await verifyCompanion(vdir, scanOpts);
    expect(r.ok, '越出 pending/<version>/ 的包绝不能被判成合法').toBe(false);
    if (!r.ok) expect(r.reason).toBe('ARTIFACT_INVALID');
    // 扫面也不得把它报成可安装（并且不得因为"验不过就删目录"而连带删掉那个越界文件之外的东西）。
    const locals = await scanPending(dir, scanOpts);
    expect(locals).toHaveLength(0);
    expect(existsSync(escaped)).toBe(true);
  });

  it('包名是 Windows 保留设备名（CON.exe / NUL / COM1…）⇒ 判据拒绝，而字符集放过它（R19 · Minor）', async () => {
    // 设备名全部由合法字符组成（点也是），所以挡它的**只能**是 isSafeArtifactName 里的设备名判据。
    // ⚠ 这里承重的是下面两条纯函数断言：`verifyCompanion` 那一格在 Windows 上不承重
    //   （真去 join(vdir,'CON.exe') 读包体会因为"写不出这个文件"而偶然失败），
    //   所以口径以 deriveLatestYml / isSafeArtifactName 为准——它们在下载**落盘之前**执行，任何平台都成立。
    const baseUrl = 'http://127.0.0.1:1/sparkii-updates/';
    for (const dev of ['CON.exe', 'nul', 'COM1', 'LPT9.txt', 'PRN.log', 'aux.txt', 'con.XLS']) {
      expect(ARTIFACT_NAME_RE.test(dev), `字符集本应放过 ${dev}（否则钉不住设备名判据）`).toBe(true);
      expect(isSafeArtifactName(dev), dev).toBe(false);
      const c = buildCompanion(NOW, {
        artifact: { name: dev, bytes: ARTIFACT.length, sha512: SHA512, url: `releases/${VERSION}/${dev}` },
      });
      const derived = deriveLatestYml(c.release, baseUrl);
      expect(derived.ok, dev).toBe(false);
      if (!derived.ok) expect(derived.reason, dev).toBe('ARTIFACT_INVALID');
      const vdir = writePending(dir, {
        'release.json': c.files['release.json']!,
        'release.json.sig': c.files['release.json.sig']!,
        'channel.json': c.files['channel.json']!,
        'channel.json.sig': c.files['channel.json.sig']!,
      }, VERSION);
      const r = await verifyCompanion(vdir, scanOpts);
      expect(r.ok, dev).toBe(false);
      if (!r.ok) expect(r.reason, dev).toBe('ARTIFACT_INVALID');
      rmSync(vdir, { recursive: true, force: true });
    }
    // 对照：真实发布名不是设备名 ⇒ 判据不得恒假（否则客户端 100% 拒收，与 R8 · Major-2 同一类错）。
    expect(isSafeArtifactName(NAME)).toBe(true);
    expect(deriveLatestYml(buildCompanion(NOW).release, baseUrl).ok).toBe(true);
  });

  it('scanPending 对非法名字的那个目录按坏包处置，带 + 的合法目录仍完整保留', async () => {
    const good = buildCompanion(NOW, {}, PLUS_VERSION);
    const goodDir = writePending(dir, good.files, PLUS_VERSION);
    const hostileName = 'Sparkii-0.3.0-win-x64 .exe';   // 空格：字符集外
    const bad = buildCompanion(NOW, {
      artifact: { name: hostileName, bytes: ARTIFACT.length, sha512: SHA512, url: `releases/${VERSION}/${hostileName}` },
    });
    const badDir = writePending(dir, { ...bad.files, [hostileName]: ARTIFACT }, VERSION);
    const locals = await scanPending(dir, scanOpts);
    expect(locals.map((l) => l.version)).toEqual([PLUS_VERSION]);
    expect(existsSync(badDir)).toBe(false);     // 坏包被删（既有口径）
    expect(existsSync(goodDir)).toBe(true);     // 合法包不得被连带
    expect(readFileSync(join(goodDir, PLUS_NAME)).equals(ARTIFACT)).toBe(true);
  });
});
