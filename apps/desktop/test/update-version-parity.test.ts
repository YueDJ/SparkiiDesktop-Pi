/**
 * R5 · Major-1 的回归钉：**版本段的判据必须在发布侧与客户端两侧同源**。
 * 原先 `scripts/verify-release.mjs` 对 `targetVersion` / `version` 只判「非空字符串」，
 * `publish-release.mjs` 又是第三条宽判据 `^\\d+\\.\\d+\\.\\d+[0-9A-Za-z.+-]*$`；
 * 于是 8 条非法段（`..` / `.` / `CON` / 70 字长 …）在发布自检里 **OK 放行**、
 * 到客户端一律 `POINTER_INVALID` —— 发布 SOP 的上传门正是那条 OK，等于静默上线一份 100% 拒收的清单。
 * 这里用同一串语料两侧对拍，并把「已签名但版本段非法的树」真的过一遍自检。
 */

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ARTIFACT_NAME_RE, isSafeVersionSegment } from '../electron/main/update/dirs.js';
import { RELEASE_PATH_RE, deriveLatestYml } from '../electron/main/update/verifier.js';
import { assembleRelease, isValidVersionSegment } from '../scripts/publish-release.mjs';
import { sha256Hex, signatureEnvelope, signBytes } from '../scripts/sign-release.mjs';
import { verifyReleaseTree } from '../scripts/verify-release.mjs';
import { generateReleaseKeyPair } from '../scripts/release-keys.mjs';

const LEGAL = [
  '0.1.0', '0.0.5', '0.3.0', '10.20.30', '1.0.0-beta.1', '1.0.0-rc.2', '1.0.0+build.7',
  '0.1.0-a.b+c.d', '2.0.0-alpha.1+exp.sha.5114f85',
];
const HOSTILE = [
  '..', '.', '...', '0.1.0/..', '..\\..', '../..', '%2e%2e', '0.1.0..', '.0.1.0', '0.1.0.',
  '0.1', '0', '', 'CON', 'aux', 'nul.txt', '0x0.1.0', 'v0.1.0', '0.1.0::$DATA', '0.1.0\r\n',
  '0.1.0\n', ' 0.1.0', '0.1.0 ', '0.1.0-a b', '0.1.0+build/1', '0'.repeat(70) + '.0.0',
];

describe('版本段判据两侧同源（客户端 ↔ 发布 CLI）', () => {
  it('同一串语料在 isSafeVersionSegment 与 isValidVersionSegment 下判定逐条一致', () => {
    for (const v of [...LEGAL, ...HOSTILE]) {
      expect(isValidVersionSegment(v), v).toBe(isSafeVersionSegment(v));
    }
  });

  it('合法段两侧都放行（防止判据被收紧成正路也过不去）', () => {
    for (const v of LEGAL) {
      expect(isSafeVersionSegment(v), v).toBe(true);
      expect(isValidVersionSegment(v), v).toBe(true);
    }
  });
});

