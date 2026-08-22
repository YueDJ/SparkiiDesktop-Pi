import { describe, it, expect } from 'vitest';
import { computeIntegrity, signFiles, verifyFiles, generateKeyPair } from '../src/integrity.js';

describe('profile integrity', () => {
  it('detects a tampered file', async () => {
    const { publicKey, privateKey } = await generateKeyPair();
    const files = { 'manifest.yaml': Buffer.from('v:1'), 'agent/skills.yaml': Buffer.from('a:1') };
    const { signature } = signFiles(files, privateKey);
    const tampered = { ...files, 'agent/skills.yaml': Buffer.from('a:2') };
    expect(verifyFiles(files, publicKey, signature)).toBe(true);
    expect(verifyFiles(tampered, publicKey, signature)).toBe(false);
  });
  it('is order independent', () => {
    const a = { 'b.yaml': Buffer.from('1'), 'a.yaml': Buffer.from('2') };
    const b = { 'a.yaml': Buffer.from('2'), 'b.yaml': Buffer.from('1') };
    expect(computeIntegrity(a)).toBe(computeIntegrity(b));
  });
});
