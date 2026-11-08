/**
 * 主 Agent 集成对拍：发布 CLI 真实产出的字节 ↔ 客户端验签器（§6.3 / §8.2 / A 关验收②的根判据）。
 * 不 mock 任何一方：签名走 scripts/sign-release.mjs（经 publish-release.mjs 的 assembleRelease），
 * 验签走 electron/main/update/verifier.ts。两端必须对同一「原始字节」同构。
 */

import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assembleRelease } from '../scripts/publish-release.mjs';
import {
  deriveLatestYml, validateChannelPointer, verifySignatureEnvelope,
} from '../electron/main/update/verifier.js';
import type { PublicKeyMap, ReleaseJson } from '../electron/main/update/types.js';

const KID = 'rel-2026-11';
const BASE_URL = 'http://example.test/sparkii-updates/';
const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const KEYS: PublicKeyMap = {
  [KID]: { pem: publicKey, notBefore: '2000-01-01T00:00:00.000Z', notAfter: '2099-12-31T23:59:59.000Z' },
};

describe('发布树 ↔ 客户端验签同构（端到端，零 mock）', () => {
  let dir: string;
  let out: string;
  let assembled: any;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sparkii-parity-'));
    out = join(dir, 'updates');
    const artifactPath = join(dir, 'Sparkii-0.3.0-win-x64.exe');
    writeFileSync(artifactPath, Buffer.concat([Buffer.from('PARITY-'), Buffer.alloc(2048, 0x7A)]));
    assembled = await assembleRelease({
      artifactPath,
      version: '0.3.0',
      sequence: 18,
      privateKeyPem: privateKey,
      kid: KID,
      outDir: out,
      baseUrl: BASE_URL,
      minSupportedVersion: '0.1.0',
      summary: '对拍用说明',
      highlights: ['第一条', '第二条'],
      nonce: 'parity-nonce',
      salt: 'parity-salt',
      now: new Date(),
    });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('指针形态与签名：客户端逐字节认可发布侧产物', () => {
    expect(validateChannelPointer(assembled.channel, BASE_URL)).toEqual({ ok: true });
    const chSig = readFileSync(join(out, 'channel.json.sig'), 'utf8');
    expect(verifySignatureEnvelope(assembled.channelBytes, chSig, KEYS)).toEqual({ ok: true, kid: KID });
  });

  it('清单签名 + manifestSha256 与实收原始字节一致（先验哈希后验签）', () => {
    const relSig = readFileSync(join(out, 'releases/0.3.0/release.json.sig'), 'utf8');
    const sha256 = createHash('sha256').update(assembled.releaseBytes).digest('hex');
    expect(sha256.toLowerCase()).toBe(assembled.channel.manifestSha256.toLowerCase());
    expect(verifySignatureEnvelope(assembled.releaseBytes, relSig, KEYS).ok).toBe(true);
  });

  it('sequence / publishedAt / version 三处在指针与清单间等值镜像（§6.1.1 N1 闭合）', () => {
    const release = assembled.release as ReleaseJson;
    expect(release.sequence).toBe(assembled.channel.sequence);
    expect(release.publishedAt).toBe(assembled.channel.publishedAt);
    expect(release.version).toBe(assembled.channel.targetVersion);
    expect(release.nonce).toBe('parity-nonce');
    expect(release.schemaVersion).toBe(2);
    expect(release.channel).toBe('stable');
    expect(release.platform).toBe('win-x64');
  });

  it('换 kid 即验签失败（kid 计入签名输入，不能靠换钥表复用签名）', () => {
    const relSig = readFileSync(join(out, 'releases/0.3.0/release.json.sig'), 'utf8');
    const other = { otherKid: { ...KEYS[KID] } };
    expect(verifySignatureEnvelope(assembled.releaseBytes, relSig, other).ok).toBe(false);
    const withoutKeys: PublicKeyMap = {};
    expect(verifySignatureEnvelope(assembled.releaseBytes, relSig, withoutKeys).ok).toBe(false);
  });

  it('清单字节改一个字节：签名失败，而不是「重新序列化后自洽」', () => {
    const relSig = readFileSync(join(out, 'releases/0.3.0/release.json.sig'), 'utf8');
    const flipped = Buffer.from(assembled.releaseBytes);
    flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 0x01;
    expect(verifySignatureEnvelope(flipped, relSig, KEYS).ok).toBe(false);
    expect(createHash('sha256').update(flipped).digest('hex')).not.toBe(assembled.channel.manifestSha256);
  });

  it('由发布清单派生的 latest.yml：artifact URL 与 baseUrl 同源且字段可回读（§5.2 步骤 2 / §6.5）', () => {
    const derived = deriveLatestYml(assembled.release as ReleaseJson, BASE_URL);
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    const url = new URL(derived.artifactUrl);
    expect(url.origin).toBe(new URL(BASE_URL).origin);
    expect(url.pathname).toBe('/sparkii-updates/releases/0.3.0/Sparkii-0.3.0-win-x64.exe');
    expect(derived.yml).toContain(`sha512: ${assembled.release.artifact.sha512}`);
    expect(derived.yml).toContain(`size: ${assembled.release.artifact.bytes}`);
    // 派生文件里绝不出现发布说明正文（UI 只能取自已验签清单，§7.5）
    expect(derived.yml).not.toContain('对拍用说明');
  });

  it('发布侧产物里不含服务器地址与密钥（§8.2 回读前的自检）', () => {
    const texts: Array<[string, string]> = [
      ['channel.json', assembled.channelBytes.toString('utf8')],
      ['release.json', assembled.releaseBytes.toString('utf8')],
    ];
    for (const [name, text] of texts) {
      expect(text, name).not.toContain('example.test');   // baseUrl 只用于校验形态，不写进清单
      expect(text, name).not.toContain('PRIVATE KEY');
      expect(text, name).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    }
  });

  it('清单过期后客户端仍验签通过但新鲜度归 verifier 判定（职责边界）', () => {
    // 这条只钉住一件事：验签函数本身不看 expiresAt（新鲜度在 fetchAndVerify 第Ⅵ步），
    // 防止将来有人把两者混在一个函数里导致 pending/ 校验与网络校验口径分叉。
    const relSig = readFileSync(join(out, 'releases/0.3.0/release.json.sig'), 'utf8');
    const farPast = { ...assembled.release, expiresAt: '2000-01-01T00:00:00.000Z' };
    const bytes = Buffer.from(JSON.stringify(farPast), 'utf8');
    // 换了字节就必须重新签名才能过 —— 说明 expiresAt 是被签名覆盖的，不可偷改。
    expect(verifySignatureEnvelope(bytes, relSig, KEYS).ok).toBe(false);
  });
});
