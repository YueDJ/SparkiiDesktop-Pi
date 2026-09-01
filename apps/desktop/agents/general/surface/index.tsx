import { useEffect, useRef, useState } from 'react';
import type { ChatAttachment, SparkiiApi } from '../../../src/types/sparkii-api.js';
import { Button, ChatMessage, useErrors, type ComposerAttachment } from '@sparkii/ui';
import { Composer } from '../../../src/workbench/Composer.js';
import { ToolCard } from '../../../src/workbench/ToolCard.js';
import { LifecycleCard } from '../../../src/workbench/LifecycleCard.js';
import { Markdown } from '../../../src/workbench/Markdown.js';
import { THINKING_LEVELS } from '../../../src/workbench/thinking-levels.js';
import {
  DEFAULT_CHAT_DETAIL_LEVEL,
  isChatDetailLevel,
  shouldShowEntry,
  type ChatDetailLevel,
} from '../../../src/workbench/chat-detail-level.js';
import * as Timeline from '../../../src/workbench/pi-timeline.js';
import type { ChatEntry } from '../../../src/workbench/pi-timeline.js';

export { applyChatEvent, normalizeMessages, type ChatEntry } from '../../../src/workbench/pi-timeline.js';

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

export interface GeneralChatSurfaceProps {
  api: SparkiiApi;
  sessionId: string | null;
  active?: boolean;
  draft?: boolean;
  onNewSession(): void;
  onSessionCommitted?(sessionId: string, title?: string): void;
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
  const { api, sessionId, active = true, draft = false, onNewSession, onSessionCommitted } = props;
  const { reportError } = useErrors();
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [queues, setQueues] = useState<QueueMap>({ steering: [], followUp: [] });
  const [drafts, setDrafts] = useState<QueueMap>({ steering: [], followUp: [] });
  const [models, setModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [provider, setProvider] = useState<string>('deepseek');
  const [supportsImages, setSupportsImages] = useState<Record<string, boolean>>({});
  const [visionWarning, setVisionWarning] = useState<string | null>(null);
  const [compatibleModels, setCompatibleModels] = useState<Set<string>>(new Set());
  const [modelWarning, setModelWarning] = useState<string | null>(null);
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([...THINKING_LEVELS]);
  const [thinkingLevel, setThinkingLevel] = useState<string | null>(null);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [contextUsage, setContextUsage] = useState<{ tokens?: number | null; contextWindow?: number; percent?: number | null } | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [detailLevel, setDetailLevel] = useState<ChatDetailLevel>(DEFAULT_CHAT_DETAIL_LEVEL);
  const lastIdlePromptRef = useRef('');
  const suppressUserEventRef = useRef(false);
  const modelRef = useRef(model);

  useEffect(() => { modelRef.current = model; }, [model]);

  const refreshContext = () => {
    if (!sessionId) return;
    api.getChatState(sessionId).then((state: any) => {
      setContextUsage(state?.contextUsage ?? null);
      setIsCompacting(Boolean(state?.isCompacting));
    }).catch(() => {
      // 上下文状态读取失败时保持上次可用值，不打断聊天流程
    });
  };

  const refreshThinkingLevels = (m: string | null, prov = provider, def = defaultModel) => {
    const target = resolveThinkingTarget(m, prov, def);
    if (!target) { setThinkingLevels([...THINKING_LEVELS]); return; }
    api.listThinkingLevels(target.provider, target.modelId)
      .then((levels) => setThinkingLevels(levels?.length ? levels : [...THINKING_LEVELS]))
      .catch(() => setThinkingLevels([...THINKING_LEVELS]));
  };

  const refreshMeta = (availableModels: string[], activeProvider: string, defaultModelId: string | null) => {
    if (!sessionId) return;
    api.getChatSession(sessionId).then((rec: any) => {
      if (rec?.workspacePath) setWorkspacePath(rec.workspacePath);
      if (rec?.thinkingLevel !== undefined) setThinkingLevel(rec.thinkingLevel ?? null);
      const storedModel = typeof rec?.model === 'string' ? rec.model : null;
      const slash = storedModel?.indexOf('/');
      const storedProvider = slash !== undefined && slash >= 0 ? storedModel.slice(0, slash) : null;
      const modelId = slash !== undefined && slash >= 0 ? storedModel.slice(slash + 1) : storedModel;
      const providerMatches = !storedProvider || storedProvider === activeProvider;
      const modelIsKnown = availableModels.length === 0
        || (storedModel !== null
          && providerMatches
          && (availableModels.includes(storedModel) || (modelId !== undefined && availableModels.includes(modelId))));
      if (storedModel && modelIsKnown) {
        setModel(storedModel);
        refreshThinkingLevels(storedModel, activeProvider, defaultModelId);
        return;
      }
      if (storedModel) {
        void api.setChatModel(sessionId, null).catch(() => {});
      }
      setModel(null);
      refreshThinkingLevels(null, activeProvider, defaultModelId);
    }).catch((e: any) => reportError(String(e?.message ?? e), { source: '通用智能体' }));
  };

  const refreshModelOptions = () => {
    api.getModelOptions('general').then((r: any) => {
      const nextProvider = r.provider ?? 'deepseek';
      const nextModels = r.models ?? [];
      const nextDefault = r.defaultModel ?? null;
      setModels(nextModels);
      setDefaultModel(nextDefault);
      setProvider(nextProvider);
      setSupportsImages(r.supportsImages ?? {});
      setCompatibleModels(new Set(r.compatibleModels ?? []));
      if (!sessionId) {
        setThinkingLevel(null);
        setThinkingLevels([...THINKING_LEVELS]);
        return;
      }
      refreshMeta(nextModels, nextProvider, nextDefault);
    }).catch((e: any) => reportError(String(e?.message ?? e), { source: '通用智能体' }));
  };

  useEffect(() => {
    setEntries([]);
    setBusy(false);
    setStopping(false);
    setQueues({ steering: [], followUp: [] });
    setDrafts({ steering: [], followUp: [] });
    setModel(null);
    setThinkingLevel(null);
    setThinkingLevels([...THINKING_LEVELS]);
    setWorkspacePath(null);
    setProvider('deepseek');
    setContextUsage(null);
    setIsCompacting(false);
    if (!sessionId) return;
    api.getChatState(sessionId).then((state: any) => {
      setQueues({
        steering: state?.steering ?? [],
        followUp: state?.followUp ?? [],
      });
      setContextUsage(state?.contextUsage ?? null);
      setIsCompacting(Boolean(state?.isCompacting));
      if (state?.streaming) setBusy(true);
    }).catch((e: any) => reportError(String(e?.message ?? e), { source: '通用智能体' }));
    api.openChatSession(sessionId).then(({ messages, entries }: any) => {
      const base = entries?.length ? Timeline.normalizeHistoricalSessionEntries(entries) : Timeline.normalizeMessages(messages ?? []);
      setEntries(base);
    }).catch((e: any) => reportError(String(e?.message ?? e), { source: '通用智能体' }));
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
        setEntries((xs) => Timeline.applyChatEvent(xs, p));
        refreshContext();
        return;
      }
      if (p?.type === 'runtime_error') {
        reportError(typeof p?.message === 'string' ? p.message : 'Pi 运行时错误', { source: '通用智能体' });
        setEntries((xs) => Timeline.applyChatEvent(xs, p));
        return;
      }
      if (p?.type === 'message' && p?.role === 'user') {
        const text = typeof p?.text === 'string' ? p.text : '';
        if (suppressUserEventRef.current && lastIdlePromptRef.current && text.endsWith(lastIdlePromptRef.current)) {
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
      setEntries((xs) => Timeline.applyChatEvent(xs, p));
      if (p?.type === 'compaction_start' || p?.type === 'compaction_end' || p?.type === 'agent_settled') {
        refreshContext();
      }
    });
    const off2 = api.on('approval', (p: any) => {
      if (p?.sessionId !== sessionId || !p?.toolName) return;
      setEntries((xs) => {
        const idx = Timeline.findLastUnresolvedTool(xs, p.toolName);
        if (idx < 0) return xs;
        const next = [...xs];
        next[idx] = { ...(next[idx] as Extract<ChatEntry, { kind: 'tool' }>), awaitingApproval: true };
        return next;
      });
    });
    return () => { off1(); off2(); };
  }, [api, sessionId]);

