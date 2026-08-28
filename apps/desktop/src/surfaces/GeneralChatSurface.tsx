import { useEffect, useState } from 'react';
import type { SparkiiApi } from '../types/sparkii-api.js';
import { Button, ChatMessage, type ComposerAttachment } from '@sparkii/ui';
import { Composer } from '../workbench/Composer.js';
import { ToolCard } from '../workbench/ToolCard.js';
import { Markdown } from '../workbench/Markdown.js';
import { THINKING_LEVELS } from '../workbench/thinking-levels.js';

export type ChatEntry =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string; thinking?: string; streaming: boolean }
  | { kind: 'tool'; id: string; toolName: string; input: unknown; result?: unknown; awaitingApproval?: boolean };

function findLastUnresolvedTool(entries: ChatEntry[], toolName: string): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === 'tool' && e.toolName === toolName && e.result === undefined) return i;
  }
  return -1;
}

export function applyChatEvent(entries: ChatEntry[], ev: unknown): ChatEntry[] {
  const raw = ev as { type?: string; role?: string; delta?: string; text?: string; thinkingDelta?: string; thinking?: string; toolName?: string; input?: unknown; result?: unknown };
  if (raw.type === 'message') {
    if (raw.role === 'user') return entries;
    const last = entries[entries.length - 1];
    const isActive = last?.kind === 'message' && last.role === 'assistant' && last.streaming;
    const base = isActive
      ? (last as Extract<ChatEntry, { kind: 'message' }>)
      : { kind: 'message' as const, id: `m${Date.now()}-${Math.random()}`, role: 'assistant' as const, text: '', streaming: true };

    if (typeof raw.thinkingDelta === 'string') {
      const next = { ...base, thinking: (base.thinking ?? '') + raw.thinkingDelta };
      return isActive ? [...entries.slice(0, -1), next] : [...entries, next];
    }

    const finalThinking = typeof raw.thinking === 'string' ? raw.thinking : undefined;
    const finalText = typeof raw.text === 'string' ? raw.text : undefined;
    const delta = typeof raw.delta === 'string' ? raw.delta : undefined;
    if (finalThinking === undefined && finalText === undefined && delta === undefined) return entries;

    const next = {
      ...base,
      thinking: finalThinking !== undefined ? finalThinking : base.thinking,
      text: finalText !== undefined ? finalText : delta !== undefined ? base.text + delta : base.text,
      streaming: delta !== undefined,
    };
    return isActive ? [...entries.slice(0, -1), next] : [...entries, next];
  }
  if (raw.type === 'tool_call') {
    return [...entries, { kind: 'tool', id: `t${Date.now()}-${Math.random()}`, toolName: String(raw.toolName ?? ''), input: raw.input }];
  }
  if (raw.type === 'tool_result' && raw.toolName) {
    const idx = findLastUnresolvedTool(entries, raw.toolName);
    if (idx < 0) return entries;
    const next = [...entries];
    const target = next[idx] as Extract<ChatEntry, { kind: 'tool' }>;
    next[idx] = { ...target, result: raw.result, awaitingApproval: false };
    return next;
  }
  return entries;
}

export function normalizeMessages(messages: unknown[]): ChatEntry[] {
  const out: ChatEntry[] = [];
  let n = 0;
  for (const m of messages) {
    const rec = m as { role?: string; text?: string; content?: unknown };
    const role = rec.role === 'user' ? 'user' : rec.role === 'assistant' ? 'assistant' : null;
    const blocks = Array.isArray(rec.content)
      ? (rec.content as Array<{ type?: string; text?: string; thinking?: string }>)
      : [];
    const text = typeof rec.text === 'string'
      ? rec.text
      : blocks.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    const thinking = blocks.filter((c) => c.type === 'thinking').map((c) => c.thinking ?? '').join('') || undefined;
    if (role && (text || thinking)) {
      out.push({ kind: 'message', id: `m${n++}`, role, text, thinking, streaming: false });
    }
  }
  return out;
}

export interface GeneralChatSurfaceProps {
  api: SparkiiApi;
  sessionId: string | null;
  onNewSession(): void;
}

function resolveThinkingTarget(
  model: string | null,
  provider: string,
  defaultModel: string | null,
): { provider: string; modelId: string } | null {
  if (model) {
    const slash = model.indexOf('/');
    return slash >= 0
      ? { provider: model.slice(0, slash), modelId: model.slice(slash + 1) }
      : { provider, modelId: model };
  }
  if (defaultModel) return { provider, modelId: defaultModel };
  return null;
}

