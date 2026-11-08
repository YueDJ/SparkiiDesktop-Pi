// G3 · service 单测：IPC 层验签门禁（downloadUpdate / installUpdate 在清单被篡改时一律拒绝）；
// getSettings().autoDownload === false；startupScan() 零网络；事件用完整 channel 名。
// 离线 Ed25519 测试密钥 + mkdtempSync 临时目录 + 本地 http.createServer；禁止 mock 验签本身。

import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAuditThrottle } from '../../electron/main/update/audit.js';
import { pendingRoot, pendingVersionDir, stateFilePath, updatesDir } from '../../electron/main/update/dirs.js';
import { AUTO_DOWNLOAD, initUpdateService, pickBestLocal, subreasonForMethod, type UpdateDeps } from '../../electron/main/update/service.js';
import { auditChainPath, installResultPath, sentinelPath } from '../../electron/main/update/installer.js';
import { TamperedStateWriteError, UpdateStateStore } from '../../electron/main/update/state-store.js';
import type { ChannelJson, ReleaseJson } from '../../electron/main/update/types.js';
import { signatureInput } from '../../electron/main/update/verifier.js';

const KID = 'test-key-1';
const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const KEYS = {
  [KID]: { pem: publicKey as string, notBefore: '2000-01-01T00:00:00.000Z', notAfter: '2099-12-31T23:59:59.000Z' },
};
function signEnvelope(bytes: Buffer, kid = KID): string {
  const sig = sign(null, signatureInput(bytes, kid), privateKey).toString('base64');
  return JSON.stringify({ kid, signature: sig });
}

const VERSION = '0.3.0';
const NAME = 'Sparkii-0.3.0-win-x64.exe';
const ARTIFACT = Buffer.from('SERVICE-ARTIFACT-BYTES-0123456789-ABCDEF');
const SHA512 = createHash('sha512').update(ARTIFACT).digest('base64');
const NOW = Date.now();

interface World { files: Record<string, Buffer>; release: ReleaseJson; channel: ChannelJson; }
function buildWorld(now: number): World {
  const release: ReleaseJson = {
    schemaVersion: 2, product: 'Sparkii', channel: 'stable', platform: 'win-x64',
    sequence: 7, nonce: 'nonce-A',
    publishedAt: new Date(now - 3600_000).toISOString(),
    expiresAt: new Date(now + 72 * 3600_000).toISOString(),
    version: VERSION, minSupportedVersion: '0.1.0',
    rollback: false, allowDowngrade: false, mandatory: false, mandatoryAfter: null,
    rollout: { percentage: 100, salt: 's' },
    releaseNotes: { summary: '修复', highlights: ['更快'] },
    artifact: { name: NAME, bytes: ARTIFACT.length, sha512: SHA512, url: `releases/${VERSION}/${NAME}` },
    requires: { minOSBuild: '10.0.0', minFreeDiskBytes: 0 },
  };
  const releaseBytes = Buffer.from(JSON.stringify(release), 'utf8');
  const channel: ChannelJson = {
    schemaVersion: 1, product: 'Sparkii', channel: 'stable', platform: 'win-x64',
    sequence: 7, targetVersion: VERSION,
    manifestPath: `releases/${VERSION}/release.json`,
    manifestSha256: createHash('sha256').update(releaseBytes).digest('hex'),
    signaturePath: `releases/${VERSION}/release.json.sig`,
    publishedAt: release.publishedAt,
  };
  const channelBytes = Buffer.from(JSON.stringify(channel), 'utf8');
  const files: Record<string, Buffer> = {
    '/channel.json': channelBytes,
    '/channel.json.sig': Buffer.from(signEnvelope(channelBytes)),
    [`/releases/${VERSION}/release.json`]: releaseBytes,
    [`/releases/${VERSION}/release.json.sig`]: Buffer.from(signEnvelope(releaseBytes)),
    [`/releases/${VERSION}/${NAME}`]: ARTIFACT,
  };
  return { files, release, channel };
}

async function startServer(files: Record<string, Buffer>): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? '').split('?')[0];
    const body = files[pathname];
    if (body == null) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * 仿 NsisUpdater 的最小实现（§5.2 定案 A 的调用形状）：
 *  - 三个开关由 createUpdater 显式改写；
 *  - downloadUpdate() 不自己发网络，而是把活儿交给注入的 httpExecutor（与生产一致），
 *    写到「缓存目录」再返回路径数组，由 service 迁移到 pending/。
 */
