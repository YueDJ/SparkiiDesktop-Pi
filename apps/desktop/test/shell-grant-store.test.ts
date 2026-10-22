import { describe, expect, it } from 'vitest';
import { ShellGrantStore } from '../electron/main/security/shell-grant-store.js';

describe('ShellGrantStore', () => {
  it('stores only the current task id and revokes it', () => {
    let now = 100;
    const store = new ShellGrantStore(() => now);
    store.grant('t1', 200);
    expect(store.allows('t1')).toBe(true);
    expect(store.allows('t2')).toBe(false);
    store.revoke('t1');
    expect(store.allows('t1')).toBe(false);
    store.grant('t1', 200);
    now = 200;
    expect(store.allows('t1')).toBe(false);
  });

  it('treats a grant at or past expiry as revoked and forgets it', () => {
    const store = new ShellGrantStore(() => 500);
    store.grant('t1', 500);
    expect(store.allows('t1')).toBe(false);
    store.grant('t2', 501);
    expect(store.allows('t2')).toBe(true);
    store.clear();
    expect(store.allows('t2')).toBe(false);
  });

  it('never grants across a re-grant boundary', () => {
    let now = 100;
    const store = new ShellGrantStore(() => now);
    store.grant('t1', 1_000);
    now = 900;
    store.grant('t1', 950);
    expect(store.allows('t1')).toBe(true);
    now = 960;
    expect(store.allows('t1')).toBe(false);
  });
});
