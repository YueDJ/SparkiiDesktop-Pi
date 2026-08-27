import { useEffect, useState } from 'react';
import type { SparkiiApi } from '../types/sparkii-api.js';
import { Composer } from '../workbench/Composer.js';
import { ToolCard } from '../workbench/ToolCard.js';
import { Markdown } from '../workbench/Markdown.js';
import { THINKING_LEVELS } from '../workbench/thinking-levels.js';

export type ChatEntry =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string; streaming: boolean }
  | { kind: 'tool'; id: string; toolName: string; input: unknown; result?: unknown; awaitingApproval?: boolean };

function findLastUnresolvedTool(entries: ChatEntry[], toolName: string): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === 'tool' && e.toolName === toolName && e.result === undefined) return i;
  }
  return -1;
}

export function applyChatEvent(entries: ChatEntry[], ev: unknown): ChatEntry[] {
  const raw = ev as { type?: string; role?: string; delta?: string; text?: string; toolName?: string; input?: unknown; result?: unknown };
  if (raw.type === 'message') {
    if (raw.role === 'user') return entries;
    const last = entries[entries.length - 1];
    if (typeof raw.delta === 'string') {
      if (last?.kind === 'message' && last.role === 'assistant' && last.streaming) {
        return [...entries.slice(0, -1), { ...last, text: last.text + raw.delta }];
      }
      return [...entries, { kind: 'message', id: `m${Date.now()}-${Math.random()}`, role: 'assistant', text: raw.delta, streaming: true }];
    }
    if (typeof raw.text === 'string') {
      if (last?.kind === 'message' && last.role === 'assistant' && last.streaming) {
        return [...entries.slice(0, -1), { ...last, text: raw.text, streaming: false }];
      }
      return [...entries, { kind: 'message', id: `m${Date.now()}-${Math.random()}`, role: 'assistant', text: raw.text, streaming: false }];
    }
    return entries;
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
    const text = typeof rec.text === 'string'
      ? rec.text
      : Array.isArray(rec.content)
        ? rec.content.map((c) => (c as { text?: string })?.text ?? '').join('')
        : '';
    if (role && text) out.push({ kind: 'message', id: `m${n++}`, role, text, streaming: false });
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
  const [workspaceKind, setWorkspaceKind] = useState<'auto' | 'user'>('auto');

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
      if (rec?.workspaceKind === 'user') setWorkspaceKind('user');
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

  const send = (text: string) => {
    if (!sessionId) return;
    setEntries((xs) => [...xs, { kind: 'message', id: `u${Date.now()}`, role: 'user', text, streaming: false }]);
    setBusy(true);
    setError('');
    api.promptSession(sessionId, text).catch((e: any) => setError(String(e?.message ?? e))).finally(() => setBusy(false));
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

  const clearWorkspace = () => {
    if (sessionId) api.setChatWorkspace(sessionId, null).then(refreshMeta);
  };

  if (!sessionId) {
    return (
      <div className="chat-empty">
        <h3>通用智能体</h3>
        <p>可以对话问答，也可以在工作区内编程：读代码、跑命令、改文件。</p>
        <button type="button" className="btn primary" onClick={onNewSession}>新建会话</button>
      </div>
    );
  }

  return (
    <div className="chat-surface">
      <div className="chat-list">
        {entries.map((e) => (
          e.kind === 'message' ? (
            <div key={e.id} className={`msg msg-${e.role}`}>
              {e.role === 'assistant' ? <Markdown text={e.text} /> : <span className="msg-text">{e.text}</span>}
              {e.streaming && <span className="caret" aria-hidden="true" />}
            </div>
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
        workspaceKind={workspaceKind}
        onChooseWorkspace={chooseWorkspace}
        onClearWorkspace={clearWorkspace}
        onSend={send}
        onStop={stop}
      />
    </div>
  );
}
