/**
 * I-31（R2 · B1）：DPAPI 序号下限镜像 —— 区分「首次装机」与「用过之后状态文件被删」。
 * 真磁盘 + 真 HMAC 状态文件 + 真 UpdateStateStore；不 mock 验签。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logUpdateEvent, resetAuditThrottle } from '../electron/main/update/audit.js';
import {
  SEQ_MIRROR_KEY_NAME, createSeqMirror,
} from '../electron/main/update-bootstrap.js';
import {
  WRITE_FAILURE_METHODS, initUpdateService, subreasonForMethod, type UpdateDeps,
} from '../electron/main/update/service.js';
import { UpdateStateStore } from '../electron/main/update/state-store.js';
import { stateFilePath } from '../electron/main/update/dirs.js';
import { pendingVersionDir } from '../electron/main/update/dirs.js';

function keyringStub(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: async (name: string) => (store.has(name) ? store.get(name)! : null),
    set: async (name: string, value: string) => { store.set(name, value); },
  };
}

describe('createSeqMirror（DPAPI 镜像的读写与毒化）', () => {
  it('从未写过 ⇒ null（这是「首次装机」的唯一判别依据）', async () => {
    const mirror = createSeqMirror(keyringStub());
    expect(await mirror.read()).toBe(null);
  });

  it('写入后可原样读回（含 version）', async () => {
    const kr = keyringStub();
    const mirror = createSeqMirror(kr);
    await mirror.write({ sequence: 18, nonce: 'n-18', version: '0.3.0' });
    expect(await mirror.read()).toEqual({ sequence: 18, nonce: 'n-18', version: '0.3.0' });
    expect(kr.store.get(SEQ_MIRROR_KEY_NAME)).toBeTruthy();
  });

  it('内容不可解析 / 形态非法 ⇒ 顶到上限的毒化记录，绝不是「当作没有下限」', async () => {
    for (const bad of ['{ not json', '{"sequence":"18","nonce":"n"}', '{"sequence":-3,"nonce":"n"}', '{"sequence":1.5,"nonce":"n"}', '{}', 'null', '"x"']) {
      const mirror = createSeqMirror(keyringStub({ [SEQ_MIRROR_KEY_NAME]: bad }));
      const read = await mirror.read();
      expect(read, bad).not.toBe(null);
      expect(read!.sequence, bad).toBe(Number.MAX_SAFE_INTEGER);
      expect(read!.nonce, bad).toBe('CORRUPT_MIRROR');
    }
  });

  it('空字符串 ⇒ 仍视为从未写过（不被当成毒化）', async () => {
    const mirror = createSeqMirror(keyringStub({ [SEQ_MIRROR_KEY_NAME]: '' }));
    expect(await mirror.read()).toBe(null);
  });
});

describe('UpdateStateStore 的下限判别与镜像抬升', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sparkii-mirror-store-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('fileStatus 区分 absent / ok / tampered（三者处置必须不同）', async () => {
    const s1 = new UpdateStateStore({ dataDir: dir, secret: Buffer.alloc(32, 1), now: () => 1 });
    expect(s1.fileStatus()).toBe('absent');
    await s1.recordSeen(7, 'n-7', '0.2.0');
    const s2 = new UpdateStateStore({ dataDir: dir, secret: Buffer.alloc(32, 1), now: () => 2 });
    expect(s2.fileStatus()).toBe('ok');
    expect(s2.lastSeenSequence()).toBe(7);
    // 换密钥 ⇒ tampered
    const s3 = new UpdateStateStore({ dataDir: dir, secret: Buffer.alloc(32, 2), now: () => 3 });
    expect(s3.isTampered()).toBe(true);
    expect(s3.fileStatus()).toBe('tampered');
  });

  it('镜像更高 ⇒ 抬高下限并落盘；文件更高 ⇒ 绝不降低（只抬不降）', async () => {
    const s = new UpdateStateStore({ dataDir: dir, secret: Buffer.alloc(32, 3), now: () => 4 });
    await s.recordSeen(12, 'n-12', '0.4.0');
    await s.enforceFloorFromMirror({ sequence: 9, nonce: 'n-9' });
    expect(s.lastSeenSequence()).toBe(12);                       // 不降
    await s.enforceFloorFromMirror({ sequence: 20, nonce: 'n-20', version: '0.5.0' });
    expect(s.lastSeenSequence()).toBe(20);
    expect(s.nonceFor(20)).toBe('n-20');
    // 抬高必须真的落盘，否则下次启动又回到 12
    const reopened = new UpdateStateStore({ dataDir: dir, secret: Buffer.alloc(32, 3), now: () => 5 });
    expect(reopened.lastSeenSequence()).toBe(20);
    expect(reopened.nonceFor(20)).toBe('n-20');
    expect(reopened.fileStatus()).toBe('ok');
  });

  it('MAC 合法但被回滚成更旧的文件 ⇒ 用镜像抬回来（防「旧文件恢复」绕过第Ⅶ步）', async () => {
    const secret = Buffer.alloc(32, 6);
    // 攻击者用同一把 DPAPI 密钥重算出一份合法但更旧的状态（recordSeen 的防回退挡不住整份替换）。
    const rolledBack = new UpdateStateStore({ dataDir: dir, secret, now: () => 10 });
    await rolledBack.write({
      lastSeenSequence: 25,
      sequenceNonce: { '25': 'n-25' },
      minInstalledVersion: '0.5.0',
      skippedVersions: [],
      lastCheckedAt: 1, lastSuccessAt: 1, deferredUntil: null,
      failureCount: 0, installId: 'iid',
    });
    const reopened = new UpdateStateStore({ dataDir: dir, secret, now: () => 11 });
    expect(reopened.fileStatus()).toBe('ok');               // MAC 层面完全合法
    expect(reopened.lastSeenSequence()).toBe(25);
    await reopened.enforceFloorFromMirror({ sequence: 30, nonce: 'n-30', version: '0.6.0' });
    expect(reopened.lastSeenSequence()).toBe(30);
    expect(reopened.nonceFor(30)).toBe('n-30');
    const final = new UpdateStateStore({ dataDir: dir, secret, now: () => 12 });
    expect(final.lastSeenSequence()).toBe(30);              // 抬升确实落盘
    expect(existsSync(stateFilePath(dir))).toBe(true);
  });
});

describe('service 与镜像的联动（删档重放的现场行为）', () => {
  let dir: string;
  const SECRET = Buffer.alloc(32, 7);

  beforeEach(() => {
    resetAuditThrottle();
    dir = mkdtempSync(join(tmpdir(), 'sparkii-mirror-svc-'));
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const deps = (kr: ReturnType<typeof keyringStub>, over: Partial<UpdateDeps> = {}): UpdateDeps => ({
    dataDir: dir,
    currentVersion: '0.1.0',
    resourcesPath: join(dir, 'resources'),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    audit: { append: vi.fn(async () => ({})) },
    sendEvent: vi.fn(),
    loadSettings: async () => ({
      update: { autoCheck: true, baseUrl: 'http://127.0.0.1:1/sparkii-updates/', startupDelaySeconds: 0 },
    }) as never,
    saveSettings: vi.fn(async () => {}),
    keyringSecret: async () => SECRET,
    seqMirror: createSeqMirror(kr),
    now: () => Date.now(),
    // 固定「进程已启动很久」：否则闸门里的 ±9s 随机抖动（installId=randomUUID）会让 reason
    // 在 STARTUP_DELAY / NETWORK 之间五五开跳（R3 · Blocker-1 实测 P(jitter>0)=0.5063）。
    processStartedAt: () => Date.now() - 3_600_000,
    ...over,
  } as unknown as UpdateDeps);

  it('首装（文件缺 + 镜像空）⇒ 不判状态异常，真的去试一次网络', async () => {
    const svc = initUpdateService(deps(keyringStub()));
    const r = await svc.checkForUpdate(false);
    expect(r.reason).not.toBe('STATE_TAMPERED');
    expect(r.reason).toBe('NETWORK');
  });

  it('文件被删但镜像有序号 ⇒ 本次运行拒绝自动更新，并写 verify-failed', async () => {
    const kr = keyringStub({ [SEQ_MIRROR_KEY_NAME]: JSON.stringify({ sequence: 18, nonce: 'n-18', version: '0.3.0' }) });
    const audit = { append: vi.fn(async () => ({})) };
    const svc = initUpdateService(deps(kr, { audit }));
    const r = await svc.checkForUpdate(false);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('STATE_TAMPERED');
    const st = await svc.getState();
    expect(st.stateTampered).toBe(true);
    const calls = audit.append.mock.calls as Array<[Record<string, unknown>]>;
    expect(calls.some((c) => c[0].action === 'update.verify-failed'
      && String(c[0].payloadSummary).includes('STATE_TAMPERED'))).toBe(true);
  });

  it('上一条之后状态文件已按镜像重建 ⇒ 再启动一次不再报状态异常（不永久锁死）', async () => {
    const kr = keyringStub({ [SEQ_MIRROR_KEY_NAME]: JSON.stringify({ sequence: 18, nonce: 'n-18', version: '0.3.0' }) });
    const first = initUpdateService(deps(kr));
    await first.checkForUpdate(false);
    const statePath = stateFilePath(dir);
    expect(existsSync(statePath)).toBe(true);              // 重建确实发生
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as { payload: { lastSeenSequence: number } };
    expect(parsed.payload.lastSeenSequence).toBe(18);      // 下限被抬回镜像值
    // force=true：本例只验「状态判定不再拦下」，不该被上一次失败检查的时间闸门/退避干扰。
    const second = initUpdateService(deps(kr));
    const r = await second.checkForUpdate(true);
    expect(r.reason).toBe('NETWORK');                      // 不再被状态判定拦下
  });

  it('镜像内容损坏 ⇒ 顶到上限的下限使任何清单都过不了第Ⅶ步', async () => {
    const kr = keyringStub({ [SEQ_MIRROR_KEY_NAME]: 'garbage-not-json' });
    const svc = initUpdateService(deps(kr));
    // 状态文件不存在 + 镜像损坏 ⇒ 走「缺失且有镜像」的拒绝分支
    const r = await svc.checkForUpdate(false);
    expect(r.reason).toBe('STATE_TAMPERED');
  });

  /** 先让一次检查真的写出状态文件，再把 mac 改掉 ⇒ 形态完全合法、只有 MAC 对不上。 */
  async function plantMacBroken(): Promise<void> {
    const kr = keyringStub();
    const first = initUpdateService(deps(kr));
    // checkForUpdate 的失败支路也会 markCheck ⇒ 写出合法文件（这里不关心网络结果）
    await first.checkForUpdate(true);
    const text = readFileSync(stateFilePath(dir), 'utf8');
    // mac 是 base64 文本（state-store.ts 的 mac()），改一个字符 ⇒ 长度不变、内容不等 ⇒ 只可能是 MAC 不符。
    const m = /"mac":"([A-Za-z0-9+/=]+)"/.exec(text);
    if (!m || !m[1]) throw new Error(`状态文件里找不到 mac 字段：${text.slice(0, 120)}`);
    const original = m[1];
    const flipped = original[0] === 'A' ? `B${original.slice(1)}` : `A${original.slice(1)}`;
    expect(flipped.length, '改一个字符不得改变长度（否则现场就成了「形态非法」）').toBe(original.length);
    writeFileSync(stateFilePath(dir), text.replace(`"mac":"${original}"`, `"mac":"${flipped}"`), 'utf8');
  }

  it('MAC 被改一个字符（不是删档）⇒ 拒绝且审计留下 STATE_MAC_BROKEN（R8 · Minor-2）', async () => {
    await plantMacBroken();
    const audit = { append: vi.fn(async () => ({})) };
    const svc = initUpdateService(deps(keyringStub(), { audit }));   // 新实例 = 新进程，重新读文件
    const r = await svc.checkForUpdate(true);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('STATE_TAMPERED');
    expect((await svc.getState()).stateTampered).toBe(true);
    const calls = audit.append.mock.calls as Array<[Record<string, unknown>]>;
    expect(calls.some((c) => c[0].action === 'update.verify-failed'
      && String(c[0].payloadSummary).includes('STATE_MAC_BROKEN')), JSON.stringify(calls)).toBe(true);
  });

  it('启动扫描是 MAC 破坏的第一个现场 ⇒ 出网之前就必须留痕（R8 · Minor-2）', async () => {
    await plantMacBroken();
    const audit = { append: vi.fn(async () => ({})) };
    const svc = initUpdateService(deps(keyringStub(), { audit }));
    await svc.startupScan();
    expect((await svc.getState()).stateTampered).toBe(true);
    const calls = audit.append.mock.calls as Array<[Record<string, unknown>]>;
    expect(calls.some((c) => String(c[0].payloadSummary).includes('STATE_MAC_BROKEN')), JSON.stringify(calls)).toBe(true);
  });

  it('重建状态文件时写盘失败 ⇒ 结构化拒绝而不是把异常抛出（R4 · Minor-3：抛错会打断装配）', async () => {
    const kr = keyringStub({ [SEQ_MIRROR_KEY_NAME]: JSON.stringify({ sequence: 18, nonce: 'n-18', version: '0.3.0' }) });
    const mirror = createSeqMirror(kr);
    const blocked = stateFilePath(dir);
    // 注入手段必须保住「读侧 = absent」这个前提。R19 之后**一开始**就把路径占成目录会落进
    // unreadable 第三态（`fileStatus()` 既不是 absent 也不是 ok），根本走不到重建那一次写盘，
    // 于是这一格改成"读完之后、写回之前"才出现目录——等价于另一个进程 / 杀软在这两步之间占了这个名字。
    // 目录里放一个文件：非空目录 ⇒ rename 在 POSIX 与 Windows 上都必失败（空目录在 POSIX 下会被替换掉）。
    const plant = () => {
      try {
        mkdirSync(blocked, { recursive: true });
        writeFileSync(join(blocked, 'occupier.bin'), 'x', 'utf8');
      } catch { /* 已被占住：现场已成立 */ }
    };
    const audit = { append: vi.fn(async () => ({})) };
    const svc = initUpdateService(deps(kr, {
      audit,
      seqMirror: {
        read: async () => { const m = await mirror.read(); setImmediate(plant); return m; },
        write: async (rec) => { await mirror.write(rec); },
      },
    }));
    const r = await svc.checkForUpdate(false);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('STATE_TAMPERED');
    expect((await svc.getState()).stateTampered).toBe(true);
    const calls = audit.append.mock.calls as Array<[Record<string, unknown>]>;
    expect(calls.some((c) => String(c[0].payloadSummary).includes('STATE_REBUILD_FAILED')), JSON.stringify(calls)).toBe(true);
    // startupScan 在 index.ts 的装配链上：同一现场绝不许把异常抛穿。
    await expect(svc.startupScan()).resolves.toBeUndefined();
    // 换个新实例再启动：此刻读侧就是「位置读不动」⇒ 第三态。报 STATE_WRITE_FAILED、不抬 tamper 闩锁、仍不抛错。
    const svc2 = initUpdateService(deps(kr, { audit }));
    await expect(svc2.startupScan()).resolves.toBeUndefined();
    const st2 = await svc2.getState();
    expect(st2.errorCode).toBe('STATE_WRITE_FAILED');
    expect(st2.stateTampered, 'R18 · Major-1：磁盘 / 权限现场不得被报成"本地状态不可信"').toBe(false);
    const r2 = await svc2.checkForUpdate(false);
    expect(r2.reason).toBe('STATE_WRITE_FAILED');
    rmSync(blocked, { recursive: true, force: true });
  });

  it('下限不可信时 startupScan 绝不删坏包（避免把二次伤害叠在攻击之上）', async () => {
    const kr = keyringStub({ [SEQ_MIRROR_KEY_NAME]: JSON.stringify({ sequence: 5, nonce: 'n-5' }) });
    const bad = pendingVersionDir(dir, '0.9.9');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'release.json'), '{ nonsense', 'utf8');   // 故意留一个坏现场
    const svc = initUpdateService(deps(kr));
    await svc.startupScan();
    const st = await svc.getState();
    expect(st.stateTampered).toBe(true);
    expect(st.phase).toBe('error');
    expect(existsSync(join(bad, 'release.json'))).toBe(true);          // 没有被顺手删掉
  });
});

