import { describe, it, expect } from 'vitest';
import {
  openPage, openHistory, openNew, bindSession, clearCurrentSession,
  highlightedSessionId, shellActive, rowIsActive, withDerivedActive, isSession,
} from '../src/platform/current-work.js';

describe('CurrentWork', () => {
  it('opens workflow history as history mode and chat as live', () => {
    expect(openHistory('contract-review', 'c1', 'workflow')).toEqual({
      type: 'session', agentId: 'contract-review', sessionId: 'c1', mode: 'history',
    });
    expect(openHistory('general', 'g1', 'chat')).toEqual({
      type: 'session', agentId: 'general', sessionId: 'g1', mode: 'live',
    });
  });

  it('new work has no session id', () => {
    expect(openNew('general')).toEqual({
      type: 'session', agentId: 'general', sessionId: null, mode: 'live',
    });
  });

  it('highlights only a persisted session view, never a shell page', () => {
    const cur = openHistory('contract-review', 'c1', 'workflow');
    expect(highlightedSessionId(cur)).toBe('c1');
    expect(shellActive(cur)).toBe('contract-review');
    expect(highlightedSessionId(openNew('contract-review'))).toBeNull();
    expect(highlightedSessionId(openPage('home'))).toBeNull();
    expect(highlightedSessionId(openPage('settings'))).toBeNull();
    expect(highlightedSessionId(openPage('knowledge'))).toBeNull();
    expect(shellActive(openPage('knowledge'))).toBe('knowledge');
    expect(rowIsActive('c1', 'c1')).toBe(true);
    expect(rowIsActive('c1', 'g1')).toBe(false);
    expect(rowIsActive(null, 'c1')).toBe(false);
  });

  it('bindSession then clearCurrentSession', () => {
    const draft = openNew('general');
    const bound = bindSession(draft, 'g1');
    expect(bound).toEqual({ type: 'session', agentId: 'general', sessionId: 'g1', mode: 'live' });
    expect(clearCurrentSession(bound)).toEqual(openNew('general'));
    expect(bindSession(openPage('home'), 'g1')).toEqual(openPage('home'));
    expect(clearCurrentSession(openPage('settings'))).toEqual(openPage('settings'));
    expect(isSession(bound)).toBe(true);
    expect(isSession(openPage('home'))).toBe(false);
  });

  it('derives at most one active row across groups', () => {
    const view = withDerivedActive({
      'contract-review': [{ id: 'c1' }, { id: 'c2' }],
      general: [{ id: 'g1' }],
    }, 'c1');
    expect(view['contract-review'].map((s) => s.active)).toEqual([true, false]);
    expect(view.general.map((s) => s.active)).toEqual([false]);
    expect(withDerivedActive({ general: [{ id: 'g1' }] }, null).general[0].active).toBe(false);
  });
});
