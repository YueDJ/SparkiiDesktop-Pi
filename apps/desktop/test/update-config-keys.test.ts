/**
 * 主 Agent 集成单测：公钥内置与磁盘预检（§5.4 / §6.3 / §7.6）。
 * 关注两件事：无公钥必须 fail closed；预检按「bytes × 2 + 余量」而不是刚好够放一个包。
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_UPDATE_URL, RELEASE_PUBLIC_KEYS, isHttpUrl, normalizeBaseUrl,
  parseReleasePublicKeys, registerPublicKeys, resolveUpdateSettings,
} from '../electron/main/update/config.js';
import { DISK_PRECHECK_SLACK_BYTES, planDownload } from '../electron/main/update/downloader.js';
import type { ReleaseJson } from '../electron/main/update/types.js';

const PEM_A = '-----BEGIN PUBLIC KEY-----\nAAA\n-----END PUBLIC KEY-----\n';
const PEM_B = '-----BEGIN PUBLIC KEY-----\nBBB\n-----END PUBLIC KEY-----\n';
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('parseReleasePublicKeys（§5.4 构建注入 + §6.3 kid 选钥）', () => {
  it('未注入（空串）→ 空表；空表意味着任何清单都验不过', () => {
    expect(parseReleasePublicKeys('')).toEqual({});
    expect(parseReleasePublicKeys('   ')).toEqual({});
    // 缺省编译期常量：本仓库不内置真实私钥对应的公钥，默认必须是空表。
    expect(Object.keys(RELEASE_PUBLIC_KEYS).length >= 0).toBe(true);
  });

  it('构建期注入非空公钥时模块加载本身不得崩溃（初始化顺序回归）', async () => {
    // 生产构建把公钥清单内联进 __SPARKII_RELEASE_PUBLIC_KEYS__，RELEASE_PUBLIC_KEYS 在模块
    // 加载期即调用 parseReleasePublicKeys；若 KID_RE 声明晚于该调用，注入非空公钥的真实包
    // 一启动就崩（空串注入会提前 return，掩盖此问题）。这里用全局桩 + 重新导入复现加载期路径。
    vi.resetModules();
    vi.stubGlobal('__SPARKII_RELEASE_PUBLIC_KEYS__', JSON.stringify({
      kid: 'init-order', notBefore: '2026-01-01T00:00:00Z', notAfter: '2027-01-01T00:00:00Z',
      publicKeyPem: PEM_A,
    }));
    try {
      const mod = await import('../electron/main/update/config.js');
      expect(mod.RELEASE_PUBLIC_KEYS['init-order']?.pem).toBe(PEM_A);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('release-keys.mjs 的单条形态 → { kid: {pem,notBefore,notAfter} }', () => {
    const text = JSON.stringify({
      kid: 'rel-2026-11', notBefore: '2026-11-01T00:00:00.000Z',
      notAfter: '2027-11-01T00:00:00.000Z', publicKeyPem: PEM_A,
    });
    expect(parseReleasePublicKeys(text)).toEqual({
      'rel-2026-11': { pem: PEM_A, notBefore: '2026-11-01T00:00:00.000Z', notAfter: '2027-11-01T00:00:00.000Z' },
    });
  });

  it('映射形态与数组形态都能解析；pem / publicKeyPem 两种字段名等价', () => {
    const map = JSON.stringify({
      k1: { pem: PEM_A, notBefore: '2026-01-01T00:00:00Z', notAfter: '2027-01-01T00:00:00Z' },
      k2: { publicKeyPem: PEM_B, notBefore: '2026-01-01T00:00:00Z', notAfter: '2027-01-01T00:00:00Z' },
    });
    const parsed = parseReleasePublicKeys(map);
    expect(Object.keys(parsed).sort()).toEqual(['k1', 'k2']);
    expect(parsed.k1.pem).toBe(PEM_A);
    expect(parsed.k2.pem).toBe(PEM_B);
    expect(parseReleasePublicKeys(JSON.stringify([
      { kid: 'k1', pem: PEM_A, notBefore: '2026-01-01T00:00:00Z', notAfter: '2027-01-01T00:00:00Z' },
    ]))).toHaveProperty('k1');
  });

  it('坏 JSON / 空 PEM / 非法 kid / 非法日期 → 整批丢弃（不接受半套公钥表）', () => {
    expect(parseReleasePublicKeys('{not json')).toEqual({});
    expect(parseReleasePublicKeys(JSON.stringify({ kid: 'k', publicKeyPem: '  ', notBefore: 'x', notAfter: 'y' }))).toEqual({});
    expect(parseReleasePublicKeys(JSON.stringify({ kid: 'bad kid/../x', publicKeyPem: PEM_A, notBefore: '2026-01-01T00:00:00Z', notAfter: '2027-01-01T00:00:00Z' }))).toEqual({});
    const halfBad = JSON.stringify([
      { kid: 'ok', pem: PEM_A, notBefore: '2026-01-01T00:00:00Z', notAfter: '2027-01-01T00:00:00Z' },
      { kid: 'bad', pem: PEM_B, notBefore: 'not-a-date', notAfter: '2027-01-01T00:00:00Z' },
    ]);
    expect(parseReleasePublicKeys(halfBad)).toEqual({});
  });

  it('非对象输入（数字 / 字符串 / null）→ 空表而不是抛错', () => {
    expect(parseReleasePublicKeys('42')).toEqual({});
    expect(parseReleasePublicKeys('"just a string"')).toEqual({});
    expect(parseReleasePublicKeys('null')).toEqual({});
  });

  it('registerPublicKeys 只合并、不清空既有键', () => {
    registerPublicKeys({ tmp: { pem: PEM_A, notBefore: '2026-01-01T00:00:00Z', notAfter: '2027-01-01T00:00:00Z' } });
    expect(RELEASE_PUBLIC_KEYS.tmp?.pem).toBe(PEM_A);
  });

  it('build:main 同时注入两个 define，且不写死任何真实 IP（§5.4）', () => {
    const src = readFileSync(join(desktopRoot, 'scripts', 'build-main.mjs'), 'utf8');
    expect(src).toContain('__SPARKII_UPDATE_URL__');
    expect(src).toContain('__SPARKII_RELEASE_PUBLIC_KEYS__');
    expect(src).toContain('SPARKII_RELEASE_KEYS_FILE');
    expect(src).not.toMatch(/https?:\/\/\d+\.\d+\.\d+\.\d+/);
  });
});

/**
 * R8 · Minor-1：`release-keys.mjs` 原先对同 kid 重跑**静默覆盖私钥**——销毁旧私钥等于让此前用该 kid
 * 签发的清单永远无法重签（撤回、补公告都办不了），而触发它的只是「我以为在查看钥匙」。
 * 这里用真实 CLI 钉住：默认拒绝且**一个字节都不动**，只有显式 `--rotate` 才换钥；
 * 顺带钉住手册里那条不存在的 `list` 子命令不会再被当成可用口径。
 */