  useEffect(() => {
    if (!active) return;
    refreshModelOptions();
  }, [active, sessionId, draft]);

  useEffect(() => {
    if (!active) return;
    api.getSettings().then((raw: any) => {
      if (isChatDetailLevel(raw?.chatDetailLevel)) setDetailLevel(raw.chatDetailLevel);
    }).catch(() => {
      // 读取失败时保持默认值，不打断聊天流程
    });
  }, [active, sessionId, draft, api]);

  const getLocalPath = (file: File): string => api.getPathForFile(file);

  const send = (text: string, attachments: ComposerAttachment[] = []) => {
    const display = attachments.length ? `${attachments.map((a) => `📎 ${a.name}`).join(' ')}\n${text}` : text;
    const chatAttachments: ChatAttachment[] = attachments.map(({ path, name, size, type }) => ({ path, name, size, type }));
    const hasImage = attachments.some((a) => a.type?.startsWith('image/'));
    const selectedModel = model ?? defaultModel;
    setVisionWarning(hasImage && selectedModel && supportsImages[selectedModel] === false
      ? '当前模型不支持图片输入，发送后图片将被忽略，建议切换为支持视觉的模型。'
      : null);
    setModelWarning(selectedModel && compatibleModels.size > 0 && !compatibleModels.has(selectedModel)
      ? '当前模型不满足该智能体的能力要求，部分功能可能不可用。'
      : null);

    if (busy && sessionId) {
      api.promptSession(sessionId, display, { behavior: 'followUp' }, chatAttachments.length ? chatAttachments : undefined)
        .catch((e: any) => reportError(String(e?.message ?? e), { source: '通用智能体' }));
      return;
    }

    lastIdlePromptRef.current = display;
    suppressUserEventRef.current = true;
    if (sessionId) {
      setEntries((xs) => [...xs, { kind: 'message', id: `u${Date.now()}`, role: 'user', text: display, streaming: false }]);
    }
    setBusy(true);

    api.promptSession(
      sessionId,
      display,
      undefined,
      chatAttachments.length ? chatAttachments : undefined,
      sessionId ? undefined : { profileId: 'general', workspacePath, model, thinkingLevel },
    ).then((res: any) => {
      if (!sessionId && res?.sessionId) onSessionCommitted?.(res.sessionId, text);
    }).catch((e: any) => {
      reportError(String(e?.message ?? e), { source: '通用智能体' });
      setBusy(false);
    });
  };

