import { useEffect, useRef, useState } from 'react';
import type { SparkiiApi } from '../types/sparkii-api.js';
import { Button, ChatMessage, type ComposerAttachment } from '@sparkii/ui';
import { Composer } from '../workbench/Composer.js';
import { ToolCard } from '../workbench/ToolCard.js';
import { Markdown } from '../workbench/Markdown.js';
import { THINKING_LEVELS } from '../workbench/thinking-levels.js';

export type ChatEntry =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string; thinking?: string; streaming: boolean }
  | { kind: 'tool'; id: string; toolName: string; input: unknown; result?: unknown; awaitingApproval?: boolean };

type QueueName = 'steering' | 'followUp';
type QueueMap = Record<QueueName, string[]>;

interface QueueGroupProps {
  title: string;
  queue: QueueName;
  items: string[];
  showGuide?: boolean;
  showReturn?: boolean;
  onEdit(queue: QueueName, index: number, text: string): void;
  onDelete(queue: QueueName, index: number): void;
  onTransfer(queue: QueueName, index: number, targetQueue: QueueName): void;
  onMove(queue: QueueName, fromIndex: number, toIndex: number): void;
}

function QueueGroup({
  title,
  queue,
  items,
  showGuide = false,
  showReturn = false,
  onEdit,
  onDelete,
  onTransfer,
  onMove,
}: QueueGroupProps) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  if (items.length === 0) return null;

  const beginEdit = (index: number, text: string) => {
    setEditing(index);
    setDraft(text);
  };

  const saveEdit = () => {
    if (editing === null) return;
    const text = draft.trim();
    if (text) onEdit(queue, editing, text);
    setEditing(null);
    setDraft('');
  };

  return (
    <section className="chat-queue-group" data-testid={`queue-${queue}`}>
      <h4 className="chat-queue-title">{title}</h4>
      <div className="chat-queue-items">
        {items.map((text, index) => (
          <div
            key={`${queue}:${index}`}
            className={`chat-queue-item${overIndex === index ? ' chat-queue-item--over' : ''}`}
            draggable={editing !== index}
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', String(index));
              setDragIndex(index);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragIndex !== null && dragIndex !== index) setOverIndex(index);
            }}
            onDragLeave={() => {
              if (overIndex === index) setOverIndex(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              const fromIndex = Number(e.dataTransfer.getData('text/plain'));
              if (Number.isInteger(fromIndex) && fromIndex !== index) onMove(queue, fromIndex, index);
              setDragIndex(null);
              setOverIndex(null);
            }}
            onDragEnd={() => {
              setDragIndex(null);
              setOverIndex(null);
            }}
          >
            <span className="chat-queue-drag" title="拖动排序" aria-label="拖动排序">≡</span>
            {editing === index ? (
              <span className="chat-queue-edit">
                <textarea
                  className="chat-queue-editor"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  autoFocus
                />
                <button type="button" className="chat-queue-action" aria-label="保存" onClick={saveEdit}>保存</button>
                <button type="button" className="chat-queue-action" aria-label="取消" onClick={() => setEditing(null)}>取消</button>
              </span>
            ) : (
              <>
                <span className="chat-queue-text">{text}</span>
                <span className="chat-queue-actions">
                  {showGuide && (
                    <button
                      type="button"
                      className="chat-queue-guide"
                      aria-label="引导"
                      onClick={() => onTransfer(queue, index, 'steering')}
                    >
                      ✧ 引导
                    </button>
                  )}
                  {showReturn && (
                    <button
                      type="button"
                      className="chat-queue-return"
                      aria-label="移回追加"
                      onClick={() => onTransfer(queue, index, 'followUp')}
                    >
                      ⇣ 移回追加
                    </button>
                  )}
                  <button type="button" className="chat-queue-icon-btn" aria-label="编辑" title="编辑" onClick={() => beginEdit(index, text)}>✎</button>
                  <button type="button" className="chat-queue-icon-btn" aria-label="删除" title="删除" onClick={() => onDelete(queue, index)}>🗑</button>
                </span>
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

interface DraftQueueProps {
  drafts: QueueMap;
  onRemove(queue: QueueName, index: number): void;
  onRestore(queue: QueueName, index: number, behavior: 'steer' | 'followUp'): void;
}

function DraftQueue({ drafts, onRemove, onRestore }: DraftQueueProps) {
  const rows: Array<{ queue: QueueName; index: number; text: string }> = [
    ...drafts.steering.map((text, index) => ({ queue: 'steering' as const, index, text })),
    ...drafts.followUp.map((text, index) => ({ queue: 'followUp' as const, index, text })),
  ];
  if (rows.length === 0) return null;
  return (
    <section className="chat-draft-queue" data-testid="draft-queue">
      <h4 className="chat-queue-title">已停止草稿</h4>
      <div className="chat-queue-items">
        {rows.map((row) => (
          <div className="chat-queue-item chat-draft-item" key={`draft:${row.queue}:${row.index}`}>
            <span className="chat-queue-text">{row.text}</span>
            <span className="chat-queue-actions">
              <button type="button" className="chat-queue-return" onClick={() => onRestore(row.queue, row.index, row.queue === 'steering' ? 'steer' : 'followUp')}>
                {row.queue === 'steering' ? '重新引导' : '重新追加'}
              </button>
              <button type="button" className="chat-queue-icon-btn" aria-label="删除草稿" onClick={() => onRemove(row.queue, row.index)}>🗑</button>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

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
  const [stopping, setStopping] = useState(false);
  const [queues, setQueues] = useState<QueueMap>({ steering: [], followUp: [] });
  const [drafts, setDrafts] = useState<QueueMap>({ steering: [], followUp: [] });
  const [error, setError] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [provider, setProvider] = useState<string>('deepseek');
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([...THINKING_LEVELS]);
  const [thinkingLevel, setThinkingLevel] = useState<string | null>(null);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const lastIdlePromptRef = useRef('');
  const suppressUserEventRef = useRef(false);

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
    setStopping(false);
    setQueues({ steering: [], followUp: [] });
    setDrafts({ steering: [], followUp: [] });
    setError('');
    setModel(null);
    setThinkingLevel(null);
    setThinkingLevels([...THINKING_LEVELS]);
    setProvider('deepseek');
    if (!sessionId) return;
    api.getChatState(sessionId).then((state: any) => {
      setQueues({
        steering: state?.steering ?? [],
        followUp: state?.followUp ?? [],
      });
      if (state?.streaming) setBusy(true);
    }).catch((e: any) => setError(String(e?.message ?? e)));
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
      if (p?.type === 'queue_update') {
        setQueues({
          steering: p?.steering ?? [],
          followUp: p?.followUp ?? [],
        });
        return;
      }
      if (p?.type === 'agent_end') {
        setBusy(false);
        setStopping(false);
        setEntries((xs) => xs.map((e) =>
          e.kind === 'message' && e.role === 'assistant' && e.streaming
            ? { ...e, streaming: false }
            : e,
        ));
        return;
      }
      if (p?.type === 'runtime_error') {
        setError(typeof p?.message === 'string' ? p.message : 'Pi 运行时错误');
        return;
      }
      if (p?.type === 'message' && p?.role === 'user') {
        const text = typeof p?.text === 'string' ? p.text : '';
        if (suppressUserEventRef.current && lastIdlePromptRef.current === text) {
          suppressUserEventRef.current = false;
          return;
        }
        if (!text) return;
        setEntries((xs) => [...xs, {
          kind: 'message',
          id: `u${Date.now()}-${Math.random()}`,
          role: 'user',
          text,
          streaming: false,
        }]);
        return;
      }
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
    setError('');
    if (busy) {
      api.promptSession(sessionId, prompt, { behavior: 'followUp' })
        .catch((e: any) => setError(String(e?.message ?? e)));
      return;
    }
    lastIdlePromptRef.current = prompt;
    suppressUserEventRef.current = true;
    setEntries((xs) => [...xs, { kind: 'message', id: `u${Date.now()}`, role: 'user', text: display, streaming: false }]);
    setBusy(true);
    api.promptSession(sessionId, prompt)
      .catch((e: any) => {
        setError(String(e?.message ?? e));
        setBusy(false);
      });
  };

  const stop = () => {
    if (!sessionId || stopping) return;
    setStopping(true);
    setError('');
    api.abortChat(sessionId).then((res: any) => {
      setDrafts({
        steering: res?.cleared?.steering ?? [],
        followUp: res?.cleared?.followUp ?? [],
      });
      setBusy(false);
      setStopping(false);
    }).catch((e: any) => {
      setError(String(e?.message ?? e));
      setStopping(false);
    });
  };

  const mutateQueue = (mutation: {
    action: 'edit' | 'delete' | 'move' | 'transfer';
    queue: QueueName;
    index?: number;
    text?: string;
    fromIndex?: number;
    toIndex?: number;
    targetQueue?: QueueName;
  }) => {
    if (!sessionId) return;
    api.queueMutate(sessionId, mutation as any).catch((e: any) => setError(String(e?.message ?? e)));
  };

  const restoreDraft = (queue: QueueName, index: number, behavior: 'steer' | 'followUp') => {
    if (!sessionId) return;
    const text = drafts[queue][index];
    if (!text) return;
    api.promptSession(sessionId, text, { behavior })
      .then(() => setDrafts((current) => {
        const next = { steering: [...current.steering], followUp: [...current.followUp] };
        next[queue].splice(index, 1);
        return next;
      }))
      .catch((e: any) => setError(String(e?.message ?? e)));
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
      <div className="chat-queue-area">
        <QueueGroup
          title="引导队列"
          queue="steering"
          items={queues.steering}
          showReturn
          onEdit={(queue, index, text) => mutateQueue({ action: 'edit', queue, index, text })}
          onDelete={(queue, index) => mutateQueue({ action: 'delete', queue, index })}
          onTransfer={(queue, index, targetQueue) => mutateQueue({ action: 'transfer', queue, index, targetQueue })}
          onMove={(queue, fromIndex, toIndex) => mutateQueue({ action: 'move', queue, fromIndex, toIndex })}
        />
        <QueueGroup
          title="追加队列"
          queue="followUp"
          items={queues.followUp}
          showGuide
          onEdit={(queue, index, text) => mutateQueue({ action: 'edit', queue, index, text })}
          onDelete={(queue, index) => mutateQueue({ action: 'delete', queue, index })}
          onTransfer={(queue, index, targetQueue) => mutateQueue({ action: 'transfer', queue, index, targetQueue })}
          onMove={(queue, fromIndex, toIndex) => mutateQueue({ action: 'move', queue, fromIndex, toIndex })}
        />
        <DraftQueue
          drafts={drafts}
          onRemove={(queue, index) => setDrafts((current) => {
            const next = { steering: [...current.steering], followUp: [...current.followUp] };
            next[queue].splice(index, 1);
            return next;
          })}
          onRestore={restoreDraft}
        />
      </div>
      <Composer
        busy={busy}
        stopping={stopping}
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
