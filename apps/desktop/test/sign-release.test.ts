import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex, signBytes, signatureEnvelope, verifyBytes } from '../scripts/sign-release.mjs';

function makeKeyPair() {
  return generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

describe('sign-release.mjs', () => {
  it('signBytes / verifyBytes 往返（签名覆盖原始字节）', () => {
    const { publicKey, privateKey } = makeKeyPair();
    const bytes = Buffer.from('release.json raw bytes\n', 'utf8');
    const sig = signBytes(bytes, privateKey, 'kid-1');
    expect(typeof sig).toBe('string');
    expect(Buffer.from(sig, 'base64')).toHaveLength(64); // Ed25519 签名固定 64 字节
    const env = signatureEnvelope('kid-1', sig);
    expect(verifyBytes(bytes, env, publicKey)).toBe(true);
  });

  it('篡改 1 字节即验签失败', () => {
    const { publicKey, privateKey } = makeKeyPair();
    const bytes = Buffer.from('release.json raw bytes\n', 'utf8');
    const env = signatureEnvelope('kid-1', signBytes(bytes, privateKey, 'kid-1'));
    const tampered = Buffer.from(bytes);
    tampered[0] ^= 0x01;
    expect(verifyBytes(tampered, env, publicKey)).toBe(false);
  });

  it('kid 计入签名输入：换 kid 的签名不能通过', () => {
    const { publicKey, privateKey } = makeKeyPair();
    const bytes = Buffer.from('payload', 'utf8');
    const sig1 = signBytes(bytes, privateKey, 'kid-1');
    // 用 kid-1 的签名，但 envelope 里换成 kid-2 → 还原的消息前缀不同 → 失败
    expect(verifyBytes(bytes, signatureEnvelope('kid-2', sig1), publicKey)).toBe(false);
    // 用 kid-2 签名，但 envelope 里写 kid-1 → 同样失败
    const sig2 = signBytes(bytes, privateKey, 'kid-2');
    expect(verifyBytes(bytes, signatureEnvelope('kid-1', sig2), publicKey)).toBe(false);
    // 原配正确
    expect(verifyBytes(bytes, signatureEnvelope('kid-1', sig1), publicKey)).toBe(true);
  });

  it('.sig envelope 形态：{kid, signature(base64)}', () => {
    const { publicKey, privateKey } = makeKeyPair();
    const bytes = Buffer.from('data', 'utf8');
    const sig = signBytes(bytes, privateKey, 'kid-abc');
    const env = signatureEnvelope('kid-abc', sig);
    const parsed = JSON.parse(env);
    expect(Object.keys(parsed).sort()).toEqual(['kid', 'signature']);
    expect(parsed.kid).toBe('kid-abc');
    expect(parsed.signature).toBe(sig);
    expect(Buffer.from(parsed.signature, 'base64').toString('base64')).toBe(sig);
    expect(verifyBytes(bytes, env, publicKey)).toBe(true);
  });

  it('畸形 envelope / 错误公钥一律失败（fail closed）', () => {
    const { publicKey, privateKey } = makeKeyPair();
    const other = makeKeyPair();
    const bytes = Buffer.from('data', 'utf8');
    const env = signatureEnvelope('kid-1', signBytes(bytes, privateKey, 'kid-1'));
    expect(verifyBytes(bytes, 'not-json', publicKey)).toBe(false);
    expect(verifyBytes(bytes, '{}', publicKey)).toBe(false);
    expect(verifyBytes(bytes, env, other.publicKey)).toBe(false);
    expect(sha256Hex(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
