import type { SessionEntry } from '../../../src/surface/contract.js';

export function placeholderOf(userText: string): string {
  return userText.trim().slice(0, 20) || '新对话';
}

function firstMessageText(entries: SessionEntry[], role: 'user' | 'assistant'): string | undefined {
  for (const entry of entries) {
    if (entry.kind !== 'message' || entry.role !== role || entry.streaming) continue;
    const text = entry.text.trim();
    if (text) return text;
  }
  return undefined;
}

export function firstUserText(entries: SessionEntry[]): string | undefined {
  return firstMessageText(entries, 'user');
}

export function firstAssistantText(entries: SessionEntry[]): string | undefined {
  return firstMessageText(entries, 'assistant');
}

export function shortTitlePrompt(userText: string, assistantText: string): string {
  return [
    '请根据下面的对话写一个不超过20字的会话标题。',
    '只输出标题，不要解释，不要引号。',
    `用户：${userText}`,
    `助手：${assistantText}`,
  ].join('\n');
}

export type TitleDecision =
  | { action: 'placeholder'; title: string }
  | { action: 'short'; prompt: string }
  | { action: 'none' };

export function decideTitle(input: {
  currentTitle?: string;
  firstUserText?: string;
  firstAssistantText?: string;
}): TitleDecision {
  const user = input.firstUserText?.trim();
  if (!user) return { action: 'none' };
  const current = input.currentTitle?.trim() ?? '';
  if (!current) return { action: 'placeholder', title: placeholderOf(user) };
  const assistant = input.firstAssistantText?.trim();
  if (assistant && current === placeholderOf(user)) {
    return { action: 'short', prompt: shortTitlePrompt(user, assistant) };
  }
  return { action: 'none' };
}
