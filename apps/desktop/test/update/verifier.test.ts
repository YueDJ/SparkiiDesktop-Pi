// G3 · verifier 单测：篡改一律 fail closed + 写审计；成功路径；派生 yml 与清单逐字段一致。
// 用 mkdtempSync 临时目录 + 离线 Ed25519 测试密钥 + 本地 http.createServer（零外网、零真实服务器）。
// 禁止 mock 验签本身：签名用注入的离线测试密钥真实生成/校验。

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAuditThrottle } from '../../electron/main/update/audit.js';
import { signatureInput } from '../../electron/main/update/verifier.js';
import {
  deriveLatestYml, fetchAndVerify, validateChannelPointer, verifySignatureEnvelope,
  type VerifyOptions,
} from '../../electron/main/update/verifier.js';
import { crossCheckUpdateInfo } from '../../electron/main/update/updater-adapter.js';
import type { ChannelJson, ReleaseJson } from '../../electron/main/update/types.js';

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
const ARTIFACT_NAME = 'Sparkii-0.3.0-win-x64.exe';
const ARTIFACT = Buffer.from('FAKE-ARTIFACT-BYTES-0123456789-abcdef');
const SHA512 = createHash('sha512').update(ARTIFACT).digest('base64');

interface World {
  release: ReleaseJson;
  channel: ChannelJson;
  releaseBytes: Buffer;
  channelBytes: Buffer;
  files: Record<string, Buffer>;
}

function buildWorld(now: number, overrides: Partial<ReleaseJson> = {}): World {
  const release: ReleaseJson = {
    schemaVersion: 2, product: 'Sparkii', channel: 'stable', platform: 'win-x64',
    sequence: 7, nonce: 'nonce-A',
    publishedAt: new Date(now - 3600_000).toISOString(),
    expiresAt: new Date(now + 72 * 3600_000).toISOString(),
    version: VERSION,
    minSupportedVersion: '0.1.0',
    rollback: false, allowDowngrade: false, mandatory: false, mandatoryAfter: null,
    rollout: { percentage: 100, salt: 's' },
    releaseNotes: { summary: '修复若干问题', highlights: ['更快', '更稳'] },
    artifact: {
      name: ARTIFACT_NAME, bytes: ARTIFACT.length, sha512: SHA512,
      url: `releases/${VERSION}/${ARTIFACT_NAME}`,
    },
    requires: { minOSBuild: '10.0.0', minFreeDiskBytes: 0 },
    ...overrides,
  };
  const releaseBytes = Buffer.from(JSON.stringify(release), 'utf8');
  const channel: ChannelJson = {
    schemaVersion: 1, product: 'Sparkii', channel: 'stable', platform: 'win-x64',
    sequence: release.sequence,
    targetVersion: release.version,
    manifestPath: `releases/${release.version}/release.json`,
    manifestSha256: createHash('sha256').update(releaseBytes).digest('hex'),
    signaturePath: `releases/${release.version}/release.json.sig`,
    publishedAt: release.publishedAt,
  };
  const channelBytes = Buffer.from(JSON.stringify(channel), 'utf8');
  const files: Record<string, Buffer> = {
    '/channel.json': channelBytes,
    '/channel.json.sig': Buffer.from(signEnvelope(channelBytes)),
    [`/releases/${release.version}/release.json`]: releaseBytes,
    [`/releases/${release.version}/release.json.sig`]: Buffer.from(signEnvelope(releaseBytes)),
  };
  return { release, channel, releaseBytes, channelBytes, files };
}

interface ServerHandle {
  baseUrl: string;
  requests: Array<{ url: string; headers: http.IncomingHttpHeaders }>;
  close(): Promise<void>;
}

