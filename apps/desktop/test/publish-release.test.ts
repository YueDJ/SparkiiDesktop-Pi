import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateReleaseKeyPair } from '../scripts/release-keys.mjs';
import { assembleRelease, isValidPointerPath } from '../scripts/publish-release.mjs';
import { verifyReleaseTree } from '../scripts/verify-release.mjs';

// RFC 5737 文档地址（203.0.113.0/24），非真实服务器；用于断言「真实 IP 不得泄漏进产物」。
const BASE_URL = 'http://203.0.113.7/sparkii-updates/';
const VERIFY_NOW = Date.parse('2026-11-06T06:00:00.000Z'); // 落在 publishedAt 与 expiresAt 之间

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tempRoot() {
  const r = mkdtempSync(join(tmpdir(), 'sparkii-publish-'));
  roots.push(r);
  return r;
}

function listFiles(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listFiles(full, base, out);
    else out.push(full.slice(base.length + 1));
  }
  return out;
}

async function buildTree(overrides = {}) {
  const root = tempRoot();
  const srcDir = join(root, 'src');
  mkdirSync(srcDir);
  const artifactPath = join(srcDir, 'Sparkii-0.3.0-win-x64.exe');
  const artifactBytes = Buffer.from('FAKE INSTALLER PAYLOAD\n'.repeat(256), 'utf8'); // 几 KB 文本，不真打包
  writeFileSync(artifactPath, artifactBytes);

  const outDir = join(root, 'updates');
  const pair = generateReleaseKeyPair({ kid: 'g1-test-kid' });
  const assembled = await assembleRelease({
    artifactPath,
    version: '0.3.0',
    sequence: 18,
    privateKeyPem: pair.privateKey,
    kid: pair.kid,
    outDir,
    baseUrl: BASE_URL,
    minSupportedVersion: '0.1.0',
    summary: '常规修复',
    highlights: ['修复 A', '优化 B'],
    now: new Date('2026-11-06T05:20:00.000Z'),
    nonce: '00112233445566778899aabbccddeeff',
    salt: 'rel-2026-11',
    ...overrides,
  });
  return { root, outDir, artifactPath, artifactBytes, pair, assembled };
}

function bareOpts(root, version = '0.3.0') {
  const src = join(root, 'src');
  mkdirSync(src, { recursive: true });
  const artifactPath = join(src, `${version}.exe`);
  writeFileSync(artifactPath, 'fake installer');
  const pair = generateReleaseKeyPair({ kid: 'k' });
  return { artifactPath, privateKeyPem: pair.privateKey, kid: pair.kid, outDir: join(root, 'out'), pair };
}

