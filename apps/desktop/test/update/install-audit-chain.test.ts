// G7b · 客户端审计哈希链单测（设计 §7.9 B 关项 / 契约 §9 映射「客户端审计哈希链」）。
//
// 与 §8.3 的**服务端发布透明日志**无关（那是 P2、另一个组件）：
// 这里只做本地 `update-audit-chain.jsonl` 的 prevHash + eventHash 追加链，
// 目的是「同用户进程想抹痕迹必须同时改这份纯追加文件」，篡改/插队/断链必须可检出。
//
// 全部落 mkdtempSync 临时目录；绝不碰真实 %LOCALAPPDATA%\SparkiiDesktop\data。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AUDIT_CHAIN_FILENAME, AUDIT_CHAIN_MAX_BYTES, AUDIT_GENESIS_HASH, appendClientAuditChain,
  auditChainPath, readAuditChain, stableStringify, verifyAuditChain,
} from '../../electron/main/update/installer.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sparkii-audit-chain-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

function chainFile(): string {
  return join(dir, 'updates', AUDIT_CHAIN_FILENAME);
}

/** 直接伪造链文件前需要 updates/ 存在（真实写入方 appendClientAuditChain 会自建目录）。 */
function ensureUpdates(): string {
  mkdirSync(join(dir, 'updates'), { recursive: true });
  return chainFile();
}

function lines(): string[] {
  return readFileSync(chainFile(), 'utf8').split('\n').filter((l) => l.trim() !== '');
}