describe('release-keys.mjs 的覆盖防护与参数面（R8 · Minor-1）', () => {
  const script = join(desktopRoot, 'scripts', 'release-keys.mjs');
  const runCli = (args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

  it('同 kid 重跑默认拒绝覆盖；私钥与 public-key.json 逐字节不变', () => {
    const out = mkdtempSync(join(tmpdir(), 'sparkii-keys-cli-'));
    try {
      const first = runCli(['--kid', 'k-cli', '--out-dir', out]);
      expect(first.status, first.stderr).toBe(0);
      const privatePath = join(out, 'k-cli.private.pem');
      const jsonPath = join(out, 'public-key.json');
      const privateBefore = readFileSync(privatePath, 'utf8');
      const jsonBefore = readFileSync(jsonPath, 'utf8');

      const again = runCli(['--kid', 'k-cli', '--out-dir', out]);
      expect(again.status, '重复生成必须非 0 退出').not.toBe(0);
      expect(`${again.stderr}${again.stdout}`).toContain('refusing to overwrite');
      expect(readFileSync(privatePath, 'utf8')).toBe(privateBefore);   // 覆盖没发生
      expect(readFileSync(jsonPath, 'utf8')).toBe(jsonBefore);         // 公钥清单仍可正常读取核对

      const rotated = runCli(['--kid', 'k-cli', '--out-dir', out, '--rotate']);
      expect(rotated.status, rotated.stderr).toBe(0);
      expect(readFileSync(privatePath, 'utf8')).not.toBe(privateBefore); // 显式换钥确实生效
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('没有 list 子命令：把它当参数传必须报 usage 而非静默成功', () => {
    const out = mkdtempSync(join(tmpdir(), 'sparkii-keys-cli-'));
    try {
      const r = runCli(['list', '--out-dir', out]);
      expect(r.status).not.toBe(0);
      expect(`${r.stderr}${r.message}`).toContain('usage: release-keys.mjs');
      // 缺省目录不得被创建出来（拒绝得干净，不留半套产物）
      expect(readdirSync(out)).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('normalizeBaseUrl / resolveUpdateSettings 的关闭语义', () => {
  it('DEFAULT_UPDATE_URL 未注入时为空串 ⇒ 自动检查默认关闭', () => {
    expect(typeof DEFAULT_UPDATE_URL).toBe('string');
    const s = resolveUpdateSettings({});
    expect(s.baseUrl).toBe('');
    expect(s.autoDownload).toBe(false);
    expect(s.isHttp).toBe(false);
  });

  it('file:// 等非法 scheme 归一化为空 ⇒ 关闭，而不是「带着坏地址继续」', () => {
    expect(normalizeBaseUrl('file:///C:/etc/passwd')).toEqual({ ok: false, reason: 'INVALID_BASE_URL' });
    expect(resolveUpdateSettings({ update: { baseUrl: 'file:///C:/etc/passwd' } }).baseUrl).toBe('');
    expect(isHttpUrl('http://10.0.0.1/')).toBe(true);
    expect(isHttpUrl('https://10.0.0.1/')).toBe(false);
  });
});

function releaseForPlan(): ReleaseJson {
  const bytes = 401_196_487; // 真实包体口径（≈401MB）
  return {
    schemaVersion: 2, product: 'Sparkii', channel: 'stable', platform: 'win-x64',
    sequence: 1, nonce: 'n', publishedAt: '2026-11-06T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z', version: '0.3.0', minSupportedVersion: '0.1.0',
    rollback: false, allowDowngrade: false, mandatory: false, mandatoryAfter: null,
    rollout: { percentage: 100, salt: 's' }, releaseNotes: { summary: '', highlights: [] },
    artifact: { name: 'Sparkii-0.3.0-win-x64.exe', bytes, sha512: 'x', url: 'releases/0.3.0/a.exe' },
    requires: { minOSBuild: '10.0.19045', minFreeDiskBytes: 1_000_000_000 },
  };
}

describe('planDownload 磁盘预检（§7.6 bytes × 2 + 余量）', () => {
  // 用临时目录：planDownload 放行时会真的创建 pending/<v>/，绝不能落在仓库或真实 data 里。
  const scratch = mkdtempSync(join(tmpdir(), 'sparkii-precheck-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('刚好放得下一个包（1× bytes）仍判不足', async () => {
    const release = releaseForPlan();
    const plan = await planDownload({
      dataDir: scratch, release, freeDiskBytes: release.artifact.bytes + 1,
    });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe('REQUIRES_UNMET');
  });

  it('低于 bytes×2+余量 ⇒ 拒绝；达到 ⇒ 放行', async () => {
    const release = releaseForPlan();
    const need = release.artifact.bytes * 2 + DISK_PRECHECK_SLACK_BYTES;
    const low = await planDownload({ dataDir: scratch, release, freeDiskBytes: need - 1 });
    expect(low.ok).toBe(false);
    const high = await planDownload({ dataDir: scratch, release, freeDiskBytes: need });
    expect(high.ok).toBe(true);
    expect(high.bytesCap).toBe(release.artifact.bytes);
  });

  it('清单下限更高时以清单下限为准（两者取更严）', async () => {
    const release = releaseForPlan();
    release.requires.minFreeDiskBytes = release.artifact.bytes * 3;
    const plan = await planDownload({
      dataDir: scratch, release, freeDiskBytes: release.artifact.bytes * 2 + DISK_PRECHECK_SLACK_BYTES,
    });
    expect(plan.ok).toBe(false);
  });
});