describe('STATE_TAMPERED 五种现场在审计里彼此可区分（R5 · Minor-1 + R8 · Minor-2）', () => {
  it('同一 reason 不同 subreason ⇒ 各留一条；同一 subreason 重复 ⇒ 仍被限流压掉', async () => {
    resetAuditThrottle(() => Date.UTC(2026, 10, 6, 12));   // 固定在同一天，排除日期分桶的干扰
    const append = vi.fn(async () => ({}));
    const audit = { append };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const subs = ['STATE_FILE_DELETED', 'MIRROR_WRITE_FAILED', 'STATE_REBUILD_FAILED', 'FLOOR_RAISE_FAILED', 'STATE_MAC_BROKEN'];
    for (const sub of subs) {
      await logUpdateEvent(audit, 'update.verify-failed', { reason: 'STATE_TAMPERED', subreason: sub, detail: `d-${sub}` }, logger);
    }
    expect(append).toHaveBeenCalledTimes(5);                       // 五种现场各一条
    // I-73：`update.settings-changed` 的两类现场也必须各留一条（改道 logUpdateEvent 后
    // 若不给 subreason，两者会共用 `action|天||` 这一把键，同一天只剩一条）。
    await logUpdateEvent(audit, 'update.settings-changed', { reason: 'SETTINGS_CHANGED', subreason: 'BASE_URL_CHANGED', isHttp: true }, logger);
    await logUpdateEvent(audit, 'update.settings-changed', { reason: 'SETTINGS_CHANGED', subreason: 'INSTALL_ID_RESET' }, logger);
    expect(append).toHaveBeenCalledTimes(7);                       // 两条设置变更也各自成立
    // 重复与 flood 仍受限：同一 subreason 再来 50 次不再落库
    for (let i = 0; i < 50; i++) {
      await logUpdateEvent(audit, 'update.verify-failed', { reason: 'STATE_TAMPERED', subreason: subs[0], detail: `d-${i}` }, logger);
    }
    expect(append).toHaveBeenCalledTimes(7);            // 5 种 tamper 现场 + 2 种设置变更，重复仍被压掉
    // 不带 subreason 的旧形态不会因键格式变化而失控（同 reason 同日仍只一条）
    for (let i = 0; i < 10; i++) {
      await logUpdateEvent(audit, 'update.failed', { reason: 'NETWORK', detail: `n-${i}` }, logger);
    }
    expect(append).toHaveBeenCalledTimes(8);
    // 非法形态的 subreason（小写 / 超长 / 注入）一律退化成空 ⇒ 不给「变化键刷库」留通道
    resetAuditThrottle(() => Date.UTC(2026, 10, 7, 12));
    const append2 = vi.fn(async () => ({}));
    for (const bad of ['lower', 'A'.repeat(40), 'A;DROP', '']) {
      await logUpdateEvent({ append: append2 }, 'update.verify-failed', { reason: 'STATE_TAMPERED', subreason: bad, detail: bad }, logger);
    }
    expect(append2).toHaveBeenCalledTimes(1);
  });
});

