import { describe, expect, it } from 'vitest';
import type { SessionEntry } from '../src/surface/contract.js';
import {
  decideTitle,
  firstAssistantText,
  firstUserText,
  placeholderOf,
  shortTitlePrompt,
} from '../agents/general/surface/title.js';

const user = (text: string, over: Partial<Extract<SessionEntry, { kind: 'message' }>> = {}): SessionEntry => ({
  kind: 'message',
  id: `u-${text}`,
  role: 'user',
  text,
  streaming: false,
  ...over,
});

const assistant = (text: string, over: Partial<Extract<SessionEntry, { kind: 'message' }>> = {}): SessionEntry => ({
  kind: 'message',
  id: `a-${text}`,
  role: 'assistant',
  text,
  streaming: false,
  ...over,
});

describe('placeholderOf', () => {
  it('trims and keeps at most 20 characters', () => {
    expect(placeholderOf('帮我看看这份合同的违约责任条款怎么改')).toBe('帮我看看这份合同的违约责任条款怎么改'.slice(0, 20));
    expect(placeholderOf('  你好  ')).toBe('你好');
  });

  it('falls back to 新对话 when the user text is empty', () => {
    expect(placeholderOf('')).toBe('新对话');
    expect(placeholderOf('   ')).toBe('新对话');
  });
});

describe('first message extractors', () => {
  it('uses the first visible user and assistant text and ignores tools and thinking-only replies', () => {
    const entries: SessionEntry[] = [
      { kind: 'tool', id: 't1', toolName: 'bash', input: { command: 'ls' } },
      user('  帮我改违约责任  '),
      user('第二条用户消息'),
      assistant('', { thinking: '先看看条款', id: 'think' }),
      assistant('建议把赔偿上限写清楚'),
    ];
    expect(firstUserText(entries)).toBe('帮我改违约责任');
    expect(firstAssistantText(entries)).toBe('建议把赔偿上限写清楚');
  });

  it('ignores still-streaming assistant text', () => {
    expect(firstAssistantText([assistant('半句', { streaming: true })])).toBeUndefined();
  });
});

describe('decideTitle', () => {
  const longUser = '帮我看看这份合同的违约责任条款怎么改';

  it('publishes a placeholder when there is a user message and no title', () => {
    expect(decideTitle({ firstUserText: longUser })).toEqual({
      action: 'placeholder',
      title: longUser.slice(0, 20),
    });
  });

  it('does not publish a placeholder when a title already exists', () => {
    expect(decideTitle({ currentTitle: '已有名字', firstUserText: longUser })).toEqual({ action: 'none' });
  });

  it('asks for a short name only while the current title is the recomputed placeholder', () => {
    const decision = decideTitle({
      currentTitle: placeholderOf(longUser),
      firstUserText: longUser,
      firstAssistantText: '可以把违约金上限约定为合同金额的百分之二十',
    });
    expect(decision.action).toBe('short');
    if (decision.action !== 'short') return;
    expect(decision.prompt).toContain(longUser);
    expect(decision.prompt).toContain('可以把违约金上限约定为合同金额的百分之二十');
    expect(decision.prompt).toMatch(/20/);
    expect(decision.prompt).toContain('只输出标题');
  });

  it('does nothing when the title is already a short name or a user rename', () => {
    expect(decideTitle({
      currentTitle: '违约责任条款修改',
      firstUserText: longUser,
      firstAssistantText: '助手回复',
    })).toEqual({ action: 'none' });
    expect(decideTitle({
      currentTitle: '用户改的',
      firstUserText: longUser,
      firstAssistantText: '助手回复',
    })).toEqual({ action: 'none' });
  });

  it('does nothing when opening history that already has another title', () => {
    expect(decideTitle({
      currentTitle: '去年的合同讨论',
      firstUserText: '历史用户句',
      firstAssistantText: '历史助手句',
    })).toEqual({ action: 'none' });
  });

  it('does nothing before the first user message', () => {
    expect(decideTitle({ firstAssistantText: '先说' })).toEqual({ action: 'none' });
  });
});

describe('shortTitlePrompt', () => {
  it('includes both sides of the first turn and the 20-character limit', () => {
    const prompt = shortTitlePrompt('用户句', '助手句');
    expect(prompt).toContain('用户句');
    expect(prompt).toContain('助手句');
    expect(prompt).toMatch(/20/);
    expect(prompt).toContain('只输出标题');
  });
});