describe('genesis', () => {
  it('genesis 是固定 64 位 hex 常量，且与 dataDir 无关（跨机可比）', () => {
    expect(AUDIT_GENESIS_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(AUDIT_GENESIS_HASH).toBe(sha('sparkii:update-audit-chain:v1:genesis'));
  });

  it('首条记录的 prevHash 必须等于 genesis', async () => {
    const hash = await appendClientAuditChain(dir, { action: 'update.install-start', txnId: 't1' });
    const record = (await readAuditChain(dir))[0]!;
    expect(record.prevHash).toBe(AUDIT_GENESIS_HASH);
    expect(record.seq).toBe(1);
    expect(record.hash).toBe(hash);
  });
});

describe('追加与顺序', () => {
  it('连续追加 3 条：seq 递增、prevHash 串起上一条 hash、文件恰 3 行', async () => {
    const h1 = await appendClientAuditChain(dir, { action: 'update.install-start', txnId: 'a' });
    const h2 = await appendClientAuditChain(dir, { action: 'update.failed', stage: 'snapshot' });
    const h3 = await appendClientAuditChain(dir, { action: 'update.cleanup', scope: 'prune' });
    const records = await readAuditChain(dir);
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(records[0]!.prevHash).toBe(AUDIT_GENESIS_HASH);
    expect(records[1]!.prevHash).toBe(h1);
    expect(records[2]!.prevHash).toBe(h2);
    expect([h1, h2, h3]).toEqual(records.map((r) => r.hash));
    expect(lines().length).toBe(3);
    expect((await verifyAuditChain(dir)).ok).toBe(true);
  });

  it('每条 hash = sha256(prevHash + eventHash)，eventHash = sha256(归一化事件)（契约 §6 占位口径）', async () => {
    const event = { action: 'update.install-start', txnId: 't', installDir: 'D:\\x' };
    const hash = await appendClientAuditChain(dir, event);
    const record = (await readAuditChain(dir))[0]!;
    expect(record.eventHash).toBe(sha(stableStringify(event)));
    expect(record.hash).toBe(sha(record.prevHash + record.eventHash));
    expect(hash).toBe(record.hash);
  });

  it('键序不同但内容相同的事件 ⇒ 同一 eventHash（哈希与序列化顺序无关）', () => {
    expect(sha(stableStringify({ a: 1, b: 2, nested: { x: 1, y: 2 } })))
      .toBe(sha(stableStringify({ b: 2, nested: { y: 2, x: 1 }, a: 1 })));
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it('stableStringify 覆盖数组顺序敏感、undefined 字段被剔除、null 保留', () => {
    expect(stableStringify([1, { b: 1, a: 2 }])).toBe('[1,{"a":2,"b":1}]');
    expect(stableStringify({ a: undefined, b: null })).toBe('{"b":null}');
    expect(stableStringify('x')).toBe('"x"');
    expect(stableStringify(3)).toBe('3');
  });

  it('同一事件重复追加得到不同 hash（链式：位置即内容）', async () => {
    const e = { action: 'update.cleanup' };
    const h1 = await appendClientAuditChain(dir, e);
    const h2 = await appendClientAuditChain(dir, e);
    expect(h1).not.toBe(h2);
    expect((await verifyAuditChain(dir)).count).toBe(2);
  });

  it('链文件缺失 ⇒ ok 且 count 0（不误报断链）', async () => {
    const verdict = await verifyAuditChain(dir);
    expect(verdict).toMatchObject({ ok: true, count: 0, head: null });
    expect(existsSync(chainFile())).toBe(false);
  });

  it('链只写在 <dataDir>/updates/ 之下', async () => {
    await appendClientAuditChain(dir, { action: 'x' });
    expect(auditChainPath(dir)).toBe(chainFile());
    expect(existsSync(chainFile())).toBe(true);
    expect(existsSync(join(dir, AUDIT_CHAIN_FILENAME))).toBe(false);
  });
});

describe('断链必须可检出', () => {
  it('就地篡改某条事件内容 ⇒ EVENT_HASH_MISMATCH 并指出位置', async () => {
    await appendClientAuditChain(dir, { action: 'update.install-start', txnId: 'a' });
    await appendClientAuditChain(dir, { action: 'update.completed', version: '0.2.0' });
    await appendClientAuditChain(dir, { action: 'update.cleanup', scope: 'prune' });
    const raw = lines();
    const second = JSON.parse(raw[1]!) as Record<string, unknown>;
    second.event = { action: 'update.completed', version: '0.1.0' };   // 把「新版」改回「旧版」
    raw[1] = JSON.stringify(second);
    writeFileSync(chainFile(), `${raw.join('\n')}\n`, 'utf8');

    const verdict = await verifyAuditChain(dir);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('EVENT_HASH_MISMATCH');
    expect(verdict.brokenAtSeq).toBe(2);
  });

  it('就地篡改 hash ⇒ HASH_MISMATCH', async () => {
    await appendClientAuditChain(dir, { action: 'update.install-start' });
    const raw = lines();
    const rec = JSON.parse(raw[0]!) as Record<string, unknown>;
    rec.hash = sha('tampered');
    raw[0] = JSON.stringify(rec);
    writeFileSync(chainFile(), `${raw.join('\n')}\n`, 'utf8');
    const verdict = await verifyAuditChain(dir);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('HASH_MISMATCH');
    expect(verdict.brokenAtSeq).toBe(1);
  });

  it('删除中间一条 ⇒ SEQ_GAP（后继记录的 seq 对不上位置）', async () => {
    await appendClientAuditChain(dir, { action: 'a' });
    await appendClientAuditChain(dir, { action: 'b' });
    await appendClientAuditChain(dir, { action: 'c' });
    const raw = lines();
    raw.splice(1, 1);
    writeFileSync(chainFile(), `${raw.join('\n')}\n`, 'utf8');
    const verdict = await verifyAuditChain(dir);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('SEQ_GAP');
    expect(verdict.brokenAtSeq).toBe(2);
  });

  it('整段替换（伪造一条自洽的新链）⇒ 首条 prevHash 与 genesis 不符', async () => {
    const fakeEvent = { action: 'update.completed' };
    const eventHash = sha(stableStringify(fakeEvent));
    const forged = {
      seq: 1, ts: 1, prevHash: sha('not-genesis'), eventHash,
      hash: sha(sha('not-genesis') + eventHash), event: fakeEvent,
    };
    writeFileSync(ensureUpdates(), `${JSON.stringify(forged)}\n`, 'utf8');
    const verdict = await verifyAuditChain(dir);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('PREV_HASH_MISMATCH');
    expect(verdict.brokenAtSeq).toBe(1);
    expect(verdict.message).toContain('genesis');
  });

  it('插入一条自算的“合法”记录到中间 ⇒ PREV_HASH_MISMATCH（前向指针断裂）', async () => {
    const h1 = await appendClientAuditChain(dir, { action: 'a' });
    await appendClientAuditChain(dir, { action: 'c' });
    const raw = lines();
    const insertedEvent = { action: 'inserted' };
    const eventHash = sha(stableStringify(insertedEvent));
    const inserted = {
      seq: 2, ts: 0, prevHash: h1, eventHash, hash: sha(h1 + eventHash), event: insertedEvent,
    };
    raw.splice(1, 0, JSON.stringify(inserted));
    // 第三条仍是原来的 seq=2 ⇒ 位置与 seq 冲突，同时它的 prevHash 也不再等于插入项 hash
    writeFileSync(chainFile(), `${raw.join('\n')}\n`, 'utf8');
    const verdict = await verifyAuditChain(dir);
    expect(verdict.ok).toBe(false);
    expect(['SEQ_GAP', 'PREV_HASH_MISMATCH']).toContain(verdict.reason);
  });

  it('追加一行未写完的半行（截断）⇒ LINE_UNPARSEABLE', async () => {
    await appendClientAuditChain(dir, { action: 'a' });
    writeFileSync(chainFile(), `${lines().join('\n')}\n{"seq":2,"prevHa`, 'utf8');
    const verdict = await verifyAuditChain(dir);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('LINE_UNPARSEABLE');
  });

  it('空文件 ⇒ ok:true count:0（不算断链）', async () => {
    writeFileSync(ensureUpdates(), '', 'utf8');
    expect(await verifyAuditChain(dir)).toMatchObject({ ok: true, count: 0 });
  });

  it('链触顶 ⇒ 拒写但不截断（既不丢既有记录，也不制造无界写入）', async () => {
    await appendClientAuditChain(dir, { action: 'update.install-start' });
    const before = readFileSync(chainFile(), 'utf8');
    expect(before).toContain('update.install-start');
    const head = await verifyAuditChain(dir);
    expect(head.ok).toBe(true);
    writeFileSync(chainFile(), 'x'.repeat(AUDIT_CHAIN_MAX_BYTES), 'utf8');
    await expect(appendClientAuditChain(dir, { action: 'update.cleanup' })).rejects.toThrow(/reached/);
    // 触顶后文件一字不改（既不追加也不截断）
    expect(readFileSync(chainFile(), 'utf8')).toBe('x'.repeat(AUDIT_CHAIN_MAX_BYTES));
    // 内容不可解析时校验器必须报出来，而不是静默 ok
    expect((await verifyAuditChain(dir)).ok).toBe(false);
  });

  it('已知的能力边界：抹掉尾部若干条后本地无法自证（需 §8.3 服务端锚点，P2）', async () => {
    await appendClientAuditChain(dir, { action: 'a' });
    await appendClientAuditChain(dir, { action: 'b' });
    const head = (await verifyAuditChain(dir)).head;
    const raw = lines();
    raw.pop();
    writeFileSync(chainFile(), `${raw.join('\n')}\n`, 'utf8');
    const verdict = await verifyAuditChain(dir);
    // 内容仍然自洽 ⇒ 本地判 ok；但 head 变了，把 head 交给服务端即可暴露截断。
    expect(verdict.ok).toBe(true);
    expect(verdict.head).not.toBe(head);
  });
});

describe('非法 dataDir（不得往 cwd 写）', () => {
  it('相对 dataDir ⇒ append 抛错、verify 明确拒绝', async () => {
    await expect(appendClientAuditChain('relative-dir', { action: 'x' })).rejects.toThrow(/绝对路径/);
    expect(await verifyAuditChain('relative-dir')).toMatchObject({ ok: false, reason: 'DATA_DIR_INVALID' });
    expect(existsSync(join(process.cwd(), 'updates', AUDIT_CHAIN_FILENAME))).toBe(false);
  });
});
