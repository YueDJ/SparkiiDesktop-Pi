import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';

export function computeIntegrity(files: Record<string, Buffer>): string {
  const h = createHash('sha256');
  for (const path of Object.keys(files).sort()) {
    h.update(path).update('\0');
    h.update(createHash('sha256').update(files[path]).digest('hex')).update('\n');
  }
  return h.digest('hex');
}

export function signFiles(files: Record<string, Buffer>, privateKey: string): { signature: string; integrity: string } {
  const integrity = computeIntegrity(files);
  const signature = sign(null, Buffer.from(integrity, 'utf8'), privateKey).toString('base64');
  return { signature, integrity };
}

export function verifyFiles(files: Record<string, Buffer>, publicKey: string, signature: string): boolean {
  const integrity = computeIntegrity(files);
  try {
    return verify(null, Buffer.from(integrity, 'utf8'), publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

export async function generateKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { publicKey, privateKey };
}
