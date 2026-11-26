import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { AuditStore } from '../src/audit.js';

const stores: AuditStore[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));

describe('AuditStore', () => {
  it('appends and queries an audit event', async () => {
    const s = new AuditStore(join(mkdtempSync(join(tmpdir(), 'audit-')), 'a.db'));
    stores.push(s);
    const ev = await s.append({ actor: 'u1', action: 'proposal.created', resource: 'report.export', payloadSummary: 'x' });
    expect(ev.id).toBeTruthy();
    expect(await s.query({ actor: 'u1' })).toHaveLength(1);
  });
  it('exports jsonl', async () => {
    const s = new AuditStore(join(mkdtempSync(join(tmpdir(), 'audit-')), 'a.db'));
    stores.push(s);
    await s.append({ actor: 'u1', action: 'proposal.denied', decision: 'denied' });
    const line = (await s.exportJsonl()).trim().split('\n')[0];
    expect(JSON.parse(line).action).toBe('proposal.denied');
  });
  it("persists and queries sessionId", async () => {
    const store = new AuditStore(join(mkdtempSync(join(tmpdir(), "audit-")), "a.db"));
    stores.push(store);
    await store.append({ actor: "admin", action: "proposal.created", resource: "report.export", sessionId: "s-1" });
    const rows = await store.query({ sessionId: "s-1" });
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("s-1");
  });
  it("stores task, capability, rule, payload hash and sandbox evidence", async () => {
    const store = new AuditStore(join(mkdtempSync(join(tmpdir(), "audit-")), "a.db"));
    stores.push(store);
    await store.append({
      actor: "agent",
      action: "action.executed",
      resource: "write",
      sessionId: "s-1",
      taskId: "task-1",
      actionId: "action-1",
      ruleId: "workspace.write",
      capability: "fs.write",
      payloadHash: "sha256:abc",
      platform: "windows",
      sandboxVersion: "appcontainer-v1",
    });
    const rows = await store.query({ sessionId: "s-1" });
    expect(rows[0]).toMatchObject({
      taskId: "task-1",
      actionId: "action-1",
      ruleId: "workspace.write",
      capability: "fs.write",
      payloadHash: "sha256:abc",
      platform: "windows",
      sandboxVersion: "appcontainer-v1",
    });
  });
  it('R8-P1-6 applies registered redactions before every free-text audit insert and after reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-r8-fence-'));
    const path = join(dir, 'a.db');
    const secret = 'R8_AUDIT_SECRET_71C';
    const escaped = 'R8_AUDIT_"\\\n_SECRET_92D';
    let store = new AuditStore(path);
    stores.push(store);
    await store.append({ actor: 'agent', action: 'old.audit', resource: 'memory', payloadSummary: `${secret} ${escaped}` });
    store.redactTexts([secret, escaped]);
    const appended = await store.append({
      actor: `actor-${secret}`, action: `action-${escaped}`, resource: 'memory',
      payloadSummary: `${secret} ${escaped}`, decision: 'denied', modelRoute: secret,
      sessionId: escaped, taskId: secret, actionId: escaped, ruleId: secret,
      capability: escaped, payloadHash: secret, platform: escaped, sandboxVersion: secret,
    });
    expect(JSON.stringify(appended)).not.toContain(secret);
    expect(JSON.stringify(appended)).not.toContain(escaped);
    expect(JSON.stringify(await store.query({ actor: `actor-${secret}` }))).not.toContain(secret);
    expect(await store.exportJsonl()).not.toContain(escaped);
    store.close();
    stores.splice(stores.indexOf(store), 1);

    store = new AuditStore(path);
    stores.push(store);
    await store.append({ actor: 'agent', action: 'after.restart', resource: 'memory', payloadSummary: `${secret} ${escaped}` });
    expect(JSON.stringify(await store.query({}))).not.toContain(secret);
    expect(await store.exportJsonl()).not.toContain(escaped);
    const bytes = [path, `${path}-wal`, `${path}-shm`].filter(existsSync).map((file) => readFileSync(file).toString('utf8')).join('\n');
    expect(bytes).not.toContain(secret);
    expect(bytes).not.toContain(escaped);
    expect(bytes).not.toContain(JSON.stringify(escaped).slice(1, -1));
  });

  it('R8 final review keeps a durable audit privacy fence when history cleanup rolls back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-r8-rollback-'));
    const path = join(dir, 'a.db');
    const secret = 'R8_AUDIT_ROLLBACK_SECRET_71C';
    const store = new AuditStore(path);
    stores.push(store);
    await store.append({ actor: 'agent', action: 'old.audit', payloadSummary: secret });
    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db;
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (sql.startsWith('UPDATE audit SET')) {
        return { run: () => { throw new Error('injected audit cleanup failure'); } };
      }
      return statement;
    }) as typeof db.prepare;
    expect(() => store.redactTexts([secret])).toThrow('injected audit cleanup failure');
    expect(JSON.stringify(await store.query({}))).not.toContain(secret);
    expect(await store.exportJsonl()).not.toContain(secret);
    const future = await store.append({ actor: 'agent', action: 'future', payloadSummary: secret });
    expect(JSON.stringify(future)).not.toContain(secret);
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = new AuditStore(path);
    stores.push(reopened);
    expect(JSON.stringify(await reopened.query({}))).not.toContain(secret);
    expect(await reopened.exportJsonl()).not.toContain(secret);
    expect(existsSync(`${path}.privacy-redactions.json`)).toBe(true);
  });

  it('R8 round3 registers physical-newline fragments for history, future append and restart without raw DB/WAL residue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-r8-round3-lines-'));
    const path = join(dir, 'a.db');
    const alpha = 'R8_AUDIT_FRAGMENT_ALPHA_71C';
    const beta = 'R8_AUDIT_FRAGMENT_"\\BETA_92D';
    const gamma = 'R8_AUDIT_FRAGMENT_GAMMA_33E';
    const secret = `${alpha}\r\n${beta}\r${gamma}\n`;
    const fragments = [alpha, beta, gamma];
    const forbidden = [secret, JSON.stringify(secret).slice(1, -1), ...fragments.flatMap((fragment) => [
      fragment, JSON.stringify(fragment).slice(1, -1),
    ])];
    const rawBytes = (): string => [path, `${path}-wal`, `${path}-journal`]
      .filter(existsSync).map((file) => readFileSync(file).toString('utf8')).join('\n');
    const expectScrubbed = (output: string): void => {
      for (const value of forbidden) expect(output).not.toContain(value);
    };

    let store = new AuditStore(path);
    stores.push(store);
    await store.append({ actor: 'agent', action: 'old.lines', payloadSummary: `history ${fragments.join(' ')}` });
    await store.append({ actor: 'agent', action: 'old.escaped-lines', payloadSummary: `escaped ${fragments.map((fragment) => JSON.stringify(fragment).slice(1, -1)).join(' ')}` });
    await store.append({ actor: 'agent', action: 'old.full-line', payloadSummary: `full ${secret}` });
    expect(rawBytes()).toContain(alpha);
    expect(store.redactTexts([secret])).toBeGreaterThan(0);

    const future = await store.append({
      actor: `actor-${alpha}`, action: `action-${beta}`, resource: gamma,
      payloadSummary: `future ${fragments.join(' ')} ${JSON.stringify(beta).slice(1, -1)}`,
    });
    expectScrubbed(JSON.stringify(future) + JSON.stringify(await store.query({})) + await store.exportJsonl());
    expect(existsSync(`${path}-wal`)).toBe(true);
    expectScrubbed(rawBytes());
    store.close();
    stores.splice(stores.indexOf(store), 1);

    store = new AuditStore(path);
    stores.push(store);
    const restarted = await store.append({
      actor: `restart-${gamma}`, action: 'after.restart', payloadSummary: `${alpha} ${JSON.stringify(beta).slice(1, -1)}`,
    });
    expectScrubbed(JSON.stringify(restarted) + JSON.stringify(await store.query({})) + await store.exportJsonl());
    expect(existsSync(`${path}-wal`)).toBe(true);
    expectScrubbed(rawBytes());
  });

  it.each(['已删除', '[已删除]'])('rotates markers and scrubs old and future rows for %s after restart', async (secret) => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-marker-'));
    const path = join(dir, 'a.db');
    let store = new AuditStore(path);
    stores.push(store);
    await store.append({ actor: `old-${secret}`, action: 'old.audit', resource: secret, payloadSummary: `old ${secret}` });
    store.close();
    stores.splice(stores.indexOf(store), 1);
    store = new AuditStore(path);
    stores.push(store);
    store.redactTexts([secret]);
    const firstMarker = store.marker();
    expect(firstMarker).not.toContain(secret);
    expect(store.redactText(`old ${secret}`)).not.toContain(secret);
    expect(JSON.stringify(await store.query({}))).not.toContain(secret);
    expect(await store.exportJsonl()).not.toContain(secret);

    await store.append({ actor: `future-${secret}`, action: 'future.audit', resource: secret, payloadSummary: `future ${secret}` });
    expect(store.redactTexts([firstMarker])).toBeGreaterThan(0);
    const secondMarker = store.marker();
    expect(secondMarker).not.toBe(firstMarker);
    expect(JSON.stringify(await store.query({}))).not.toContain(secret);
    expect(JSON.stringify(await store.query({}))).not.toContain(firstMarker);
    expect(await store.exportJsonl()).not.toContain(firstMarker);
    store.close();
    stores.splice(stores.indexOf(store), 1);

    store = new AuditStore(path);
    stores.push(store);
    await store.append({ actor: `restart-${secret}`, action: 'restart.audit', resource: secret, payloadSummary: `restart ${secret} ${firstMarker}` });
    const output = JSON.stringify(await store.query({})) + await store.exportJsonl();
    expect(output).not.toContain(secret);
    expect(output).not.toContain(firstMarker);
    const bytes = [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]
      .filter(existsSync).map((file) => readFileSync(file).toString('utf8')).join('\n');
    expect(bytes).not.toContain(secret);
    expect(bytes).not.toContain(firstMarker);
  });

  it('scrubs nested string keys and values and collapses key collisions safely', () => {
    const store = new AuditStore(join(mkdtempSync(join(tmpdir(), 'audit-value-')), 'a.db'));
    stores.push(store);
    const secret = 'R8_AUDIT_NESTED_SECRET_71C';
    store.redactTexts([secret]);
    const safe = store.redactValue({ nested: [{ [`key-${secret}`]: `value-${secret}` }] });
    expect(safe.redacted).toBe(true);
    expect(JSON.stringify(safe.value)).not.toContain(secret);
    expect(store.containsValue(safe.value)).toBe(false);
    const collision = store.redactValue({ [secret]: 1, [store.marker()]: 2 });
    expect(collision.redacted).toBe(true);
    expect(collision.value).toBe(store.marker());
    expect(store.containsValue(collision.value)).toBe(false);
  });

  it("exports jsonl with camelCase fields", async () => {
    const s = new AuditStore(join(mkdtempSync(join(tmpdir(), "audit-")), "a.db"));
    stores.push(s);
    await s.append({ actor: "u1", action: "proposal.created", resource: "report.export", payloadSummary: "x", sessionId: "s-1" });
    const line = (await s.exportJsonl()).trim().split("\n")[0];
    const parsed = JSON.parse(line);
    expect(parsed.sessionId).toBe("s-1");
    expect(parsed.session_id).toBeUndefined();
    expect(parsed.payloadSummary).toBe("x");
    expect(parsed.payload_summary).toBeUndefined();
  });
});