  const stop = () => {
    if (!sessionId || stopping) return;
    setStopping(true);
    api.abortChat(sessionId).then((res: any) => {
      setDrafts({
        steering: res?.cleared?.steering ?? [],
        followUp: res?.cleared?.followUp ?? [],
      });
      setBusy(false);
      setStopping(false);
    }).catch((e: any) => {
      reportError(String(e?.message ?? e), { source: '通用智能体' });
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
    api.queueMutate(sessionId, mutation as any).catch((e: any) => reportError(String(e?.message ?? e), { source: '通用智能体' }));
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
      .catch((e: any) => reportError(String(e?.message ?? e), { source: '通用智能体' }));
  };

  const onModelChange = (next: string | null) => {
    setModel(next);
    setVisionWarning(null);
    setModelWarning(next && compatibleModels.size > 0 && !compatibleModels.has(next)
      ? '当前模型不满足该智能体的能力要求，部分功能可能不可用。'
      : null);
    if (sessionId) void api.setChatModel(sessionId, next);
    refreshThinkingLevels(next);
  };

  const onThinkingLevelChange = (next: string | null) => {
    setThinkingLevel(next);
    if (sessionId) void api.setChatThinkingLevel(sessionId, next);
  };

  const chooseWorkspace = () => {
    api.chooseWorkspace().then(({ path }: any) => {
      if (path) {
        setWorkspacePath(path);
        if (sessionId) {
          api.setChatWorkspace(sessionId, path).then(() => refreshMeta(models, provider, defaultModel));
        }
      }
    });
  };

  if (!sessionId && !draft) {
    return (
      <div className="chat-empty">
        <h3>通用智能体</h3>
        <p>可以对话问答，也可以在工作区内编程：读代码、跑命令、改文件。</p>
        <Button variant="primary" onClick={onNewSession}>新建会话</Button>
      </div>
    );
  }

  const visibleEntries = entries.filter((entry) => shouldShowEntry(entry, detailLevel));

  return (
    <div className="chat-surface">
      <div className="chat-list">
        {visibleEntries.map((e) => (
          e.kind === 'message' ? (
            e.role === 'assistant'
              ? <ChatMessage key={e.id} role="assistant" text={e.text} thinking={e.thinking} streaming={e.streaming}><Markdown text={e.text} /></ChatMessage>
              : <ChatMessage key={e.id} role="user" text={e.text} />
          ) : e.kind === 'event' ? (
            <LifecycleCard key={e.id} entry={e} />
          ) : (
            <ToolCard key={e.id} toolName={e.toolName} input={e.input} result={e.result} awaitingApproval={e.awaitingApproval} defaultExpanded={detailLevel === 'debug'} />
          )
        ))}
        {visibleEntries.length === 0 && !busy && <div className="muted chat-hint">开始对话，或让智能体在工作区里做点什么。</div>}
      </div>
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
      {visionWarning && (
        <div className="muted chat-vision-warning" data-testid="vision-warning" role="alert">
          {visionWarning}
        </div>
      )}
      {modelWarning && (
        <div className="muted chat-model-warning" data-testid="model-warning" role="alert">
          {modelWarning}
        </div>
      )}
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
        contextUsage={contextUsage}
        isCompacting={isCompacting}
        workspacePath={workspacePath}
        getLocalPath={getLocalPath}
        onChooseWorkspace={chooseWorkspace}
        onSend={send}
        onStop={stop}
      />
    </div>
  );
}
