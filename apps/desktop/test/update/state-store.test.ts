// G3 · state-store 单测：HMAC 篡改 → tampered 且拒绝自动更新（不回退默认）；
// sequence 单调、nonce 绑定、缺失重建、原子写、损坏即拒绝。

import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { stateFilePath } from '../../electron/main/update/dirs.js';
import { TamperedStateWriteError, UpdateStateStore, type PersistedState } from '../../electron/main/update/state-store.js';

const SECRET = randomBytes(32);

function makeStore(dir: string): UpdateStateStore {
  return new UpdateStateStore({ dataDir: dir, secret: SECRET, now: () => 1_700_000_000_000 });
}
function readRaw(dir: string): { v: number; payload: PersistedState; mac: string } {
  return JSON.parse(readFileSync(stateFilePath(dir), 'utf8'));
}

describe('UpdateStateStore', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sparkii-state-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('文件缺失 → 全新默认状态、非 tampered、且可正常写入（可重建）', async () => {
    // 边界要说清：本条只测 **store 自身**的读盘语义（缺失不是「被篡改」，可以重建）。
    // 「缺失即无下限从而放行重放」**不是**安全策略——安全判定在 service + DPAPI 序号镜像那一层
    // （§6.3 第 4 条，I-31/I-35；现场证据见 test/update-state-mirror.test.ts）。
    const store = makeStore(dir);
    expect(existsSync(stateFilePath(dir))).toBe(false);
    expect(store.fileStatus()).toBe('absent');          // absent / ok / tampered 三态必须可区分
    const s = await store.read();
    expect(store.isTampered()).toBe(false);
    expect(s.lastSeenSequence).toBeNull();
    expect(s.installId).toBeTruthy();
    // 可正常写入并回读
    await store.recordSeen(3, 'nonce-3', '0.3.0');
    const store2 = makeStore(dir);
    expect(store2.isTampered()).toBe(false);
    expect(store2.lastSeenSequence()).toBe(3);
    expect(store2.nonceFor(3)).toBe('nonce-3');
  });

  it('写成功之后同一实例的 fileStatus 必须从 absent 变成 ok（R5 · Blocker-1：假阳性删档告警）', async () => {
    const store = makeStore(dir);
    expect(store.fileStatus()).toBe('absent');
    await store.recordSeen(3, 'nonce-3', '0.3.0');
    // 关键：不是「新实例」看到 ok，而是**同一个实例**写完就该知道文件已在
    expect(store.fileStatus()).toBe('ok');
    expect(store.isTampered()).toBe(false);
    expect(existsSync(stateFilePath(dir))).toBe(true);
    // 抬下限那条路同理（enforceFloorFromMirror 也走 persist）
    await store.enforceFloorFromMirror({ sequence: 9, nonce: 'nonce-9' });
    expect(store.fileStatus()).toBe('ok');
    expect(store.lastSeenSequence()).toBe(9);
  });

  it('平台 errno：updates 上级是普通文件 ⇒ 第三态，绝不折成 absent（R20 · Major / I-80）', () => {
    // Windows 上 readFileSync(<updates 是文件>/update-state.json) 报的是 ENOENT 而不是 ENOTDIR。
    // 只凭 code 判缺失会把它当成首装：镜像有序号时误报 STATE_TAMPERED，镜像为空时 I-31 删档防护失效。
    writeFileSync(dirname(stateFilePath(dir)), 'not-a-directory', 'utf8');
    const store = makeStore(dir);
    expect(store.fileStatus()).toBe('unreadable');
    expect(store.unreadableCode()).toBe('ENOTDIR');
    expect(store.isTampered()).toBe(false);
  });

  it('第三态故障物理消失后**同一实例**即恢复，不需重启（R20 · Major / R21 · Major-1 / I-80）', async () => {
    mkdirSync(stateFilePath(dir), { recursive: true });   // 位置占成目录 ⇒ EISDIR 第三态
    const store = makeStore(dir);
    expect(store.fileStatus()).toBe('unreadable');
    expect(store.unreadableCode()).toBe('EISDIR');
    // 物理修复：移走占位目录，用另一个实例写出 MAC 合法的状态文件（模拟运维 / 杀软释放路径）
    rmSync(stateFilePath(dir), { recursive: true, force: true });
    const writer = makeStore(dir);
    await writer.recordSeen(4, 'nonce-4', '0.3.0');
    // 关键：不是「新实例 = 新进程」，而是同一个 store 实例；原先 loaded 门会让这里永远停在 unreadable。
    expect(store.fileStatus()).toBe('ok');
    expect(store.unreadableCode()).toBeNull();
    expect(store.lastSeenSequence()).toBe(4);
    await store.markSuccess(1234);
    expect((await store.read()).lastSuccessAt).toBe(1234);
  });

  it('原子写：文件为 {v:1,payload,mac}，且不留 .tmp 残留', async () => {
    const store = makeStore(dir);
    await store.markCheck(1000);
    const raw = readRaw(dir);
    expect(raw.v).toBe(1);
    expect(raw.payload.lastCheckedAt).toBe(1000);
    expect(typeof raw.mac).toBe('string');
    const leftovers = readdirSync(join(dir, 'updates')).filter((n) => n.includes('.tmp-'));
    expect(leftovers).toHaveLength(0);
  });

  it('MAC 覆盖规范化 payload：手工重算一致', async () => {
    const store = makeStore(dir);
    await store.recordSeen(5, 'n5', '0.5.0');
    const raw = readRaw(dir);
    const canonical = JSON.stringify({
      lastSeenSequence: 5,
      sequenceNonce: { '5': 'n5' },
      minInstalledVersion: '0.5.0',
      skippedVersions: [],
      lastCheckedAt: null,
      lastSuccessAt: null,
      deferredUntil: null,
      failureCount: 0,
      installId: raw.payload.installId,
    });
    const mac = createHmac('sha256', SECRET).update(canonical, 'utf8').digest('base64');
    expect(raw.mac).toBe(mac);
  });

  it('HMAC 篡改（改 payload 不动 mac）→ isTampered() 为 true，损坏即拒绝、不回退默认', async () => {
    const good = makeStore(dir);
    await good.recordSeen(9, 'n9', '0.9.0');
    const raw = readRaw(dir);
    raw.payload.lastSeenSequence = 0; // 篡改但不重算 mac
    writeFileSync(stateFilePath(dir), JSON.stringify(raw));

    const store = makeStore(dir);
    expect(store.isTampered()).toBe(true);
    const s = await store.read();
    // 毒化状态：lastSeenSequence 被顶到最大，绝不回退成可信默认（null）。
    expect(s.lastSeenSequence).toBe(Number.MAX_SAFE_INTEGER);
    // 损坏后自动更新相关写入一律**抛错式**拒绝（I-63：原先是静默 return，
    // 于是门面拿到"正常返回"、对用户报成功而盘上没动 ⇒ 现在漏检也骗不过去），且不覆盖现场。
    await expect(store.recordSeen(10, 'n10', '1.0.0')).rejects.toBeInstanceOf(TamperedStateWriteError);
    await expect(store.write({ ...s, lastSeenSequence: 1 })).rejects.toBeInstanceOf(TamperedStateWriteError);
    const rawAfter = readRaw(dir);
    expect(rawAfter.payload.lastSeenSequence).toBe(0); // 现场未被覆盖
    expect(makeStore(dir).isTampered()).toBe(true);
  });

  it('mac 字符串被改 → tampered', async () => {
    const good = makeStore(dir);
    await good.markCheck(1);
    const raw = readRaw(dir);
    raw.mac = 'AAAA' + raw.mac.slice(4);
    writeFileSync(stateFilePath(dir), JSON.stringify(raw));
    expect(makeStore(dir).isTampered()).toBe(true);
  });

  it('v 不符 → tampered', async () => {
    const good = makeStore(dir);
    await good.markCheck(1);
    const raw = readRaw(dir) as unknown as { v: number };
    raw.v = 2;
    writeFileSync(stateFilePath(dir), JSON.stringify(raw));
    expect(makeStore(dir).isTampered()).toBe(true);
  });

  it('解析失败 → tampered', () => {
    mkdirSync(join(dir, 'updates'), { recursive: true });
    writeFileSync(stateFilePath(dir), '{not json');
    expect(makeStore(dir).isTampered()).toBe(true);
  });

  it('sequence 单调：recordSeen 不允许回退', async () => {
    const store = makeStore(dir);
    await store.recordSeen(7, 'n7', '0.7.0');
    await store.recordSeen(5, 'n5', '0.5.0'); // 回退，应被忽略
    expect(store.lastSeenSequence()).toBe(7);
    expect(store.nonceFor(5)).toBeNull();
    // 新 sequence 正常推进
    await store.recordSeen(8, 'n8', '0.8.0');
    expect(store.lastSeenSequence()).toBe(8);
  });

  it('nonce 绑定：同 sequence 换新 nonce 可被检出', async () => {
    const store = makeStore(dir);
    await store.recordSeen(4, 'bound-nonce', '0.4.0');
    expect(store.nonceFor(4)).toBe('bound-nonce');
    expect(store.nonceFor(4)).not.toBe('attacker-nonce');
    expect(store.nonceFor(999)).toBeNull();
  });

  it('skip / defer / markSuccess 正确落盘并可回读', async () => {
    const store = makeStore(dir);
    await store.skip('0.3.0');
    await store.markSuccess(1234); // 成功检查会清掉稍后窗口
    await store.defer(9999);
    const s = await store.read();
    expect(s.skippedVersions).toContain('0.3.0');
    expect(s.deferredUntil).toBe(9999);
    expect(s.lastSuccessAt).toBe(1234);
    expect(s.failureCount).toBe(0);
  });
});