/**
 * R14 · Major-2：审计限流键只接受 `^[A-Z][A-Z0-9_]{0,31}$`（≤32 字符），而 subreason 是在
 * `service.ts` 里**现拼**的（I-66 之前；现在标签来自 `WRITE_FAILURE_LABELS` 有限枚举表）——
 * 当时 `STATE_WRITE_FAILED_CHECKFORUPDATE` 与 `..._RESETINSTALLID` 都是 33 字符，
 * 双双退化成空标签 ⇒ 共用同一把键，同一次运行里先落的那条把后一条**静默压掉**，
 * 而运维手册写着"六种现场各留一条"。这里把"标签长度"与"限流键字符集"这两侧的耦合钉成一条判据。
 */
describe('写失败现场标签与审计限流键的耦合（R14 · Major-2）', () => {
  const KEY_SHAPE = /^[A-Z][A-Z0-9_]{0,31}$/;
  const ALL: Array<[string, string]> = [
    ['STATE_WRITE_FAILED', 'deferUpdate'], ['STATE_WRITE_FAILED', 'skipUpdate'],
    ['STATE_WRITE_FAILED', 'resetInstallId'], ['STATE_WRITE_FAILED', 'checkForUpdate'],
    ['STATE_WRITE_FAILED', 'markSuccess'], ['STATE_WRITE_FAILED', 'markCheck'],
    ['LOCAL_STORAGE_FAILED', 'planDownload'], ['LOCAL_STORAGE_FAILED', 'saveSettings'],
    ['LOCAL_STORAGE_FAILED', 'clearPending'],
  ];

  it('每个入口现拼出的 subreason 都过得了限流键判据，且不退化成无标签', () => {
    for (const [prefix, method] of ALL) {
      const sub = subreasonForMethod(prefix, method);
      expect(sub.length, `${method} → ${sub}`).toBeLessThanOrEqual(32);
      expect(KEY_SHAPE.test(sub), `${method} → ${sub}`).toBe(true);
      expect(sub, `${method} 不许退化成不带标签的 ${prefix}`).not.toBe(prefix);
    }
    // I-72① 之后未登记入口不再退化成 _OTHER（而是把方法名规范成标签）；这张表只是已知现场的短名来源。
    // 下面这条钉的是「表里每个短名仍可用」，不是「漏登记会被发现」——别再把注释写成后一种意思。
    for (const method of WRITE_FAILURE_METHODS) {
      expect(subreasonForMethod('STATE_WRITE_FAILED', method)).not.toMatch(/_OTHER$/);
    }
  });

  it('同一进程同一天里，各条现场逐条落库（限流键真的把它们分开了）', async () => {
    resetAuditThrottle(() => Date.UTC(2026, 10, 7, 12));
    const append = vi.fn(async () => ({}));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    for (const [prefix, method] of ALL) {
      await logUpdateEvent({ append }, 'update.failed', {
        reason: prefix, subreason: subreasonForMethod(prefix, method), method, detail: 'x',
      }, logger);
    }
    expect(append).toHaveBeenCalledTimes(ALL.length);
    // 重复同一现场仍然只有一条（限流本身没被削弱）
    await logUpdateEvent({ append }, 'update.failed', {
      reason: 'STATE_WRITE_FAILED', subreason: subreasonForMethod('STATE_WRITE_FAILED', 'checkForUpdate'), detail: 'again',
    }, logger);
    expect(append).toHaveBeenCalledTimes(ALL.length);
  });

  it('审计写失败时**不得**把限流键记成"已留痕"：同类事件下次必须重试（R13 · Major-3）', async () => {
    resetAuditThrottle(() => Date.UTC(2026, 10, 8, 12));
    let failing = true;
    const append = vi.fn(async () => { if (failing) throw new Error('SQLITE_BUSY: audit.db locked'); return {}; });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await logUpdateEvent({ append }, 'update.verify-failed', {
      reason: 'STATE_TAMPERED', subreason: 'STATE_MAC_BROKEN', detail: 'd1',
    }, logger);
    expect(append).toHaveBeenCalledTimes(1);
    // 修之前：seen 在 append 之前就被填上 ⇒ 这条现场当天永久静默（实测两次同现场只试过一次、库里零条）。
    failing = false;
    await logUpdateEvent({ append }, 'update.verify-failed', {
      reason: 'STATE_TAMPERED', subreason: 'STATE_MAC_BROKEN', detail: 'd2',
    }, logger);
    expect(append, '写失败必须能重试').toHaveBeenCalledTimes(2);
    // 成功后再重复 ⇒ 限流照常生效（这条的性质是"已成功留痕"，不是"已经试过"）。
    await logUpdateEvent({ append }, 'update.verify-failed', {
      reason: 'STATE_TAMPERED', subreason: 'STATE_MAC_BROKEN', detail: 'd3',
    }, logger);
    expect(append).toHaveBeenCalledTimes(2);
    // 失败那一次必须至少镜像到日志，否则"重试"这件事本身也无从发现。
    const warned = (logger.warn as unknown as { mock: { calls: Array<[string]> } }).mock.calls;
    expect(warned.some((w) => /审计写入失败/.test(String(w[0]))), JSON.stringify(warned)).toBe(true);
  });
});