async function startServer(files: Record<string, Buffer>): Promise<ServerHandle> {
  const requests: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers });
    const pathname = (req.url ?? '').split('?')[0];
    const body = files[pathname];
    if (body == null) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
    });
    res.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('verifier.fetchAndVerify', () => {
  let dir: string;
  let now: number;
  let world: World;
  let files: Record<string, Buffer>;
  let server: ServerHandle;
  let audit: { append: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    resetAuditThrottle();
    dir = mkdtempSync(join(tmpdir(), 'sparkii-verifier-'));
    now = Date.now();
    world = buildWorld(now);
    files = { ...world.files };
    audit = { append: vi.fn(async () => ({})) };
    server = await startServer(files);
  });
  afterEach(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const opts = (o: Partial<VerifyOptions> = {}): VerifyOptions => ({
    baseUrl: server.baseUrl,
    now: () => now,
    currentVersion: '0.1.0',
    lastSeenSequence: null,
    nonceFor: () => null,
    keys: KEYS,
    audit,
    requestTimeoutMs: 3000,
    ...o,
  });
  const expectAudit = (): void => {
    expect(audit.append).toHaveBeenCalled();
    const calls = audit.append.mock.calls as Array<[Record<string, unknown>]>;
    expect(calls.some((c) => c[0].action === 'update.verify-failed')).toBe(true);
  };

  it('成功路径：返回已验签原始字节，且请求无 query / 无自定义 header', async () => {
    const r = await fetchAndVerify(opts());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.release.version).toBe(VERSION);
    expect(r.releaseBytes.equals(world.releaseBytes)).toBe(true);
    expect(r.channelBytes.equals(world.channelBytes)).toBe(true);
    expect(r.releaseSigText).toBe(world.files[`/releases/${VERSION}/release.json.sig`]!.toString('utf8'));
    expect(server.requests.length).toBeGreaterThanOrEqual(4);
    for (const req of server.requests) {
      expect(req.url).not.toContain('?');
      expect(req.url).not.toContain('#');
      expect(req.headers['x-device-id']).toBeUndefined();
      expect(req.headers['x-sparkii-id']).toBeUndefined();
    }
  });

  it('篡改 release.json（1 字节）→ MANIFEST_HASH_MISMATCH + 审计', async () => {
    const key = `/releases/${VERSION}/release.json`;
    const b = Buffer.from(files[key]!);
    b[10] = b[10]! ^ 0xff;
    files[key] = b;
    const r = await fetchAndVerify(opts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('MANIFEST_HASH_MISMATCH');
    expectAudit();
  });

  it('篡改 release.json.sig → SIGNATURE_INVALID + 审计', async () => {
    files[`/releases/${VERSION}/release.json.sig`] =
      Buffer.from(JSON.stringify({ kid: KID, signature: 'AAAA' }));
    const r = await fetchAndVerify(opts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SIGNATURE_INVALID');
    expectAudit();
  });

  it('channel.json 形态非法（绝对 URL 指针）→ POINTER_INVALID + 审计', async () => {
    const bad = { ...world.channel, manifestPath: 'http://evil.invalid/releases/0.3.0/release.json' };
    files['/channel.json'] = Buffer.from(JSON.stringify(bad));
    const r = await fetchAndVerify(opts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('POINTER_INVALID');
    expectAudit();
  });

  it('host 不一致（validateChannelPointer 直测）→ 拒绝', () => {
    const bad = { ...world.channel, manifestPath: 'http://evil.invalid/releases/0.3.0/release.json' };
    expect(validateChannelPointer(bad, server.baseUrl).ok).toBe(false);
    const bad2 = { ...world.channel, signaturePath: '//evil.invalid/x.sig' };
    expect(validateChannelPointer(bad2, server.baseUrl).ok).toBe(false);
    expect(validateChannelPointer(world.channel, server.baseUrl).ok).toBe(true);
  });

  it('manifestSha256 不符（清单已重签，仅哈希错）→ MANIFEST_HASH_MISMATCH + 审计', async () => {
    const channel = { ...world.channel, manifestSha256: '0'.repeat(64) };
    const channelBytes = Buffer.from(JSON.stringify(channel), 'utf8');
    files['/channel.json'] = channelBytes;
    files['/channel.json.sig'] = Buffer.from(signEnvelope(channelBytes));
    const r = await fetchAndVerify(opts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('MANIFEST_HASH_MISMATCH');
    expectAudit();
  });

  it('同 sequence 换 nonce → NONCE_MISMATCH + 审计', async () => {
    const r = await fetchAndVerify(opts({ lastSeenSequence: 7, nonceFor: () => 'bound-other-nonce' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NONCE_MISMATCH');
    expectAudit();
  });

  it('同 sequence 且 nonce 与绑定值相同 → 放行', async () => {
    const r = await fetchAndVerify(opts({ lastSeenSequence: 7, nonceFor: () => 'nonce-A' }));
    expect(r.ok).toBe(true);
  });

  it('sequence 回退 → SEQUENCE_REGRESSION + 审计', async () => {
    const r = await fetchAndVerify(opts({ lastSeenSequence: 8 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SEQUENCE_REGRESSION');
    expectAudit();
  });

  it('过期 expiresAt → EXPIRED + 审计', async () => {
    const w2 = buildWorld(now, { expiresAt: new Date(now - 1000).toISOString() });
    for (const k of Object.keys(w2.files)) files[k] = w2.files[k]!;
    const r = await fetchAndVerify(opts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('EXPIRED');
    expectAudit();
  });

  it('kid 不匹配（指针签名 kid 不在公钥表）→ SIGNATURE_INVALID + 审计', async () => {
    files['/channel.json.sig'] = Buffer.from(signEnvelope(world.channelBytes, 'unknown-kid'));
    const r = await fetchAndVerify(opts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SIGNATURE_INVALID');
    expectAudit();
  });

  it('allowDowngrade=false 且版本更低 → VERSION_BLOCKED + 审计', async () => {
    const w2 = buildWorld(now, { version: '0.0.5', allowDowngrade: false,
      artifact: { ...world.release.artifact, name: 'Sparkii-0.0.5-win-x64.exe', url: 'releases/0.0.5/Sparkii-0.0.5-win-x64.exe' } });
    for (const k of Object.keys(w2.files)) files[k] = w2.files[k]!;
    const r = await fetchAndVerify(opts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('VERSION_BLOCKED');
    expectAudit();
  });

  it('allowDowngrade=true 但缺二次确认 → 仍 VERSION_BLOCKED + 审计', async () => {
    const w2 = buildWorld(now, { version: '0.0.5', allowDowngrade: true,
      artifact: { ...world.release.artifact, name: 'Sparkii-0.0.5-win-x64.exe', url: 'releases/0.0.5/Sparkii-0.0.5-win-x64.exe' } });
    for (const k of Object.keys(w2.files)) files[k] = w2.files[k]!;
    const r = await fetchAndVerify(opts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('VERSION_BLOCKED');
    expectAudit();
  });

  it('minSupportedVersion 硬闸门（当前版本低于下限）→ MIN_SUPPORTED + 审计', async () => {
    const w2 = buildWorld(now, { minSupportedVersion: '0.9.0' });
    for (const k of Object.keys(w2.files)) files[k] = w2.files[k]!;
    const r = await fetchAndVerify(opts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('MIN_SUPPORTED');
    expectAudit();
  });
});

describe('verifier.verifySignatureEnvelope', () => {
  const bytes = Buffer.from('hello world');

  it('合法签名 → ok + kid', () => {
    const r = verifySignatureEnvelope(bytes, signEnvelope(bytes), KEYS);
    expect(r).toEqual({ ok: true, kid: KID });
  });
  it('字节被篡改 → SIGNATURE_INVALID', () => {
    const r = verifySignatureEnvelope(Buffer.from('hello worlD'), signEnvelope(bytes), KEYS);
    expect(r.ok).toBe(false);
  });
  it('kid 不存在 → SIGNATURE_INVALID', () => {
    const r = verifySignatureEnvelope(bytes, signEnvelope(bytes, 'nope'), KEYS);
    expect(r.ok).toBe(false);
  });
  it('密钥过期 → SIGNATURE_INVALID', () => {
    const expired = { [KID]: { pem: KEYS[KID].pem, notBefore: '2000-01-01T00:00:00.000Z', notAfter: '2001-01-01T00:00:00.000Z' } };
    expect(verifySignatureEnvelope(bytes, signEnvelope(bytes), expired).ok).toBe(false);
  });
  it('缺省空公钥表（占位）→ fail closed', () => {
    expect(verifySignatureEnvelope(bytes, signEnvelope(bytes)).ok).toBe(false);
  });
});

describe('verifier.deriveLatestYml', () => {
  let dir: string;
  let server: ServerHandle;
  let world: World;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sparkii-derive-'));
    world = buildWorld(Date.now());
    server = await startServer(world.files);
  });
  afterEach(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('派生 yml 与已验签清单逐字段一致，artifact URL 为绝对远程 URL', () => {
    const r = deriveLatestYml(world.release, server.baseUrl);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.artifactUrl).toBe(`${server.baseUrl}releases/${VERSION}/${ARTIFACT_NAME}`);
    expect(r.artifactUrl.startsWith('http://')).toBe(true);
    const grab = (re: RegExp): string | undefined => re.exec(r.yml)?.[1];
    expect(grab(/^version:\s*(\S+)\s*$/m)).toBe(VERSION);
    expect(grab(/^path:\s*(\S+)\s*$/m)).toBe(ARTIFACT_NAME);
    expect(grab(/^sha512:\s*(\S+)\s*$/m)).toBe(SHA512);
    expect(grab(/^size:\s*(\d+)\s*$/m)).toBe(String(ARTIFACT.length));
    expect(grab(/^\s+-\s*url:\s*(\S+)\s*$/m)).toBe(r.artifactUrl);
    expect(grab(/^\s+sha512:\s*(\S+)\s*$/m)).toBe(SHA512);
    expect(grab(/^\s+size:\s*(\d+)\s*$/m)).toBe(String(ARTIFACT.length));
    expect(grab(/^releaseDate:\s*'([^']*)'\s*$/m)).toBe(world.release.publishedAt);
    // 不给 UI 写 releaseNotes
    expect(r.yml).not.toContain('releaseNotes');
    // 二次保险：把 yml 转成 UpdateInfo 形态逐字段比对
    const info = {
      version: VERSION, path: ARTIFACT_NAME, sha512: SHA512, size: ARTIFACT.length,
      files: [{ url: r.artifactUrl, sha512: SHA512, size: ARTIFACT.length }],
    };
    expect(crossCheckUpdateInfo(info, world.release)).toEqual({ ok: true });
  });

  it('派生出的 latest.yml 不得含任何 IPv4 字面量，主机只来自配置（R9 · D-6：产物侧只有 skipIf 版，这条恒实跑）', () => {
    const r = deriveLatestYml(world.release, 'https://updates.example.internal/sparkii-updates/');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.yml).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect(r.artifactUrl.startsWith('https://updates.example.internal/')).toBe(true);
    expect(r.yml).toContain('updates.example.internal');
  });

  it('artifact.url 指向别的 host → 拒绝（host 不一致）', () => {
    const bad: ReleaseJson = {
      ...world.release,
      artifact: { ...world.release.artifact, url: 'http://evil.invalid/x.exe' },
    };
    expect(deriveLatestYml(bad, server.baseUrl).ok).toBe(false);
  });
});