describe('发布 CLI 拒绝非法版本段', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'sparkii-version-parity-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const srcArtifact = (version: string) => {
    const src = join(root, `src-${Buffer.from(version).toString('hex') || 'empty'}`);
    mkdirSync(src, { recursive: true });
    const p = join(src, 'Sparkii-installer.exe');
    writeFileSync(p, 'fake installer payload');
    return p;
  };

  it('assembleRelease 对每条非法段直接抛错（不再有第二条宽判据兜着）', async () => {
    const pair = generateReleaseKeyPair({ kid: 'k-parity' });
    for (const version of HOSTILE.filter((v) => v.length > 0)) {
      await expect(assembleRelease({
        artifactPath: srcArtifact(version),
        version,
        sequence: 1,
        privateKeyPem: pair.privateKey,
        kid: pair.kid,
        outDir: join(root, `out-${version.replace(/[^\w]/g, '_')}`),
        baseUrl: 'http://localhost/sparkii-updates/',
        now: new Date('2026-11-06T05:00:00.000Z'),
      }), version).rejects.toThrow(/invalid --version/);
    }
  });

  it('手搓一棵「签名有效但 targetVersion = ..」的树 ⇒ 发布自检必须拒，且拒因与客户端同类', async () => {
    const pair = generateReleaseKeyPair({ kid: 'k-parity' });
    const outDir = join(root, 'tree');
    const version = '0.3.0';
    const assembled = await assembleRelease({
      artifactPath: srcArtifact(version),
      version,
      sequence: 42,
      privateKeyPem: pair.privateKey,
      kid: pair.kid,
      outDir,
      baseUrl: 'http://localhost/sparkii-updates/',
      minSupportedVersion: '0.1.0',
      now: new Date('2026-11-06T05:00:00.000Z'),
    });
    // 对照：正常树自检必须通过（否则下面的断言可能只是因为别的原因失败）
    const okTree = verifyReleaseTree({
      outDir, publicKeyPem: pair.publicKey, kid: pair.kid, now: Date.parse('2026-11-06T06:00:00.000Z'),
    });
    expect(okTree.ok, JSON.stringify(assembled?.channel?.targetVersion)).toBe(true);

    // 攻击形态：把 release 与 channel 的版本段都换成 '..'，并用同一把密钥**重新签名**（签名有效，形态非法）
    const releasePath = join(outDir, 'releases', version, 'release.json');
    const release = JSON.parse(readFileSync(releasePath, 'utf8')) as Record<string, unknown>;
    const artifact = release.artifact as Record<string, unknown>;
    release.version = '..';
    artifact.url = 'releases/../Sparkii-..-win-x64.exe';
    artifact.name = 'Sparkii-..-win-x64.exe';
    const releaseBytes = Buffer.from(JSON.stringify(release), 'utf8');
    writeFileSync(releasePath, releaseBytes);
    writeFileSync(join(outDir, 'releases', version, 'release.json.sig'),
      signatureEnvelope(pair.kid, signBytes(releaseBytes, pair.privateKey, pair.kid)), 'utf8');

    const channelPath = join(outDir, 'channel.json');
    const channel = JSON.parse(readFileSync(channelPath, 'utf8')) as Record<string, unknown>;
    channel.targetVersion = '..';
    channel.manifestSha256 = sha256Hex(releaseBytes);
    const channelBytes = Buffer.from(JSON.stringify(channel), 'utf8');
    writeFileSync(channelPath, channelBytes);
    writeFileSync(join(outDir, 'channel.json.sig'),
      signatureEnvelope(pair.kid, signBytes(channelBytes, pair.privateKey, pair.kid)), 'utf8');

    const hostile = verifyReleaseTree({
      outDir, publicKeyPem: pair.publicKey, kid: pair.kid, now: Date.parse('2026-11-06T06:00:00.000Z'),
    });
    expect(hostile.ok).toBe(false);
    // 指针形态先命中 ⇒ 与客户端 `validateChannelPointer` 的 POINTER_INVALID 同一类拒因，
    // 绝不再出现「自检 OK、客户端拒收」的分叉。
    expect(String((hostile as { reason?: string }).reason)).toContain('POINTER_INVALID');
    expect(isSafeVersionSegment('..')).toBe(false);      // 客户端同侧判据也拒（两侧同判的现场证据）
  });
});

/**
 * R8 · Major-2：客户端曾把「包名 / URL 文件名段」的字符集抄成三份且都不含 `+`，
 * 于是 `0.3.0+build.7` 这类**合法 semver 构建元数据**发布的包，发布自检 OK、客户端 100% 拒收，
 * 且用户侧只表现为「一直没有更新」。这里两侧用同一语料对拍，并让发布 CLI 真产出一棵树过客户端判据。
 */