describe('publish-release.mjs / verify-release.mjs', () => {
  it('assembleRelease 产出 schema 2 / schema 1，字段与哈希齐全', async () => {
    const { outDir, artifactBytes, assembled } = await buildTree();
    const channel = JSON.parse(readFileSync(join(outDir, 'channel.json'), 'utf8'));
    const release = JSON.parse(readFileSync(join(outDir, 'releases/0.3.0/release.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(outDir, 'releases/0.3.0/release-manifest.json'), 'utf8'));

    // channel.json schema 1 字段齐全
    expect(channel.schemaVersion).toBe(1);
    expect(channel.product).toBe('Sparkii');
    expect(channel.channel).toBe('stable');
    expect(channel.platform).toBe('win-x64');
    expect(channel.sequence).toBe(18);
    expect(channel.targetVersion).toBe('0.3.0');
    expect(channel.manifestPath).toBe('releases/0.3.0/release.json');
    expect(channel.signaturePath).toBe('releases/0.3.0/release.json.sig');
    expect(channel.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof channel.publishedAt).toBe('string');

    // release.json 严格 schema 2
    expect(release.schemaVersion).toBe(2);
    expect(release.product).toBe('Sparkii');
    expect(release.channel).toBe('stable');
    expect(release.platform).toBe('win-x64');
    expect(release.version).toBe('0.3.0');
    expect(release.minSupportedVersion).toBe('0.1.0');
    expect(release.rollback).toBe(false);
    expect(release.allowDowngrade).toBe(false);
    expect(release.mandatory).toBe(false);
    expect(release.mandatoryAfter).toBe(null);
    expect(release.rollout.percentage).toBe(100);
    expect(typeof release.rollout.salt).toBe('string');
    expect(release.releaseNotes.summary).toBe('常规修复');
    expect(release.releaseNotes.highlights).toEqual(['修复 A', '优化 B']);
    expect(release.requires).toEqual({ minOSBuild: '10.0.19045', minFreeDiskBytes: 1200000000 });

    // sequence / publishedAt 严格相等
    expect(release.sequence).toBe(channel.sequence);
    expect(release.publishedAt).toBe(channel.publishedAt);

    // nonce / expiresAt 硬性字段（默认 72h）
    expect(release.nonce).toBeTruthy();
    expect(release.expiresAt).toBe(
      new Date(Date.parse(release.publishedAt) + 72 * 3600 * 1000).toISOString(),
    );

    // manifestSha256 与实收 release.json 原始字节一致
    const releaseBytes = readFileSync(join(outDir, 'releases/0.3.0/release.json'));
    expect(createHash('sha256').update(releaseBytes).digest('hex')).toBe(channel.manifestSha256);
    expect(assembled.channel.manifestSha256).toBe(channel.manifestSha256);

    // artifact.sha512 为 base64 且与包体一致；url 为相对路径；name 匹配正则
    expect(release.artifact.name).toBe('Sparkii-0.3.0-win-x64.exe');
    expect(release.artifact.name).toMatch(/^Sparkii-[0-9A-Za-z.+-]+-win-x64\.exe$/);
    expect(release.artifact.bytes).toBe(artifactBytes.length);
    expect(release.artifact.sha512).toBe(createHash('sha512').update(artifactBytes).digest('base64'));
    expect(release.artifact.url).toBe('releases/0.3.0/Sparkii-0.3.0-win-x64.exe');

    // release-manifest.json 沿用 schema 1，sha256 与包体一致
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.product).toBe('Sparkii');
    expect(manifest.version).toBe('0.3.0');
    expect(manifest.platform).toBe('win-x64');
    expect(manifest.unsigned).toBe(true);
    expect(manifest.artifact).toBe('Sparkii-0.3.0-win-x64.exe');
    expect(manifest.bytes).toBe(artifactBytes.length);
    expect(manifest.sha256).toBe(createHash('sha256').update(artifactBytes).digest('hex'));
    expect(typeof manifest.commit).toBe('string');
    expect(typeof manifest.builtAt).toBe('string');
    expect(typeof manifest.worktreeDirty).toBe('boolean');

    // 两份 .sig 存在
    expect(existsSync(join(outDir, 'channel.json.sig'))).toBe(true);
    expect(existsSync(join(outDir, 'releases/0.3.0/release.json.sig'))).toBe(true);
  });

  it('指针是最后两个写入的文件；绝不产出 latest.yml', async () => {
    const { outDir, assembled } = await buildTree();
    expect(assembled.writeOrder.slice(-2)).toEqual(['channel.json.sig', 'channel.json']);
    expect(assembled.plannedPaths.some((p) => p === 'latest.yml' || p.endsWith('/latest.yml'))).toBe(false);
    const all = listFiles(outDir);
    expect(all.some((f) => f.endsWith('latest.yml'))).toBe(false);
    expect(all).toContain('channel.json');
    expect(all).toContain('channel.json.sig');
  });

  it('产物中不含 base-url 的真实 IP 字面量 / token / 私钥', async () => {
    const { outDir, pair, assembled } = await buildTree();
    const host = new URL(BASE_URL).host; // '203.0.113.7'
    for (const rel of listFiles(outDir)) {
      const text = readFileSync(join(outDir, rel)).toString('utf8');
      expect(text).not.toContain(host);
      expect(text).not.toContain(BASE_URL);
      expect(text).not.toContain(pair.privateKey);
    }
    // 内存中的计划产物同样不含
    for (const rel of Object.keys(assembled.files)) {
      expect(assembled.files[rel].toString('utf8')).not.toContain(host);
    }
  });

  it('verify-release 对完整树返回 OK', async () => {
    const { outDir, pair } = await buildTree();
    const result = verifyReleaseTree({
      outDir,
      publicKeyPem: pair.publicKey,
      kid: pair.kid,
      now: VERIFY_NOW,
    });
    expect(result.ok).toBe(true);
  });

  it('篡改 release.json / .sig / channel.json / channel.json.sig 后 verifyReleaseTree 失败', async () => {
    const cases = [
      {
        label: 'release.json',
        mutate: (outDir) => {
          const p = join(outDir, 'releases/0.3.0/release.json');
          writeFileSync(p, readFileSync(p, 'utf8').replace('"version": "0.3.0"', '"version": "9.9.9"'));
        },
      },
      {
        label: 'release.json.sig',
        mutate: (outDir) => {
          const p = join(outDir, 'releases/0.3.0/release.json.sig');
          writeFileSync(p, `${readFileSync(p, 'utf8')}x`);
        },
      },
      {
        label: 'channel.json.sig',
        mutate: (outDir) => {
          const p = join(outDir, 'channel.json.sig');
          writeFileSync(p, `${readFileSync(p, 'utf8')}x`);
        },
      },
      {
        label: 'channel.json',
        mutate: (outDir) => {
          const p = join(outDir, 'channel.json');
          writeFileSync(p, readFileSync(p, 'utf8').replace('"sequence": 18', '"sequence": 19'));
        },
      },
    ];
    for (const c of cases) {
      const { outDir, pair } = await buildTree();
      c.mutate(outDir);
      const result = verifyReleaseTree({
        outDir,
        publicKeyPem: pair.publicKey,
        kid: pair.kid,
        now: VERIFY_NOW,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBeTruthy();
    }
  });

  it('sequence 回退被拒（不允许自动递增）', async () => {
    const r = tempRoot();
    const o = bareOpts(r);
    await expect(
      assembleRelease({
        artifactPath: o.artifactPath,
        version: '0.3.0',
        sequence: 17,
        privateKeyPem: o.privateKeyPem,
        kid: o.kid,
        outDir: o.outDir,
        minSupportedVersion: '0.1.0',
        previousSequence: 18,
      }),
    ).rejects.toThrow(/previousSequence/);
    // 显式给出更大 sequence 则通过（dry-run 不落盘）
    const ok = await assembleRelease({
      artifactPath: o.artifactPath,
      version: '0.3.0',
      sequence: 19,
      privateKeyPem: o.privateKeyPem,
      kid: o.kid,
      outDir: o.outDir,
      minSupportedVersion: '0.1.0',
      previousSequence: 18,
      dryRun: true,
    });
    expect(ok.sequence).toBe(19);
  });

  it('manifestPath 含 .. 被拒（assembleRelease 与 verifyReleaseTree 双重）', async () => {
    expect(isValidPointerPath('releases/0.3.0/release.json')).toBe(true);
    expect(isValidPointerPath('releases/0.3.0/release.json.sig')).toBe(true);
    expect(isValidPointerPath('releases/../release.json')).toBe(false);
    expect(isValidPointerPath('releases/0.3.0/../../evil')).toBe(false);
    expect(isValidPointerPath('/releases/0.3.0/release.json')).toBe(false);
    expect(isValidPointerPath('releases/0.3.0/release.json?x=1')).toBe(false);
    // R11 · Minor：指针叶段现在**写死**成 release.json / release.json.sig，不再是宽字符集
    // （宽叶段会引出"该不该含 +"这类第二个判据；真实指针路径没有第二种叶子）。
    expect(isValidPointerPath('releases/0.3.0/spark+foo.exe')).toBe(false);
    expect(isValidPointerPath('releases/0.3.0/..%2f..')).toBe(false);
    expect(isValidPointerPath('releases/0.3.0/release.json.exe')).toBe(false);

    // assembleRelease：version 推导出的 manifestPath 含 '..'
    const r = tempRoot();
    const o = bareOpts(r);
    // assembleRelease：这条原先靠「version 推导出含 '..' 的 manifestPath」被拒；
    // I-49 之后版本段判据与客户端同源（I-48 是 state-store 假阳性那条），`1.0.0..evil` 在 --version 这一关就被拒（防线前移，
    // 判据也只剩一条；两侧一致性另见 test/update-version-parity.test.ts）。
    await expect(
      assembleRelease({
        artifactPath: o.artifactPath,
        version: '1.0.0..evil',
        sequence: 1,
        privateKeyPem: o.privateKeyPem,
        kid: o.kid,
        outDir: o.outDir,
        minSupportedVersion: '0.1.0',
      }),
    ).rejects.toThrow(/invalid --version/);

    // verifyReleaseTree：篡改 channel.json 的 manifestPath 含 '..'
    const { outDir, pair } = await buildTree();
    const chPath = join(outDir, 'channel.json');
    const ch = JSON.parse(readFileSync(chPath, 'utf8'));
    ch.manifestPath = 'releases/../release.json';
    writeFileSync(chPath, `${JSON.stringify(ch, null, 2)}\n`);
    const result = verifyReleaseTree({
      outDir,
      publicKeyPem: pair.publicKey,
      kid: pair.kid,
      now: VERIFY_NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/POINTER_INVALID/);
  });

  it('--dry-run 只算哈希不落盘', async () => {
    const { outDir, artifactBytes, assembled } = await buildTree({ dryRun: true });
    expect(existsSync(join(outDir, 'channel.json'))).toBe(false);
    expect(assembled.writeOrder).toHaveLength(0);
    expect(assembled.files['channel.json']).toBeTruthy(); // 内存里仍组装好
    expect(assembled.artifact.sha512).toBe(createHash('sha512').update(artifactBytes).digest('base64'));
  });

  it('可选 blockmap 仅复制，指针仍是最后两个写入', async () => {
    const r = tempRoot();
    const src = join(r, 'src');
    mkdirSync(src, { recursive: true });
    const artifactPath = join(src, 'Sparkii-0.3.0-win-x64.exe');
    writeFileSync(artifactPath, 'fake installer');
    const blockmapPath = join(src, 'Sparkii-0.3.0-win-x64.exe.blockmap');
    writeFileSync(blockmapPath, 'BLOCKMAP');
    const pair = generateReleaseKeyPair({ kid: 'k' });
    const outDir = join(r, 'updates');
    const a = await assembleRelease({
      artifactPath,
      version: '0.3.0',
      sequence: 2,
      privateKeyPem: pair.privateKey,
      kid: pair.kid,
      outDir,
      minSupportedVersion: '0.1.0',
      blockmapPath,
    });
    expect(readFileSync(join(outDir, 'releases/0.3.0/Sparkii-0.3.0-win-x64.exe.blockmap'), 'utf8')).toBe('BLOCKMAP');
    expect(a.writeOrder.slice(-2)).toEqual(['channel.json.sig', 'channel.json']);
    expect(listFiles(outDir).some((f) => f.endsWith('latest.yml'))).toBe(false);
  });
});
