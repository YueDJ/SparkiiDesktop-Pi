import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CHAT_DETAIL_LEVEL,
  isChatDetailLevel,
  chatDetailLevelLabel,
  shouldShowEntry,
} from '../src/workbench/chat-detail-level.js';

const message = {
  kind: 'message',
  id: 'm1',
  role: 'assistant',
  text: 'hi',
  streaming: false,
} as const;

const event = (event: string, over: Record<string, unknown> = {}) => ({
  kind: 'event',
  id: 'e1',
  event,
  label: event,
  ...over,
}) as any;

const tool = (over: Record<string, unknown> = {}) => ({
  kind: 'tool',
  id: 't1',
  toolName: 'bash',
  input: { command: 'ls' },
  ...over,
}) as any;

describe('chat detail level helpers', () => {
  it('recognizes valid levels and defaults to standard', () => {
    expect(isChatDetailLevel('minimal')).toBe(true);
    expect(isChatDetailLevel('standard')).toBe(true);
    expect(isChatDetailLevel('debug')).toBe(true);
    expect(isChatDetailLevel('verbose')).toBe(false);
    expect(DEFAULT_CHAT_DETAIL_LEVEL).toBe('standard');
  });

  it('returns human readable level labels', () => {
    expect(chatDetailLevelLabel('minimal')).toBe('简洁');
    expect(chatDetailLevelLabel('standard')).toBe('标准');
    expect(chatDetailLevelLabel('debug')).toBe('调试');
  });

  it('always shows messages', () => {
    expect(shouldShowEntry(message as any, 'minimal')).toBe(true);
    expect(shouldShowEntry(message as any, 'standard')).toBe(true);
    expect(shouldShowEntry(message as any, 'debug')).toBe(true);
  });

  it('shows runtime errors at every level and model changes only in debug', () => {
    expect(shouldShowEntry(event('runtime_error'), 'minimal')).toBe(true);
    expect(shouldShowEntry(event('model_change'), 'standard')).toBe(false);
    expect(shouldShowEntry(event('model_change'), 'debug')).toBe(true);
  });

  it('shows standard lifecycle events at standard level but hides debug-only events', () => {
    expect(shouldShowEntry(event('compaction'), 'standard')).toBe(true);
    expect(shouldShowEntry(event('agent_start'), 'standard')).toBe(false);
    expect(shouldShowEntry(event('turn_start'), 'standard')).toBe(false);
    expect(shouldShowEntry(event('agent_start'), 'debug')).toBe(true);
    expect(shouldShowEntry(event('turn_start'), 'debug')).toBe(true);
  });

  it('shows ordinary tools in standard/debug and only important tools in minimal', () => {
    expect(shouldShowEntry(tool(), 'minimal')).toBe(false);
    expect(shouldShowEntry(tool({ awaitingApproval: true }), 'minimal')).toBe(true);
    expect(shouldShowEntry(tool({ result: { exitCode: 1 } }), 'minimal')).toBe(true);
    expect(shouldShowEntry(tool({ result: { error: 'failed' } }), 'minimal')).toBe(true);
    expect(shouldShowEntry(tool(), 'standard')).toBe(true);
    expect(shouldShowEntry(tool(), 'debug')).toBe(true);
  });
});