describe('包名与 URL 的字符集两侧同源（R8 · Major-2）', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'sparkii-name-parity-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const NAMES = [
    'Sparkii-0.3.0-win-x64.exe',
    'Sparkii-0.3.0+build.7-win-x64.exe',
    'Sparkii-1.0.0-beta.1+exp.sha.5114f85-win-x64.exe',
    'a.exe', 'a+b.exe', 'a_b.exe', 'a-b.exe', 'a.b.exe',
    // 以下必须被同一判据拒掉
    'Sparkii 0.3.0-win-x64.exe', 'Sparkii[0]-win-x64.exe', 'Sparkii-0.3.0-win-x64.exe,x',
    'a/b.exe', 'a\\b.exe', '..', '../evil.exe', 'a..exe', '', 'a:b.exe', 'a*b.exe', 'a?x.exe',
    // R14 · Minor：把"NTFS 合法但字符集外"的符号全部练到，
    // 否则谁手写一份更宽的字符类（例如把 `;` 或空格放进去），这条对拍不会响。
    'a;b.exe', 'a%x.exe', 'a#x.exe', 'a$x.exe', 'a(x).exe', 'a=x.exe', 'a@x.exe', 'a!x.exe',
    'a~x.exe', 'a|x.exe', 'a<x.exe', 'a>x.exe', 'a{x}.exe', 'a"x.exe', "a'x.exe", 'a\x01x.exe',
  ];

  it('两侧对"更宽的类"确实会报警（自证这条语料有牙齿）', () => {
    // 构造一条"只把 `;` 加进客户端类"的假判据，逐条与现判据比 ⇒ 必须至少有一处不一致，
    // 否则说明这个对拍即使面对变宽的字符集也照样全绿（那它就不配当回归钉）。
    const widened = new RegExp(`^[A-Za-z0-9._+;-]+$`);
    let diffs = 0;
    for (const n of NAMES) {
      if (ARTIFACT_NAME_RE.test(n) !== widened.test(n)) diffs += 1;
    }
    expect(diffs, '把 `;` 加进类里必须与现判据产生可见分歧').toBeGreaterThan(0);
  });

  it('RELEASE_PATH_RE 的文件段与 ARTIFACT_NAME_RE 逐条一致（判据已同源，抄一份就变红）', () => {
    for (const n of NAMES) {
      expect(RELEASE_PATH_RE.test(`releases/0.3.0/${n}`), n).toBe(ARTIFACT_NAME_RE.test(n));
    }
  });

  it('发布侧叶段收紧、客户端叶段仍宽：这是**刻意的不对称**，不是漏（R14 · Minor）', async () => {
    const { isValidPointerPath } = await import('../scripts/publish-release.mjs');
    // 发布侧：指针的两个路径按构造只能是 release.json / release.json.sig ⇒ 别的叶子一律拒（I-61②）。
    expect(isValidPointerPath('releases/0.3.0/release.json.exe')).toBe(false);
    // 客户端：RELEASE_PATH_RE 要同时容纳 manifestPath / signaturePath / artifact.url 三种路径，
    // 后者由**已验签**清单里的包名推出 ⇒ 叶段判据只能是"合法文件名字符集"，不能写死成 release.json。
    expect(RELEASE_PATH_RE.test('releases/0.3.0/release.json.exe')).toBe(true);
    // 但这不等于客户端放行了越界：名字与路径都还要各自过 `..` 判据与 isSafeVersionSegment。
    expect(RELEASE_PATH_RE.test('releases/0.3.0/../../evil.exe')).toBe(false);
    expect(isSafeVersionSegment('..')).toBe(false);
  });

  it('发布 CLI 真产出的 +build 树：发布自检 OK，且客户端 deriveLatestYml 同样 OK', async () => {
    const pair = generateReleaseKeyPair({ kid: 'k-plus' });
    const version = '0.3.0+build.7';
    const src = join(root, 'installer.exe');
    writeFileSync(src, 'fake installer payload for +build');
    const outDir = join(root, 'tree');
    await assembleRelease({
      artifactPath: src,
      version,
      sequence: 7,
      privateKeyPem: pair.privateKey,
      kid: pair.kid,
      outDir,
      baseUrl: 'http://localhost/sparkii-updates/',
      minSupportedVersion: '0.1.0',
      now: new Date('2026-11-06T05:00:00.000Z'),
    });
    const release = JSON.parse(
      readFileSync(join(outDir, 'releases', version, 'release.json'), 'utf8'),
    ) as Parameters<typeof deriveLatestYml>[0];
    expect(release.artifact.name).toBe('Sparkii-0.3.0+build.7-win-x64.exe');

    const tree = verifyReleaseTree({
      outDir, publicKeyPem: pair.publicKey, kid: pair.kid, now: Date.parse('2026-11-06T06:00:00.000Z'),
    });
    expect(tree.ok, JSON.stringify(tree)).toBe(true);

    // 客户端侧走真实入口：deriveLatestYml 内含 isSafeVersionSegment + 名字判据 + origin 比对
    const derived = deriveLatestYml(release, 'http://localhost/sparkii-updates/');
    expect(derived.ok, JSON.stringify(derived)).toBe(true);
    expect(isSafeVersionSegment(version)).toBe(true);
    expect(ARTIFACT_NAME_RE.test(release.artifact.name)).toBe(true);
    expect(RELEASE_PATH_RE.test(release.artifact.url)).toBe(true);
  });

  it('+ 之外的字符仍被同一判据拒；点是合法字符 ⇒ 穿越靠显式 .. 判据而不是靠字符集', () => {
    for (const n of ['Sparkii 0.3.0-win-x64.exe', 'a/b.exe', 'a\\b.exe', 'a:b.exe', 'a*x.exe']) {
      expect(ARTIFACT_NAME_RE.test(n), n).toBe(false);
      expect(RELEASE_PATH_RE.test(`releases/0.3.0/${n}`), n).toBe(false);
    }
    // 诚实登记：字符集**放过** '..'（点是合法字符）。所以加 `+` 没有削弱穿越防护，但穿越也不能算字符集的功劳——
    // 真正挡它的是三处显式判据：isSafeVersionSegment（版本段）、validateChannelPointer 与 deriveLatestYml /
    // verifyCompanion 的 includes('..')。下面这条钉住「判据存在于版本段一侧」，另两处在 traversal 语料里钉。
    expect(ARTIFACT_NAME_RE.test('..')).toBe(true);
    expect(RELEASE_PATH_RE.test('releases/0.3.0/..')).toBe(true);
    expect(isSafeVersionSegment('..')).toBe(false);
  });
});