export function GeneralChatSurface(props: GeneralChatSurfaceProps) {
  const { api, sessionId, onNewSession } = props;
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [provider, setProvider] = useState<string>('deepseek');
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([...THINKING_LEVELS]);
  const [thinkingLevel, setThinkingLevel] = useState<string | null>(null);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);

  const refreshThinkingLevels = (m: string | null, prov = provider, def = defaultModel) => {
    const target = resolveThinkingTarget(m, prov, def);
    if (!target) { setThinkingLevels([...THINKING_LEVELS]); return; }
    api.listThinkingLevels(target.provider, target.modelId)
      .then((levels) => setThinkingLevels(levels?.length ? levels : [...THINKING_LEVELS]))
      .catch(() => setThinkingLevels([...THINKING_LEVELS]));
  };

  const refreshMeta = () => {
    if (!sessionId) return;
    api.getChatSession(sessionId).then((rec: any) => {
      if (rec?.workspacePath) setWorkspacePath(rec.workspacePath);
      if (rec?.thinkingLevel !== undefined) setThinkingLevel(rec.thinkingLevel ?? null);
      if (rec?.model) { setModel(rec.model); refreshThinkingLevels(rec.model); }
    });
  };

  useEffect(() => {
    setEntries([]);
    setBusy(false);
    setError('');
    setModel(null);
    setThinkingLevel(null);
    setThinkingLevels([...THINKING_LEVELS]);
    setProvider('deepseek');
    if (!sessionId) return;
    api.openChatSession(sessionId).then(({ messages }: any) => {
      setEntries(normalizeMessages(messages ?? []));
    }).catch((e: any) => setError(String(e?.message ?? e)));
    api.getModelOptions().then((r: any) => {
      setModels(r.models ?? []);
      setDefaultModel(r.defaultModel ?? null);
      setProvider(r.provider ?? 'deepseek');
      refreshThinkingLevels(model ?? r.defaultModel ?? null, r.provider ?? 'deepseek', r.defaultModel ?? null);
    });
    refreshMeta();
    const off1 = api.on('chat-event', (p: any) => {
      if (p?.sessionId !== sessionId) return;
      setEntries((xs) => applyChatEvent(xs, p));
    });
    const off2 = api.on('approval', (p: any) => {
      if (p?.sessionId !== sessionId || !p?.toolName) return;
      setEntries((xs) => {
        const idx = findLastUnresolvedTool(xs, p.toolName);
        if (idx < 0) return xs;
        const next = [...xs];
        next[idx] = { ...(next[idx] as Extract<ChatEntry, { kind: 'tool' }>), awaitingApproval: true };
        return next;
      });
    });
    return () => { off1(); off2(); };
  }, [api, sessionId]);

  const getLocalPath = (file: File): string => api.getPathForFile(file);

  const send = (text: string, attachments: ComposerAttachment[] = []) => {
    if (!sessionId) return;
    const display = attachments.length ? `${attachments.map((a) => `📎 ${a.name}`).join(' ')}\n${text}` : text;
    const prompt = attachments.length
      ? `请基于以下我提供的文件进行分析:\n${attachments.map((a) => `- ${a.path}`).join('\n')}\n\n${text}`
      : text;
    setEntries((xs) => [...xs, { kind: 'message', id: `u${Date.now()}`, role: 'user', text: display, streaming: false }]);
    setBusy(true);
    setError('');
    api.promptSession(sessionId, prompt).catch((e: any) => setError(String(e?.message ?? e))).finally(() => setBusy(false));
  };

  const stop = () => {
    if (sessionId) void api.abortChat(sessionId).finally(() => setBusy(false));
  };

  const onModelChange = (next: string | null) => {
    setModel(next);
    if (sessionId) void api.setChatModel(sessionId, next);
    refreshThinkingLevels(next);
  };

  const onThinkingLevelChange = (next: string | null) => {
    setThinkingLevel(next);
    if (sessionId) void api.setChatThinkingLevel(sessionId, next);
  };

  const chooseWorkspace = () => {
    api.chooseWorkspace().then(({ path }: any) => {
      if (path && sessionId) {
        api.setChatWorkspace(sessionId, path).then(refreshMeta);
      }
    });
  };

  if (!sessionId) {
    return (
      <div className="chat-empty">
        <h3>通用智能体</h3>
        <p>可以对话问答，也可以在工作区内编程：读代码、跑命令、改文件。</p>
        <Button variant="primary" onClick={onNewSession}>新建会话</Button>
      </div>
    );
  }

  return (
    <div className="chat-surface">
      <div className="chat-list">
        {entries.map((e) => (
          e.kind === 'message' ? (
            e.role === 'assistant'
              ? <ChatMessage key={e.id} role="assistant" text={e.text} thinking={e.thinking} streaming={e.streaming}><Markdown text={e.text} /></ChatMessage>
              : <ChatMessage key={e.id} role="user" text={e.text} />
          ) : (
            <ToolCard key={e.id} toolName={e.toolName} input={e.input} result={e.result} awaitingApproval={e.awaitingApproval} />
          )
        ))}
        {entries.length === 0 && !busy && <div className="muted chat-hint">开始对话，或让智能体在工作区里做点什么。</div>}
      </div>
      {error && <div className="chat-error" role="alert">{error}</div>}
      <Composer
        busy={busy}
        models={models}
        defaultModel={defaultModel}
        model={model}
        onModelChange={onModelChange}
        thinkingLevels={thinkingLevels}
        thinkingLevel={thinkingLevel}
        onThinkingLevelChange={onThinkingLevelChange}
        workspacePath={workspacePath}
        getLocalPath={getLocalPath}
        onChooseWorkspace={chooseWorkspace}
        onSend={send}
        onStop={stop}
      />
    </div>
  );
}