function fakeUpdater(baseUrl: string, cacheRoot: string) {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  const emit = (event: string, ...args: unknown[]): void => {
    for (const cb of listeners.get(event) ?? []) cb(...args);
  };
  const fake = {
    autoDownload: true, autoInstallOnAppQuit: true, disableDifferentialDownload: false,
    httpExecutor: undefined as unknown,
    setFeedURL(_cfg: { provider: string; url: string }) {},
    async checkForUpdates() {
      return {
        updateInfo: {
          version: VERSION, path: NAME, sha512: SHA512, size: ARTIFACT.length,
          files: [{ url: `${baseUrl}releases/${VERSION}/${NAME}`, sha512: SHA512, size: ARTIFACT.length }],
        },
      };
    },
    async downloadUpdate(cancellationToken?: { cancelled?: boolean }): Promise<string[]> {
      const executor = fake.httpExecutor as {
        download(url: URL, destination: string, options: Record<string, unknown>): Promise<string>;
      };
      if (!executor) throw new Error('fake updater: httpExecutor was not injected');
      if (cancellationToken?.cancelled) throw new Error('fake updater: cancelled before start');
      const url = `${baseUrl}releases/${VERSION}/${NAME}`;
      const cacheDir = join(cacheRoot, 'updater-cache', VERSION);
      mkdirSync(cacheDir, { recursive: true });
      const destination = join(cacheDir, NAME);
      await executor.download(new URL(url), destination, {
        sha512: SHA512,
        cancellationToken,
        onProgress: (p: unknown) => emit('download-progress', p),
      });
      return [destination];
    },
    on(event: string, cb: (...a: unknown[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
      return this;
    },
    removeListener(event: string, cb: (...a: unknown[]) => void) {
      listeners.set(event, (listeners.get(event) ?? []).filter((x) => x !== cb));
      return this;
    },
  };
  return fake;
}

describe('UpdateService（A 关门面）', () => {
  let dir: string;
  let server: { baseUrl: string; close(): Promise<void> };
  let world: World;
  let files: Record<string, Buffer>;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let settingsStore: { update: Record<string, unknown> };
  let deps: UpdateDeps;

  beforeEach(async () => {
    resetAuditThrottle();
    dir = mkdtempSync(join(tmpdir(), 'sparkii-service-'));
    world = buildWorld(NOW);
    files = { ...world.files };
    server = await startServer(files);
    fetchSpy = vi.fn((...args: Parameters<typeof fetch>) => fetch(...args));
    settingsStore = { update: { baseUrl: server.baseUrl, autoCheck: false, requestTimeoutMs: 3000 } };
    deps = {
      dataDir: dir,
      currentVersion: '0.1.0',
      resourcesPath: join(dir, 'resources'),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      audit: { append: vi.fn(async () => ({})) },
      sendEvent: vi.fn(),
      loadSettings: async () => ({ ...settingsStore }) as never,
      saveSettings: vi.fn(async (patch: Record<string, unknown>) => {
        settingsStore = { update: { ...settingsStore.update, ...(patch.update as object ?? {}) } } as never;
      }),
      keyringSecret: async () => Buffer.alloc(32, 7),
      now: () => NOW,
      keys: KEYS,
      fetchFn: fetchSpy as unknown as typeof fetch,
      updater: fakeUpdater(server.baseUrl, dir) as never,
      freeDiskBytes: 10 ** 12,
    };
  });
  afterEach(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('AUTO_DOWNLOAD 常量与 getSettings().autoDownload 恒为 false', async () => {
    const svc = initUpdateService(deps);
    expect(AUTO_DOWNLOAD).toBe(false);
    const s = await svc.getSettings();
    expect(s.autoDownload).toBe(false);
    // 显式断言：不允许出现 true
    expect((s as { autoDownload: boolean }).autoDownload).not.toBe(true);
  });

  it('startupScan() 零网络：不发任何 fetch，且事件用完整 channel 名', async () => {
    const svc = initUpdateService(deps);
    await svc.startupScan();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(deps.sendEvent).toHaveBeenCalledWith('sparkii:event:update-state', expect.anything());
    const st = await svc.getState();
    expect(st.phase).toBe('idle');
    expect(st.stateTampered).toBe(false);
  });

  it('startupScan() 从 pending/ 推导可安装（零网络、不重新下载）', async () => {
    const vdir = pendingVersionDir(dir, VERSION);
    mkdirSync(vdir, { recursive: true });
    writeFileSync(join(vdir, 'release.json'), world.files[`/releases/${VERSION}/release.json`]!);
    writeFileSync(join(vdir, 'release.json.sig'), world.files[`/releases/${VERSION}/release.json.sig`]!);
    writeFileSync(join(vdir, 'channel.json'), world.files['/channel.json']!);
    writeFileSync(join(vdir, 'channel.json.sig'), world.files['/channel.json.sig']!);
    writeFileSync(join(vdir, NAME), ARTIFACT);

    const svc = initUpdateService(deps);
    await svc.startupScan();
    expect(fetchSpy).not.toHaveBeenCalled(); // 零网络，不重新下载
    const st = await svc.getState();
    expect(st.phase).toBe('readyToInstall');
    expect(st.local?.version).toBe(VERSION);
    expect(st.local?.valid).toBe(true);
  });

  it('IPC 层验签门禁：downloadUpdate 在清单被篡改时一律拒绝（成功链路 + 篡改拒绝）', async () => {
    const svc = initUpdateService(deps);
    // 先跑通「发现 → 下载 → 本地可安装」
    const good = await svc.downloadUpdate({ version: VERSION });
    expect(good.ok).toBe(true);
    expect(existsSync(join(pendingVersionDir(dir, VERSION), NAME))).toBe(true);
    expect((await svc.getState()).phase).toBe('readyToInstall');

    // 篡改 release.json（1 字节）→ 门禁拒绝，绝不退化放行
    const key = `/releases/${VERSION}/release.json`;
    const b = Buffer.from(files[key]!);
    b[10] = b[10]! ^ 0xff;
    files[key] = b;
    const bad = await svc.downloadUpdate({ version: VERSION });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe('MANIFEST_HASH_MISMATCH');
  });

  it('首装会话内「检查 → 下载 → 再检查 → 再扫描 → 安装」不得假报状态被篡改（R5 · Blocker-1 端到端）', async () => {
    // 这条用例补的是「夹具到不了判据分支」的空集：此前所有服务级测试的 baseUrl 都注定网络失败，
    // recordSeen + 镜像写 + 第二次检查从来没有在**同一个实例**里连起来跑过，于是
    // `_absent` 只置不清的缺陷（首装第二次检查起误判删档攻击）一直没人看见。
    let mirror: { sequence: number; nonce: string; version?: string } | null = null;
    const svc = initUpdateService({
      ...deps,
      seqMirror: {
        read: async () => mirror,
        write: async (rec) => { mirror = rec; },
      },
    });
    const first = await svc.checkForUpdate(true);
    expect(first.ok).toBe(true);
    expect((await svc.getState()).stateTampered).toBe(false);
    const dl = await svc.downloadUpdate({ version: VERSION });
    expect(dl.ok).toBe(true);

    const second = await svc.checkForUpdate(true);
    expect(second.reason, '同一实例的第二次检查').not.toBe('STATE_TAMPERED');
    expect(second.ok).toBe(true);

    await svc.startupScan();
    const st = await svc.getState();
    expect(st.stateTampered).toBe(false);
    expect(st.phase).not.toBe('error');
    expect(st.local?.version).toBe(VERSION);

    const inst = await svc.installUpdate({ version: VERSION });
    expect(inst.reason).not.toBe('STATE_TAMPERED');
  });

  it('镜像写入失败 ⇒ 本次运行拒绝自动更新并留痕，绝不静默当成首装（I-44）', async () => {
    // 攻击面：同用户把 keyring 目录设成只读 ⇒ 镜像永远写不进去 ⇒ 若写失败被静默放过，
    // 之后再删掉 update-state.json 就永远表现为「首次装机」，I-31 的删档防护被绕过。
    const audit = { append: vi.fn(async () => ({})) };
    const svc = initUpdateService({
      ...deps,
      audit,
      seqMirror: {
        read: async () => null,                       // 看着像「从没写过」= 首装口径
        write: async () => { throw new Error('EPERM: keyring read-only'); },
      },
    });
    const r = await svc.checkForUpdate(true);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('STATE_TAMPERED');
    expect((await svc.getState()).stateTampered).toBe(true);
    const calls = audit.append.mock.calls as Array<[Record<string, unknown>]>;
    expect(calls.some((c) => c[0].action === 'update.verify-failed'
      && String(c[0].payloadSummary).includes('seq mirror write failed'))).toBe(true);
    // 拒绝不是一次性的：再来一次仍然被同一条路径挡住，标志保持为真
    const again = await svc.checkForUpdate(true);
    expect(again.reason).toBe('STATE_TAMPERED');
    expect((await svc.getState()).stateTampered).toBe(true);
    // I-46 一致性：检查已拒绝的运行里，手动下载 / 安装绝不能绕过这道门
    const dl = await svc.downloadUpdate({ version: VERSION });
    expect(dl.ok).toBe(false);
    expect(dl.reason).toBe('STATE_TAMPERED');
    const inst = await svc.installUpdate({ version: VERSION });
    expect(inst.ok).toBe(false);
    expect(inst.reason).toBe('STATE_TAMPERED');
    // 但清理入口不被连带封锁（用户仍应能丢弃已下载的包）
    const discard = await svc.clearDownloaded({ version: VERSION });
    expect(discard.reason).not.toBe('STATE_TAMPERED');
  });

  /**
   * 让 `update-state.json` 变成"**读得出、写不回**"：先跑一次正常检查让它合法落盘，
   * 再起一个进程持有它的读句柄（libuv 不带 FILE_SHARE_DELETE ⇒ 后来的 rename 覆盖必 EPERM，
   * 与 update-watchdog 那条让位用例同一手段，本机实测真会失败）。
   * ⚠ 不能用"把路径占成目录"来造写失败：那会让读侧先失败，落进 R19 新增的第三态
   * （`EISDIR` ⇒ `STATE_WRITE_FAILED_UNREADABLE`），根本走不到成功路径的那三连写。
   */
  async function holdStateUnwritable(): Promise<() => void> {
    const warm = initUpdateService(deps);
    await warm.checkForUpdate(true);                       // 真写出合法的 update-state.json
    const statePath = stateFilePath(dir);
    if (!existsSync(statePath)) throw new Error('前置条件失败：状态文件没被写出，本条现场无法成立');
    const ready = join(dir, 'state-holder-ready.txt');
    const holder = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      const fd = fs.openSync(${JSON.stringify(statePath)}, 'r');
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      setTimeout(() => { fs.closeSync(fd); }, 20_000);
    `], { stdio: 'ignore' });
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 25));
    if (!existsSync(ready)) throw new Error('占读句柄的子进程没起来，本条现场未成立');
    rmSync(ready, { force: true });
    return () => { holder.kill(); };
  }

  it('检查成功后「记 seen / 写镜像 / 记成功」写不回 ⇒ 结构化拒绝、phase 可见、留审计（R8 · Major-1）', async () => {
    // 现场：清单**合法且验签通过**，失败发生在成功路径末尾的三连写里。
    // 修之前那三条 await 没有一个包 try：EPERM 会原样抛穿 IPC（界面显示操作系统错误串并泄漏路径），
    // 调度器还会把它误记成一次网络失败计入降级阶梯。
    const stop = await holdStateUnwritable();
    try {
      const audit = { append: vi.fn(async () => ({})) };
      let mirrorWritten: unknown = null;
      const svc = initUpdateService({
        ...deps,
        audit,
        seqMirror: { read: async () => null, write: async (rec) => { mirrorWritten = rec; } },
      });
      const before = fetchSpy.mock.calls.length;
      const r = await svc.checkForUpdate(true);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('STATE_WRITE_FAILED');
      // 用户可见文案不得带 IO 原文（原文只进审计 detail）。
      expect(String(r.message ?? '')).not.toMatch(/EPERM|EBUSY|update-state\.json/i);
      const st = await svc.getState();
      expect(st.phase, '写失败后绝不能停在 checking').toBe('error');
      expect(st.errorCode).toBe('STATE_WRITE_FAILED');
      // R18 · Major-1：单纯磁盘 / 权限写不回**不是**篡改现场 ⇒ 不得抬 tamper 闩锁、不得自称"状态不可信"。
      expect(st.stateTampered, 'IO 故障不该被升级成 STATE_TAMPERED').toBe(false);
      const calls = audit.append.mock.calls as Array<[Record<string, unknown>]>;
      expect(calls.some((c) => c[0].action === 'update.failed'
        && String(c[0].payloadSummary).includes('STATE_WRITE_FAILED_CHECK')), JSON.stringify(calls)).toBe(true);
      // 第二次仍然是拒绝，不会「这次碰巧写成了」式地静默转正。
      const again = await svc.checkForUpdate(true);
      expect(again.ok).toBe(false);
      expect(again.reason).toBe('STATE_WRITE_FAILED');
      expect(fetchSpy.mock.calls.length, '判据现场是「验签已通过」，所以必然已出网').toBeGreaterThan(before);
      expect(mirrorWritten, '状态写不回时镜像不该被单独写成功过').toBeNull();
    } finally { stop(); }
  });

  it('失败计数写不回时留痕、不抛穿，且**不**抬 tamper 闩锁（R8 · Major-1 失败支路 + R18 · Major-1 纠偏）', async () => {
    // 现场：指针签名被篡改 ⇒ 验签失败 ⇒ 走 markCheck 那条写；而状态文件读得出、写不回。
    const stop = await holdStateUnwritable();
    try {
      const audit = { append: vi.fn(async () => ({})) };
      const svc = initUpdateService({ ...deps, audit });
      files['/channel.json.sig'] = Buffer.from(JSON.stringify({ kid: KID, signature: 'AAAA' }), 'utf8');
      let thrown: unknown = null;
      const r = await svc.checkForUpdate(true).catch((err: unknown) => { thrown = err; return null; });
      expect(thrown, 'IO 原文绝不许抛穿门面').toBeNull();
      expect(r).not.toBeNull();
      expect(r!.ok).toBe(false);
      // 这次检查真正的原因是验签失败，**不是**状态被改：reason 必须是验证原因，不是 STATE_TAMPERED。
      expect(r!.reason).not.toBe('STATE_TAMPERED');
      const st = await svc.getState();
      expect(st.phase).toBe('error');
      expect(st.stateTampered).toBe(false);
      const calls = audit.append.mock.calls as Array<[Record<string, unknown>]>;
      expect(calls.some((c) => String(c[0].payloadSummary).includes('STATE_WRITE_FAILED_MARKCHECK')), JSON.stringify(calls)).toBe(true);
    } finally { stop(); }
  });

  it('只让最后一步 markSuccess 写不回 ⇒ 结构化拒绝并留 MARKSUCCESS 现场（R11 · Major-A）', async () => {
    // R11 抓到 I-57 的三段护栏里 **markSuccess 那一段全仓零覆盖**：状态文件被占成目录时
    // `recordSeen` 先抛，控制流根本走不到第三段，于是那条 catch 从未被执行过——删掉它照样全绿。
    // 这里的注入手段是既有缝：`seqMirror.write` 正好排在 recordSeen 与 markSuccess 之间，
    // 让它在成功后把状态文件的位置换成目录（等价于"另一个进程/杀软在两次写之间动了这个文件"）。
    const statePath = stateFilePath(dir);
    const audit = { append: vi.fn(async () => ({})) };
    const svc = initUpdateService({
      ...deps,
      audit,
      seqMirror: {
        read: async () => null,
        write: async () => {
          rmSync(statePath, { force: true, recursive: true });
          mkdirSync(statePath, { recursive: true });
        },
      },
    });
    const r = await svc.checkForUpdate(true);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('STATE_WRITE_FAILED');
    expect(String(r.message ?? '')).not.toMatch(/EPERM|EISDIR|update-state\.json/i);
    const st = await svc.getState();
    expect(st.phase).toBe('error');
    expect(st.errorCode).toBe('STATE_WRITE_FAILED');
    const calls = audit.append.mock.calls as Array<[Record<string, unknown>]>;
    expect(calls.some((c) => String(c[0].payloadSummary).includes('STATE_WRITE_FAILED_MARKSUCCESS')),
      JSON.stringify(calls)).toBe(true);
    // 三段现场含义必须能区分开：这条**不该**同时带 recordSeen 那一段的标签（那意味着下限也没写进去）
    expect(calls.some((c) => String(c[0].payloadSummary).includes('STATE_WRITE_FAILED_CHECK'))).toBe(false);
    rmSync(statePath, { recursive: true, force: true });
  });

  it('锚点不可信时 defer / skip 绝不报"成功"：写侧必须抛、门面必须映射成 STATE_TAMPERED（R13 · Major-2）', async () => {
    // 修之前的现场：`state-store` 的 write/mutate 在 `_tampered` 时是**静默 return**，
    // 于是 service 拿到"正常返回"⇒ 对用户报 ok:true、零审计、盘上一个字节没动。
    // 这正是本仓用例名里写着"最坏失败形态"却没被防住的那一格（当时只防了 rename 失败）。
    const st = new UpdateStateStore({
      dataDir: dir, secret: Buffer.alloc(32, 7), now: () => Date.now(),
    });
    // 先合法写一份，再把 mac 改一个字符 ⇒ 形态合法、只有 MAC 不符（真"改字节"现场）。
    await st.recordSeen(12, 'nonce-Z', '0.3.0');
    const statePath = stateFilePath(dir);
    const text = readFileSync(statePath, 'utf8');
    const m = /"mac":"([A-Za-z0-9+/=]+)"/.exec(text);
    expect(m && m[1], `状态文件里没有 mac：${text.slice(0, 120)}`).toBeTruthy();
    const original = m![1]!;
    const flipped = original[0] === 'A' ? `B${original.slice(1)}` : `A${original.slice(1)}`;
    const broken = text.replace(`"mac":"${original}"`, `"mac":"${flipped}"`);
    writeFileSync(statePath, broken, 'utf8');
    const bytesBefore = readFileSync(statePath);

    const audit = { append: vi.fn(async () => ({})) };
    const svc = initUpdateService({ ...deps, audit });   // 新实例 ⇒ 重新读那份坏状态
    const r = await svc.checkForUpdate(true);            // 先把闩锁抬起来（走 MAC_BROKEN 分支）
    expect(r.reason).toBe('STATE_TAMPERED');
    const d = await svc.deferUpdate();
    expect(d.ok, '稍后提醒绝不能报成功').toBe(false);
    expect(d.reason).toBe('STATE_TAMPERED');
    const sk = await svc.skipUpdate({ version: VERSION });
    expect(sk.ok).toBe(false);
    expect(sk.reason).toBe('STATE_TAMPERED');
    // 盘上仍是那份坏文件：拒绝 = 没写，而不是"写了个默认状态盖掉现场"。
    expect(readFileSync(statePath).equals(bytesBefore)).toBe(true);
  });

  it('状态不可信时即便调用方漏检，store 也会抛而不是静默成功（R13 · Major-2 的底层一格）', async () => {
    const store = new UpdateStateStore({ dataDir: dir, secret: Buffer.alloc(32, 7), now: () => Date.now() });
    await store.recordSeen(13, 'nonce-Y', '0.3.0');
    const statePath = stateFilePath(dir);
    writeFileSync(statePath, readFileSync(statePath, 'utf8').replace(/"mac":"/, '"mac":"FF'), 'utf8');
    const fresh = new UpdateStateStore({ dataDir: dir, secret: Buffer.alloc(32, 7), now: () => Date.now() });
    expect(fresh.isTampered()).toBe(true);
    await expect(fresh.defer(Date.now() + 60_000)).rejects.toBeInstanceOf(TamperedStateWriteError);
    await expect(fresh.skip('0.9.9')).rejects.toBeInstanceOf(TamperedStateWriteError);
    await expect(fresh.markSuccess(Date.now())).rejects.toBeInstanceOf(TamperedStateWriteError);
  });

  it('设置落盘 / 下载前目录预检失败时给结构化拒绝，不把 IO 原文抛给 IPC（R13 · Major-1）', async () => {
    // (a) saveSettings：原先是裸 await，EPERM 原文一路渲染到设置面板。
    const auditA = { append: vi.fn(async () => ({})) };
    const svcA = initUpdateService({
      ...deps,
      audit: auditA,
      saveSettings: vi.fn(async () => { throw new Error('EPERM: operation not permitted, rename C:\\Users\\x\\settings.json.tmp'); }),
    });
    const rA = await svcA.saveSettings({ autoCheck: true });
    expect(rA.ok).toBe(false);
    expect(rA.reason).toBe('LOCAL_STORAGE_FAILED');
    expect(String(rA.message ?? '')).not.toMatch(/EPERM|settings\.json|Users/i);
    const callsA = auditA.append.mock.calls as Array<[Record<string, unknown>]>;
    expect(callsA.some((c) => String(c[0].payloadSummary).includes('LOCAL_STORAGE_FAILED_SETTINGS')), JSON.stringify(callsA)).toBe(true);

    // (b) planDownload：把 pending 的位置占成普通文件 ⇒ 目录预检 ENOTDIR（原先在 try 之外，直接抛穿）。
    const pendingPath = pendingRoot(dir);
    mkdirSync(updatesDir(dir), { recursive: true });
    writeFileSync(pendingPath, 'occupied as a file');
    const auditB = { append: vi.fn(async () => ({})) };
    const svcB = initUpdateService({ ...deps, audit: auditB });
    let thrown: unknown = null;
    const rB = await svcB.downloadUpdate({ version: VERSION }).catch((err: unknown) => { thrown = err; return null; });
    expect(thrown, 'IO 原文绝不许抛穿门面').toBeNull();
    expect(rB).not.toBeNull();
    expect(rB!.ok).toBe(false);
    expect(rB!.reason).toBe('LOCAL_STORAGE_FAILED');
    expect(String(rB!.message ?? '')).not.toMatch(/ENOTDIR|EBUSY|EEXIST|pending/i);
    const callsB = auditB.append.mock.calls as Array<[Record<string, unknown>]>;
    expect(callsB.some((c) => String(c[0].payloadSummary).includes('LOCAL_STORAGE_FAILED_PLAN')), JSON.stringify(callsB)).toBe(true);
    rmSync(pendingPath, { force: true });
  });

  it('清理已下载的包删不掉时不得报"已清理"（R13 · Major-1 的假成功一格）', async () => {
    // 现场手段：`removePackage` 注入缝。为什么不用真磁盘手段——R13 独立复核时承认「持读句柄」与
    // `icacls /deny` 两种方式本机都让 `rm` 成功，我自己也复现了同一结果（那条用例第一次就是这么写的，红了），
    // 所以这里不假装能自然造出 rm 失败，改用注入：生产路径不传 ⇒ 走的仍是真的 clearPending。
    const vdir = pendingVersionDir(dir, VERSION);
    mkdirSync(vdir, { recursive: true });
    writeFileSync(join(vdir, NAME), ARTIFACT);
    const audit = { append: vi.fn(async () => ({})) };
    const svc = initUpdateService({
      ...deps,
      audit,
      removePackage: async () => false,          // 等价于"删了但没删掉"
    });
    const r = await svc.clearDownloaded({ version: VERSION });
    expect(r.ok, '删不掉却报已清理＝假成功').toBe(false);
    expect(r.reason).toBe('LOCAL_STORAGE_FAILED');
    expect(existsSync(vdir)).toBe(true);         // 现场没被谎报
    const calls = audit.append.mock.calls as Array<[Record<string, unknown>]>;
    expect(calls.some((c) => String(c[0].payloadSummary).includes('LOCAL_STORAGE_FAILED_CLEAR')), JSON.stringify(calls)).toBe(true);
    // 对照：默认实现（真的 clearPending）在正常盘上是成功的 ⇒ 证明这条缝没有把正常路径变成拒绝。
    const svc2 = initUpdateService(deps);
    const r2 = await svc2.clearDownloaded({ version: VERSION });
    expect(r2.ok).toBe(true);
    expect(existsSync(vdir)).toBe(false);
  });

  it('状态文件写不回时，defer / skip / 重置检查标识都给结构化拒绝而不是把 EPERM 抛给 IPC（R7 · N-2）', async () => {
    // 注入手段：把 update-state.json 的位置占成目录 ⇒ 任何 rename 覆盖都会 EPERM。
    const statePath = stateFilePath(dir);
    mkdirSync(statePath, { recursive: true });
    const audit = { append: vi.fn(async () => ({})) };
    const svc = initUpdateService({ ...deps, audit });
    for (const [name, call] of [
      ['deferUpdate', () => svc.deferUpdate()],
      ['skipUpdate', () => svc.skipUpdate({ version: VERSION })],
      ['resetInstallId', () => svc.resetInstallId()],
    ] as Array<[string, () => Promise<{ ok?: boolean; reason?: string }>]>) {
      const r = await call();
      expect(r.ok, name).toBe(false);
      expect(r.reason, name).toBe('STATE_WRITE_FAILED');
    }
    const calls = audit.append.mock.calls as Array<[Record<string, unknown>]>;
    expect(calls.filter((c) => c[0].action === 'update.failed'
      && String(c[0].payloadSummary).includes('STATE_WRITE_FAILED')).length).toBe(3);
    // 而且**不得**把三个方法之一伪装成成功（这是最坏的失败形态）
    rmSync(statePath, { recursive: true, force: true });
  });

  it('锚点异常被拒之后，同一次运行里的再检查不得继续出网 / 不得报「发现新版本」（R7 · N-3）', async () => {
    let mirror: { sequence: number; nonce: string; version?: string } | null = null;
    const svc = initUpdateService({
      ...deps,
      seqMirror: {
        read: async () => mirror,
        write: async (rec) => { mirror = rec; throw new Error('EPERM: keyring read-only'); },
      },
    });
    const first = await svc.checkForUpdate(true);
    expect(first.reason).toBe('STATE_TAMPERED');
    const after = fetchSpy.mock.calls.length;
    const second = await svc.checkForUpdate(true);
    expect(second.reason).toBe('STATE_TAMPERED');
    expect(fetchSpy.mock.calls.length, '被拒之后的检查必须不再出网').toBe(after);
    const st = await svc.getState();
    expect(st.stateTampered).toBe(true);
    expect(st.remote, '拒绝的运行里不得把远端版本报成可下载').toBeNull();
    // M-4：取消下载不得把这条异常状态洗成正常
    const cancel = await svc.cancelDownload();
    expect(cancel.ok).toBe(true);
    const afterCancel = await svc.getState();
    expect(afterCancel.errorCode).toBe('STATE_TAMPERED');
    expect(afterCancel.stateTampered).toBe(true);
  });

  it('downloadUpdate 在指针签名被篡改时拒绝', async () => {
    files['/channel.json.sig'] = Buffer.from(JSON.stringify({ kid: KID, signature: 'AAAA' }));
    const svc = initUpdateService(deps);
    const bad = await svc.downloadUpdate({ version: VERSION });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe('SIGNATURE_INVALID');
  });

  it('已下载包版本恰好等于当前运行版本 ⇒ 不显示「可安装」，但包留在盘上作恢复介质（I-27 正向钉，R9 · D-4）', async () => {
    // I-27 的语义取舍：不动设计明文的 `version >= app.getVersion()` 验签判据（它承担防降级），
    // 只在状态推导层排除「版本恰等于当前运行版本」那一份。此前全仓没有一条正向用例钉它
    // ⇒ 删掉 filter 也照样全绿（R9 · D-4），这里连对照组一起补上。
    const vdir = pendingVersionDir(dir, VERSION);
    mkdirSync(vdir, { recursive: true });
    writeFileSync(join(vdir, 'release.json'), files[`/releases/${VERSION}/release.json`]!);
    writeFileSync(join(vdir, 'release.json.sig'), files[`/releases/${VERSION}/release.json.sig`]!);
    writeFileSync(join(vdir, 'channel.json'), files['/channel.json']!);
    writeFileSync(join(vdir, 'channel.json.sig'), files['/channel.json.sig']!);
    writeFileSync(join(vdir, NAME), files[`/releases/${VERSION}/${NAME}`]!);

    const same = initUpdateService({ ...deps, currentVersion: VERSION });
    await same.startupScan();
    const st = await same.getState();
    expect(st.local).toBeNull();
    expect(st.phase).toBe('idle');
    expect(existsSync(join(vdir, NAME))).toBe(true);          // 只是不显示成待办动作，绝不删包

    // 对照：运行版本更低时同一份包必须显示可安装（证明排除条件不是恒真）
    const lower = initUpdateService(deps);
    await lower.startupScan();
    expect((await lower.getState()).local?.version).toBe(VERSION);
  });

  it('IPC 层验签门禁：installUpdate 在伴生清单被篡改时一律拒绝', async () => {
    // 写入合法伴生清单
    const vdir = pendingVersionDir(dir, VERSION);
    mkdirSync(vdir, { recursive: true });
    writeFileSync(join(vdir, 'release.json'), world.files[`/releases/${VERSION}/release.json`]!);
    writeFileSync(join(vdir, 'release.json.sig'), world.files[`/releases/${VERSION}/release.json.sig`]!);
    writeFileSync(join(vdir, 'channel.json'), world.files['/channel.json']!);
    writeFileSync(join(vdir, 'channel.json.sig'), world.files['/channel.json.sig']!);
    writeFileSync(join(vdir, NAME), ARTIFACT);

    const svc = initUpdateService(deps);
    // 合法清单 → A 关占位返回 INSTALL_BLOCKED（B 关开放），不是「验签通过」
    const valid = await svc.installUpdate({ version: VERSION });
    expect(valid.ok).toBe(false);
    expect(valid.reason).toBe('INSTALL_BLOCKED');

    // 篡改伴生清单（1 字节）→ 验签门禁拒绝，且不是 INSTALL_BLOCKED（说明被门禁拦下）
    const b = Buffer.from(readFileSync(join(vdir, 'release.json')));
    b[10] = b[10]! ^ 0xff;
    writeFileSync(join(vdir, 'release.json'), b);
    const bad = await svc.installUpdate({ version: VERSION });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe('MANIFEST_HASH_MISMATCH');
  });

  it('onBeforeQuit() A 关恒 true；shutdown() 可安全调用', async () => {
    const svc = initUpdateService(deps);
    expect(svc.onBeforeQuit()).toBe(true);
    await expect(svc.shutdown()).resolves.toBeUndefined();
  });

  // ───────── R16 的四条 Major + 一条 Minor：全部走**门面 / 生产装配**，不再只断注入缝 ─────────
  // R16 · Major-2 的原话是"测试断的是缝、生产走的是包装器"。下面这几条就是补在生产入口上的。

  it('Major-1：审计库写失败时 saveSettings / resetInstallId 不把 IO 原文抛穿门面', async () => {
    const throwingAudit = {
      append: vi.fn(async () => { throw new Error("EPERM: operation not permitted, rename 'C:\\Users\\bob\\AppData\\Local\\SparkiiDesktop\\data\\audit.db.tmp' -> '...audit.db'"); }),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const svc = initUpdateService({ ...deps, audit: throwingAudit, logger });
    let thrown: unknown = null;
    // baseUrl 变更 ⇒ 那条原先裸调 deps.audit.append 的路径
    const r = await svc.saveSettings({ baseUrl: 'http://127.0.0.1:9999/updates' }).catch((err: unknown) => { thrown = err; return null; });
    expect(thrown, '审计写失败绝不许把异常抛穿到 IPC').toBeNull();
    expect(r?.ok, '设置本身已落盘 ⇒ 如实报成功（缺留痕由 logger 负责暴露）').toBe(true);
    expect(String(r?.message ?? '')).not.toMatch(/EPERM|audit\.db|Users/i);
    const warns = (logger.warn as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>;
    expect(warns.some((w) => /审计写入失败/.test(String(w[0]))), JSON.stringify(warns)).toBe(true);

    let thrown2: unknown = null;
    const r2 = await svc.resetInstallId().catch((err: unknown) => { thrown2 = err; return null; });
    expect(thrown2).toBeNull();
    expect(r2?.ok).toBe(true);
    expect(String(r2?.message ?? '')).not.toMatch(/EPERM|audit\.db/i);
    expect(throwingAudit.append).toHaveBeenCalled();
  });

  it('Major-2：安装完成后的启动自检确实把 update.completed 写进 AuditStore（生产装配，不是注入缝）', async () => {
    const audit = { append: vi.fn(async () => ({})) };
    // 装完重启的真实现场：哨兵 + watchdog 结果 + 运行版本已经是目标版本。
    const now = Date.now();
    mkdirSync(updatesDir(dir), { recursive: true });
    writeFileSync(sentinelPath(dir), JSON.stringify({
      schemaVersion: 1, writer: 'main', txnId: 'install-txn-1', phase: 'watchdog-started',
      fromVersion: '0.1.0', targetVersion: VERSION, packageSha512: SHA512,
      artifactPath: join(pendingVersionDir(dir, VERSION), NAME),
      installDir: 'D:\\software\\SparkiiPi',
      snapshotPath: join(updatesDir(dir), 'snapshots', 'install-txn-1'),
      snapshotManifestPath: join(updatesDir(dir), 'snapshots', 'install-txn-1', 'manifest.json'),
      resultPath: installResultPath(dir),
      createdAt: now, expiresAt: now + 10 * 60_000,
    }), 'utf8');
    writeFileSync(installResultPath(dir), JSON.stringify({
      ok: true, exitCode: 0, targetVersion: VERSION, packageSha512: SHA512,
      parentGoneAt: new Date(now).toISOString(), spawnedAt: new Date(now).toISOString(),
      writtenAt: new Date(now).toISOString(), writer: 'watchdog',
    }), 'utf8');
    const svc = initUpdateService({ ...deps, currentVersion: VERSION, audit });
    await svc.startupScan();
    const calls = audit.append.mock.calls as Array<[Record<string, unknown>]>;
    // 修之前：`verifyStartup(...)` 包装器写死 opts={} ⇒ 这一条在生产路径上永远不会出现，
    // 而名字里写着"写 update.completed 与 update.cleanup 审计"的用例走的是 verifyStartupWith({audit})。
    expect(calls.some((c) => c[0].action === 'update.completed'), JSON.stringify(calls)).toBe(true);
    expect(existsSync(sentinelPath(dir))).toBe(false);   // 自检确实收口了事务记录
  });

  it('Major-3：mac 被改一格（下限不可信的第二种现场）时 startupScan 绝不删已下载的包', async () => {
    // 先用真链路把一个合法包装到 pending/，再把状态文件的 mac 改一个字符。
    const svc0 = initUpdateService(deps);
    expect((await svc0.checkForUpdate(true)).ok).toBe(true);
    const dl = await svc0.downloadUpdate({ version: VERSION });
    expect(dl.ok).toBe(true);
    const vdir = pendingVersionDir(dir, VERSION);
    expect(existsSync(join(vdir, NAME))).toBe(true);

    const statePath = stateFilePath(dir);
    const text = readFileSync(statePath, 'utf8');
    const m = /"mac":"([A-Za-z0-9+/=]+)"/.exec(text);
    expect(m && m[1]).toBeTruthy();
    const original = m![1]!;
    const flipped = original[0] === 'A' ? `B${original.slice(1)}` : `A${original.slice(1)}`;
    writeFileSync(statePath, text.replace(`"mac":"${original}"`, `"mac":"${flipped}"`), 'utf8');

    const audit = { append: vi.fn(async () => ({})) };
    const svc = initUpdateService({ ...deps, audit });
    await svc.startupScan();
    // 修之前：这里只挡了「文件被删」那一半，被改字节时 scanOpts 把下限顶到 MAX_SAFE_INTEGER，
    // 合法包被判 SEQUENCE_REGRESSION 并被 rm —— 与我自己在上一行注释里写的"二次伤害"矛盾。
    expect(existsSync(join(vdir, NAME)), '已下载并验签通过的包不得因为本地锚点异常而被删').toBe(true);
    const st = await svc.getState();
    expect(st.stateTampered).toBe(true);
    const calls = audit.append.mock.calls as Array<[Record<string, unknown>]>;
    expect(calls.some((c) => String(c[0].payloadSummary).includes('SEQUENCE_REGRESSION')), JSON.stringify(calls)).toBe(false);
  });

  it('Major-4：锚点异常被拒之后，成功清理已下载的包不得把 errorCode 洗成 idle（M-4 的第二个入口）', async () => {
    // 现场必须是真的 STATE_TAMPERED：先合法检查 + 下载，再把 update-state.json 的 mac 改一格。
    // ⚠ 先前这里用"把状态文件位置占成目录"造异常，R19 之后那一手落进 unreadable 第三态
    //   （reason 变成 STATE_WRITE_FAILED、不抬闩锁），测的根本不是这条闩锁，故整段换成真篡改。
    const svc0 = initUpdateService(deps);
    expect((await svc0.checkForUpdate(true)).ok).toBe(true);
    expect((await svc0.downloadUpdate({ version: VERSION })).ok).toBe(true);
    const vdir = pendingVersionDir(dir, VERSION);
    expect(existsSync(join(vdir, NAME))).toBe(true);

    const statePath = stateFilePath(dir);
    const text = readFileSync(statePath, 'utf8');
    const m = /"mac":"([A-Za-z0-9+/=]+)"/.exec(text);
    expect(m && m[1]).toBeTruthy();
    const original = m![1]!;
    const flipped = original[0] === 'A' ? `B${original.slice(1)}` : `A${original.slice(1)}`;
    writeFileSync(statePath, text.replace(`"mac":"${original}"`, `"mac":"${flipped}"`), 'utf8');

    const svc = initUpdateService(deps);
    const first = await svc.checkForUpdate(true);
    expect(first.reason).toBe('STATE_TAMPERED');
    const cleared = await svc.clearDownloaded({ version: VERSION });
    expect(cleared.ok).toBe(true);                        // 清理本身是允许的（刻意不锁）
    expect(existsSync(join(vdir, NAME)), '清理要真的删掉包').toBe(false);
    const st = await svc.getState();
    expect(st.errorCode, '清理成功不能顺手抹掉锚点异常的可见性').toBe('STATE_TAMPERED');
    expect(st.phase).toBe('error');
    expect(st.stateTampered).toBe(true);
  });

  it('第三态（位置读不动）下 download / install 都不出网、不进事务（I-81 / R20 · Major）', async () => {
    // 真现场：把 update-state.json 的位置占成目录 ⇒ EISDIR，读侧进第三态（不是 absent / tampered）。
    mkdirSync(stateFilePath(dir), { recursive: true });
    const audit = { append: vi.fn(async () => ({})) };
    const svc = initUpdateService({ ...deps, audit });
    const check = await svc.checkForUpdate(true);
    expect(check.reason).toBe('STATE_WRITE_FAILED');
    expect(fetchSpy).not.toHaveBeenCalled();           // 检查早退发生在出网之前
    const dl = await svc.downloadUpdate({ version: VERSION });
    expect(dl.ok).toBe(false);
    expect(dl.reason).toBe('STATE_WRITE_FAILED');
    expect(fetchSpy, '原先点下载仍会跑完 4 条元数据请求').not.toHaveBeenCalled();
    const inst = await svc.installUpdate({ version: VERSION });
    expect(inst.ok).toBe(false);
    expect(inst.reason).toBe('STATE_WRITE_FAILED');
    const st = await svc.getState();
    expect(st.errorCode).toBe('STATE_WRITE_FAILED');
    expect(st.stateTampered).toBe(false);              // 第三态刻意不抬闩锁
    const calls = audit.append.mock.calls as Array<[Record<string, unknown>]>;
    expect(calls.some((c) => String(c[0].payloadSummary).includes('STATE_WRITE_FAILED_UNREADABLE')), JSON.stringify(calls)).toBe(true);
  });

  it('清理失败也洗不掉锚点异常：闩锁在场时界面仍以 STATE_TAMPERED 说话（I-82 / R20 · Major / R21 · Minor-2）', async () => {
    // 真 tampered 现场：先写合法状态文件，再翻一个 mac 字符（与 I-71 用例同一手段）。
    const warm = initUpdateService(deps);
    await warm.checkForUpdate(true);
    const statePath = stateFilePath(dir);
    const text = readFileSync(statePath, 'utf8');
    const m = /"mac":"([A-Za-z0-9+/=]+)"/.exec(text)!;
    const flipped = m[1]![0] === 'A' ? `B${m[1]!.slice(1)}` : `A${m[1]!.slice(1)}`;
    writeFileSync(statePath, text.replace(`"mac":"${m[1]}"`, `"mac":"${flipped}"`), 'utf8');
    const svc = initUpdateService({ ...deps, removePackage: async () => false });
    const first = await svc.checkForUpdate(true);
    expect(first.reason).toBe('STATE_TAMPERED');       // 闩锁已立
    const cleared = await svc.clearDownloaded({ version: VERSION });
    expect(cleared.ok).toBe(false);                    // 动作结果仍如实报失败
    expect(cleared.reason).toBe('LOCAL_STORAGE_FAILED');
    const st = await svc.getState();
    expect(st.errorCode, '失败出口同样不许把安全定性洗掉').toBe('STATE_TAMPERED');
    expect(st.stateTampered).toBe(true);
  });

  it('用户点安装失败的本次运行里，INSTALL_FAILED 同时进库与进链（I-83 / R20 · Major）', async () => {
    // 合法伴生清单 ⇒ B 关占位返回 INSTALL_BLOCKED（绝不真跑 NSIS）。
    const vdir = pendingVersionDir(dir, VERSION);
    mkdirSync(vdir, { recursive: true });
    writeFileSync(join(vdir, 'release.json'), files[`/releases/${VERSION}/release.json`]!);
    writeFileSync(join(vdir, 'release.json.sig'), files[`/releases/${VERSION}/release.json.sig`]!);
    writeFileSync(join(vdir, 'channel.json'), files['/channel.json']!);
    writeFileSync(join(vdir, 'channel.json.sig'), files['/channel.json.sig']!);
    writeFileSync(join(vdir, NAME), ARTIFACT);
    const audit = { append: vi.fn(async () => ({})) };
    const svc = initUpdateService({ ...deps, audit });
    const r = await svc.installUpdate({ version: VERSION });
    expect(r.ok).toBe(false);
    const calls = audit.append.mock.calls as Array<[Record<string, unknown>]>;
    expect(calls.some((c) => c[0].action === 'update.failed'
      && String(c[0].payloadSummary).includes('INSTALL_FAILED')), JSON.stringify(calls)).toBe(true);
    // 链：逐次历史不受限流影响，本次动作必须留一条（原先要等下次启动读哨兵才可能补）。
    expect(readFileSync(auditChainPath(dir), 'utf8')).toContain('INSTALL_FAILED');
  });

  it('同版本构建元数据包不被显示成可安装（I-85 / R20 域3）', () => {
    const locals = [
      { version: '0.3.0+build.2', sequence: 9, artifactPath: 'b' },
    ] as unknown as Parameters<typeof pickBestLocal>[0];
    // `compareVersions` 只比三段数字 ⇒ 0.3.0 与 0.3.0+build.2 判等，必须一起排除。
    expect(pickBestLocal(locals, '0.3.0')).toBeNull();
    // 对照：运行版本更低时同一份包仍显示可安装 ⇒ 排除条件不是恒真。
    expect(pickBestLocal(locals, '0.2.9')?.version).toBe('0.3.0+build.2');
  });

  it('远端版本 == 当前版本 ⇒ 「已是最新」：phase=idle、remote=null、不写 update.available（防 UI 误报）', async () => {
    const audit = { append: vi.fn(async () => ({})) };
    let mirror: { sequence: number; nonce: string; version?: string } | null = null;
    const svc = initUpdateService({
      ...deps,
      currentVersion: VERSION,                       // 与远端清单同版本
      audit,
      seqMirror: { read: async () => mirror, write: async (rec) => { mirror = rec; } },
    });
    const r = await svc.checkForUpdate(true);
    expect(r.ok).toBe(true);
    expect(r.message).toBe('已是最新版本');
    const st = await svc.getState();
    expect(st.phase, '同版本不得停在 available').toBe('idle');
    expect(st.remote, '同版本不是可下载的远端').toBeNull();
    // 不是「恰好没跑到」：同版本成功路径一条 update.* 审计都不该写（含 update.available）。
    expect(audit.append, '同版本成功路径不应写更新审计').not.toHaveBeenCalled();

    // 不提示 ≠ 丢掉防重放锚点：同版本清单的 sequence / nonce 必须照常推进。
    expect(mirror).not.toBeNull();
    expect(mirror!.sequence).toBe(world.release.sequence);
    expect(mirror!.nonce).toBe(world.release.nonce);
    const onDisk = new UpdateStateStore({ dataDir: dir, secret: Buffer.alloc(32, 7), now: () => NOW });
    expect(onDisk.lastSeenSequence()).toBe(world.release.sequence);
    expect(onDisk.nonceFor(world.release.sequence)).toBe(world.release.nonce);
  });

  it('远端更高版本仍正常提示（修复没有把所有远端都吞掉）', async () => {
    const audit = { append: vi.fn(async () => ({})) };
    const svc = initUpdateService({ ...deps, audit });   // currentVersion 0.1.0 < 远端 0.3.0
    const r = await svc.checkForUpdate(true);
    expect(r.ok).toBe(true);
    const st = await svc.getState();
    expect(st.phase).toBe('available');
    expect(st.remote?.version).toBe(VERSION);
    const calls = audit.append.mock.calls as Array<[Record<string, unknown>]>;
    expect(calls.some((c) => c[0].action === 'update.available'
      && String(c[0].payloadSummary).includes(VERSION)), JSON.stringify(calls)).toBe(true);
  });

  it('远端与本地 pending 都是当前版本 ⇒ 仍只报「已是最新」，包留在盘上但不显示为可安装', async () => {
    const vdir = pendingVersionDir(dir, VERSION);
    mkdirSync(vdir, { recursive: true });
    writeFileSync(join(vdir, 'release.json'), world.files[`/releases/${VERSION}/release.json`]!);
    writeFileSync(join(vdir, 'release.json.sig'), world.files[`/releases/${VERSION}/release.json.sig`]!);
    writeFileSync(join(vdir, 'channel.json'), world.files['/channel.json']!);
    writeFileSync(join(vdir, 'channel.json.sig'), world.files['/channel.json.sig']!);
    writeFileSync(join(vdir, NAME), ARTIFACT);

    const svc = initUpdateService({ ...deps, currentVersion: VERSION });
    const r = await svc.checkForUpdate(true);
    expect(r.ok).toBe(true);
    const st = await svc.getState();
    expect(st.phase).toBe('idle');
    expect(st.remote).toBeNull();
    expect(st.local, '同版本 pending 不是待办动作').toBeNull();
    expect(existsSync(join(vdir, NAME)), '只是不显示成待办动作，绝不删包').toBe(true);
  });

  it('同版本检查后点「取消下载」：不得凭空回到 available（remote 为 null 就是 idle）', async () => {
    const svc = initUpdateService({ ...deps, currentVersion: VERSION });
    expect((await svc.checkForUpdate(true)).ok).toBe(true);
    const r = await svc.cancelDownload();
    expect(r.ok).toBe(true);
    const st = await svc.getState();
    expect(st.phase, 'remote=null 时 available 会让状态栏显示没有版本号的新版').toBe('idle');
    expect(st.remote).toBeNull();
  });

  it('跳过该版本后检查：文案说明已跳过，而不是误报「已是最新」', async () => {
    const audit = { append: vi.fn(async () => ({})) };
    const svc = initUpdateService({ ...deps, audit });
    await svc.skipUpdate({ version: VERSION });
    const r = await svc.checkForUpdate(true);          // currentVersion 0.1.0 < 远端 0.3.0
    expect(r.ok).toBe(true);
    expect(r.message).toBe('该版本已跳过，不再提醒');
    expect((await svc.getState()).phase).toBe('idle');
    expect(audit.append, '跳过 ≠ 发现新版本').not.toHaveBeenCalled();
  });

  it('Minor-1：没有登记标签的新入口**各占一把**限流键（不再共用 _OTHER）', async () => {
    const a = subreasonForMethod('STATE_WRITE_FAILED', 'installUpdate');
    const b = subreasonForMethod('STATE_WRITE_FAILED', 'cancelDownload');
    const c = subreasonForMethod('STATE_WRITE_FAILED', 'startupScan');
    for (const s of [a, b, c]) {
      expect(s.length).toBeLessThanOrEqual(32);
      expect(/^[A-Z][A-Z0-9_]{0,31}$/.test(s), s).toBe(true);
      expect(s).not.toBe('STATE_WRITE_FAILED');          // 不许退化成"没标签"而与别的现场共用
      expect(s.endsWith('_OTHER'), s).toBe(false);       // 这才是 R16 抓到的共用键根因
    }
    expect(new Set([a, b, c]).size).toBe(3);             // 三个入口 ⇒ 三把键
    // 已登记的仍然用短名（可读性优先），且没被规范化路径改写
    expect(subreasonForMethod('STATE_WRITE_FAILED', 'checkForUpdate')).toBe('STATE_WRITE_FAILED_CHECK');
  });

  it('saveSettings 严格校验 URL：非法 scheme 拒绝、合法 http 放行并写审计', async () => {
    const svc = initUpdateService(deps);
    const bad = await svc.saveSettings({ baseUrl: 'file:///C:/etc/passwd' });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe('INVALID_BASE_URL');
    const good = await svc.saveSettings({ baseUrl: 'http://127.0.0.1:9999/updates' });
    expect(good.ok).toBe(true);
    const calls = (deps.audit.append as ReturnType<typeof vi.fn>).mock.calls as Array<[Record<string, unknown>]>;
    expect(calls.some((c) => c[0].action === 'update.settings-changed')).toBe(true);
    // R18 · Minor-1：I-73 的两处 reason/subreason 此前只由"直调 logUpdateEvent"的用例钉住 ⇒
    // 把 service.ts 里那两格 fields 删回去，全仓仍绿（限流键退化成 action|天||，两类现场同天只剩一条）。
    // 这里改走**门面**：同一天里"改源"与"重置检查标识"必须各自落库，且都带自己的 subreason。
    expect(calls.some((c) => c[0].action === 'update.settings-changed'
      && String(c[0].payloadSummary).includes('BASE_URL_CHANGED')), JSON.stringify(calls)).toBe(true);
    const rid = await svc.resetInstallId();
    expect(rid.ok).toBe(true);
    const calls2 = (deps.audit.append as ReturnType<typeof vi.fn>).mock.calls as Array<[Record<string, unknown>]>;
    expect(calls2.some((c) => c[0].action === 'update.settings-changed'
      && String(c[0].payloadSummary).includes('INSTALL_ID_RESET')), JSON.stringify(calls2)).toBe(true);
    // 两条都是 settings-changed ⇒ 若缺 subreason 就共用一把键、同天只剩一条；两条都在即键确实不同。
    const changed = calls2.filter((c) => c[0].action === 'update.settings-changed');
    expect(changed.length, '改源 + 重置标识在同一天必须各占一把限流键').toBeGreaterThanOrEqual(2);
    // 留痕顺序（R19 · Major-3）：写盘失败时不许声称"源已变更"⇒ 反过来也钉一次。
    // ⚠ 这里必须换一把**全新的 audit mock**：沿用 deps.audit 的话，上面那次成功留痕会让
    //    "不该出现 BASE_URL_CHANGED"的断言被历史调用喂成恒真（本仓第 3 种绿勾假象）。
    const audit3 = { append: vi.fn(async () => ({})) };
    const throwingSave = {
      ...deps,
      audit: audit3,
      saveSettings: vi.fn(async () => { throw new Error('EDQUOT: disk quota exceeded'); }),
    } as UpdateDeps;
    const svc2 = initUpdateService(throwingSave);
    const failed = await svc2.saveSettings({ baseUrl: 'http://127.0.0.1:9998/updates' });
    expect(failed.ok).toBe(false);
    const calls3 = (audit3.append as ReturnType<typeof vi.fn>).mock.calls as Array<[Record<string, unknown>]>;
    expect(calls3.some((c) => String(c[0].payloadSummary).includes('BASE_URL_CHANGED')),
      '设置没落盘就记"源已变更"＝过度留痕（R19 · Major-3）').toBe(false);
  });
});
