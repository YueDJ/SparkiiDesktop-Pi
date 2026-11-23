import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  SelectMenu,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  Switch,
  TextArea,
  TextField,
} from '@sparkii/ui';
import type {
  MemoryEntryViewApi,
  MemoryListResultApi,
  MemoryScopeViewApi,
  MemorySearchHitApi,
  MemorySettingsApi,
} from '../../electron/preload/api-types.js';

export type MemoryPaneApi = {
  listMemories?(): Promise<MemoryListResultApi>;
  addMemory?(req: {
    scope: string; text: string; pinned?: boolean; agentId?: string;
    workspacePath?: string; workspaceKind?: 'auto' | 'user';
  }): Promise<MemoryEntryViewApi>;
  updateMemory?(id: string, patch: { text?: string; pinned?: boolean; status?: 'active' | 'superseded' }): Promise<MemoryEntryViewApi>;
  deleteMemory?(id: string, opts?: { mode?: 'normal' | 'privacy'; includeHistory?: boolean }): Promise<{ ok: true; removed: string[] }>;
  resolvePending?(id: string, decision: 'approve' | 'reject'): Promise<{ ok: true; message?: string }>;
  archiveProject?(workspacePath: string, archived: boolean): Promise<{ ok: true }>;
  saveMemorySettings?(partial: Partial<MemorySettingsApi>): Promise<MemorySettingsApi>;
  rebuildMemoryIndex?(): Promise<{ entries: number; corrupt: string[] }>;
  repairProjectMemory?(workspacePath: string, mode: 'empty' | 'replace', content?: string): Promise<{ ok: true }>;
  searchMemory?(query: string, opts?: { limit?: number; includeHistory?: boolean }): Promise<MemorySearchHitApi[]>;
  on?: (channel: string, cb: (payload: unknown) => void) => () => void;
};

function dateLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function SettingsMemoryPane({ api, onDirtyChange }: { api?: MemoryPaneApi; onDirtyChange?: (dirty: boolean) => void }) {
  const [data, setData] = useState<MemoryListResultApi | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [scopeKind, setScopeKind] = useState<'user' | 'agent' | 'project'>('user');
  const [agentId, setAgentId] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [draft, setDraft] = useState('');
  const [pinned, setPinned] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [editingText, setEditingText] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MemorySearchHitApi[]>([]);
  const [repairPath, setRepairPath] = useState('');
  const [repairText, setRepairText] = useState('');

  const refresh = useCallback(async () => {
    if (!api?.listMemories) return;
    try {
      const next = await api.listMemories();
      setData(next);
      if (!agentId && next.agents.length) setAgentId(next.agents[0].id);
      if (!workspacePath && next.projects.length) setWorkspacePath(next.projects[0].workspacePath);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api, agentId, workspacePath]);

  useEffect(() => { void refresh(); }, [api]);

  useEffect(() => {
    const off = api?.on?.('memory-event', (payload) => {
      const event = payload as { type?: string; op?: string; invalidatedPending?: number };
      if (event?.type === 'repair_needed') {
        setStatus('有记忆文件需要修复，已暂停使用该部分记忆');
        void refresh();
      } else if (event?.type === 'pending_added') {
        // 后台提炼出的新候选：面板开着也要当场出现，否则用户以为没有待确认。
        setStatus('有新的记忆候选待确认');
        void refresh();
      } else if (event?.type === 'memory_changed') {
        if (event.op === 'privacy-delete' && event.invalidatedPending) {
          setStatus(`来源会话已删除，${event.invalidatedPending} 条待确认记忆已失效`);
        } else if (event.op === 'source-deleted') {
          setStatus('来源会话已删除');
        }
        void refresh();
      }
    });
    return () => off?.();
  }, [api, refresh]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      setStatus('');
      await fn();
      setStatus(ok);
      setError('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const patchSettings = (partial: Partial<MemorySettingsApi>) => {
    onDirtyChange?.(true);
    void run(async () => {
      await api?.saveMemorySettings?.(partial);
      onDirtyChange?.(false);
    }, '设置已保存');
  };

  const add = () => {
    const text = draft.trim();
    if (!text) { setError('请先填写记忆内容'); return; }
    void run(async () => {
      await api?.addMemory?.({
        scope: scopeKind === 'agent' ? `agent:${agentId}` : scopeKind,
        text,
        pinned,
        ...(scopeKind === 'agent' ? { agentId } : {}),
        ...(scopeKind === 'project' ? { workspacePath, workspaceKind: 'user' as const } : {}),
      });
      setDraft('');
      setPinned(false);
    }, '记忆已添加');
  };

  const entryRow = (entry: MemoryEntryViewApi, scope: MemoryScopeViewApi) => {
    const isEditing = editingId === entry.id;
    return (
      <div className="memory-entry" key={entry.id} data-testid={`memory-entry-${entry.id}`}>
        {isEditing ? (
          <>
            <TextField
              aria-label="编辑记忆"
              value={editingText}
              onChange={(e) => setEditingText(e.target.value)}
            />
            <div className="memory-entry-actions">
              <Button onClick={() => {
                const text = editingText.trim();
                void run(async () => {
                  await api?.updateMemory?.(entry.id, { text });
                  setEditingId('');
                }, '记忆已更新');
              }}>保存</Button>
              <Button onClick={() => setEditingId('')}>取消</Button>
            </div>
          </>
        ) : (
          <>
            <div className="memory-entry-text">{entry.text}</div>
            <div className="memory-entry-meta">
              {dateLabel(entry.updatedAt)} · {entry.status === 'pending' ? '待确认' : entry.status === 'superseded' ? '历史版本' : '生效中'}
              {entry.sourceDeleted ? ' · 来源已删除' : entry.source?.excerpt ? ` · 来源：${entry.source.excerpt}` : ''}
              {' · '}被引用 {entry.usage.accessCount} 次
            </div>
            <div className="memory-entry-actions">
              <Button
                data-testid={`memory-pin-${entry.id}`}
                onClick={() => void run(async () => { await api?.updateMemory?.(entry.id, { pinned: !entry.pinned }); }, '已更新置顶')}
              >{entry.pinned ? '取消置顶' : '置顶'}</Button>
              <Button onClick={() => { setEditingId(entry.id); setEditingText(entry.text); }}>编辑</Button>
              <Button
                onClick={() => {
                  if (!window.confirm('删除这条记忆？')) return;
                  void run(() => api?.deleteMemory?.(entry.id, { mode: 'normal' }) ?? Promise.resolve(), '记忆已删除');
                }}
              >删除</Button>
              {entry.source?.sessionId && (
                <Button
                  onClick={() => {
                    if (!window.confirm('将连同来源会话一起删除，且不可恢复。确认继续？')) return;
                    void run(() => api?.deleteMemory?.(entry.id, { mode: 'privacy' }) ?? Promise.resolve(), '来源会话与相关记忆已删除');
                  }}
                >连源会话删除</Button>
              )}
              {scope.kind === 'project' && scope.workspacePath && (
                <Button
                  onClick={() => void run(() => api?.archiveProject?.(scope.workspacePath!, !scope.archived) ?? Promise.resolve(), scope.archived ? '已恢复注入' : '已归档')}
                >{scope.archived ? '取消归档' : '归档'}</Button>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  const settings = data?.settings;
  return (
    <>
      <SettingsPageHeader title="记忆" />
      <SettingsSection title="总览">
        <div className="memory-note">记忆更新在新会话生效。记忆内容只保存在本机。</div>
        {settings && (
          <>
            <SettingsRow label="启用记忆" description="关闭后不再注入记忆，也不记录新记忆。">
              <Switch label="启用记忆" checked={settings.enabled} onCheckedChange={(enabled) => patchSettings({ enabled })} />
            </SettingsRow>
            <SettingsRow
              label="自动提炼"
              description="自动提炼会将对话内容发送给你配置的大模型。关闭后仅手动记忆可用。"
            >
              <Switch label="自动提炼" checked={settings.autoExtract} onCheckedChange={(autoExtract) => patchSettings({ autoExtract })} />
            </SettingsRow>
            <SettingsRow label="空闲整合" description="空闲时整理已有记忆，整理结果仍需你确认才会生效。">
              <Switch label="空闲整合" checked={settings.idleConsolidation} onCheckedChange={(idleConsolidation) => patchSettings({ idleConsolidation })} />
            </SettingsRow>
          </>
        )}
        {data && !data.ftsAvailable && (
          <div className="memory-note">本机基础检索不可用，已使用兼容方式检索，功能不受影响。</div>
        )}
        {data?.warnings.map((warning) => <div className="memory-warning" key={warning}>{warning}</div>)}
        <div className="settings-actions">
          <Button onClick={() => void run(() => api?.rebuildMemoryIndex?.() ?? Promise.resolve(), '已按现有记忆文件重新整理')}>
            重建索引（使用统计会清零）
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection title="新增记忆">
        <SettingsRow label="归属">
          <SelectMenu
            aria-label="记忆归属"
            value={scopeKind}
            options={[
              { value: 'user', label: '用户（所有智能体共用）' },
              { value: 'agent', label: '智能体习惯' },
              { value: 'project', label: '项目（同工作区共用）' },
            ]}
            onChange={(next) => setScopeKind(next as typeof scopeKind)}
          />
        </SettingsRow>
        {scopeKind === 'agent' && (
          <SettingsRow label="智能体">
            <SelectMenu
              aria-label="智能体"
              value={agentId}
              options={(data?.agents ?? []).map((a) => ({ value: a.id, label: a.name }))}
              onChange={setAgentId}
            />
          </SettingsRow>
        )}
        {scopeKind === 'project' && (
          <SettingsRow label="项目工作区" description="仅正式工作区可保存项目记忆。">
            <SelectMenu
              aria-label="项目工作区"
              value={workspacePath}
              options={(data?.projects ?? []).map((p) => ({ value: p.workspacePath, label: p.name || p.workspacePath }))}
              onChange={setWorkspacePath}
            />
          </SettingsRow>
        )}
        <SettingsRow label="内容" description="一句话陈述，不超过 200 字。">
          <TextArea aria-label="记忆内容" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
        </SettingsRow>
        <SettingsRow label="置顶">
          <Switch label="置顶记忆" checked={pinned} onCheckedChange={setPinned} />
        </SettingsRow>
        <div className="settings-actions">
          <Button variant="primary" onClick={add}>添加记忆</Button>
        </div>
      </SettingsSection>

      <SettingsSection title="回忆">
        <SettingsRow label="查找记忆" description="可按项目、时间或内容片段查找。">
          <TextField
            aria-label="查找记忆"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="例如：上个月那个项目"
          />
        </SettingsRow>
        <div className="settings-actions">
          <Button onClick={() => void run(async () => { setHits(await api?.searchMemory?.(query.trim(), { limit: 10 }) ?? []); }, '已完成查找')}>查找</Button>
        </div>
        {hits.map((hit) => (
          <div className="memory-entry" key={hit.id}>
            <div className="memory-entry-text">{hit.text}</div>
            <div className="memory-entry-meta">
              {hit.kind === 'episode' ? '会话摘要' : '记忆'} · {hit.projectId ?? hit.workspacePath ?? hit.scope}
            </div>
          </div>
        ))}
      </SettingsSection>

      {Boolean(data?.pending.length) && (
        <SettingsSection title="待确认">
          {data?.pending.map((entry) => (
            <div className="memory-entry" key={entry.id}>
              <div className="memory-entry-text">{entry.text}</div>
              <div className="memory-entry-meta">
                {entry.source?.excerpt ? `来源：${entry.source.excerpt}` : '暂无来源片段'}
                {entry.pendingOp?.degradedFrom ? ' · 原目标已变化，请重新确认' : ''}
              </div>
              <div className="memory-entry-actions">
                <Button variant="primary" onClick={() => void run(async () => {
                  const result = await api?.resolvePending?.(entry.id, 'approve');
                  if (result?.message) setStatus(result.message);
                }, '已确认')}>批准</Button>
                <Button onClick={() => void run(() => api?.resolvePending?.(entry.id, 'reject') ?? Promise.resolve(), '已驳回')}>驳回</Button>
              </div>
            </div>
          ))}
        </SettingsSection>
      )}

      {data?.scopes.map((scope) => (
        <SettingsSection title={scope.label} key={scope.scope}>
          {scope.warning && <div className="memory-warning">{scope.warning}</div>}
          {scope.corrupt && (
            <div className="memory-entry">
              <div className="memory-entry-text">该项目的记忆内容无法读取，已暂停使用。确认后可重新整理。</div>
              <SettingsRow label="修复方式" description="可留空重新整理，或粘贴此前保存的内容。">
                <TextArea aria-label="修复内容" rows={3} value={repairText} onChange={(e) => setRepairText(e.target.value)} />
              </SettingsRow>
              <div className="settings-actions">
                <Button onClick={() => {
                  setRepairPath(scope.workspacePath ?? '');
                  void run(() => api?.repairProjectMemory?.(scope.workspacePath ?? '', 'empty') ?? Promise.resolve(), '已重新整理');
                }}>重新整理</Button>
                <Button onClick={() => {
                  const path = repairPath || scope.workspacePath || '';
                  void run(() => api?.repairProjectMemory?.(path, 'replace', repairText) ?? Promise.resolve(), '已按提供内容修复');
                }}>按提供内容修复</Button>
              </div>
            </div>
          )}
          {scope.entries.filter((entry) => entry.status !== 'pending').length === 0 && (
            <div className="ui-muted">暂无记忆</div>
          )}
          {scope.entries.filter((entry) => entry.status !== 'pending').map((entry) => entryRow(entry, scope))}
        </SettingsSection>
      ))}

      {status && <div className="memory-note">{status}</div>}
      {error && <div className="memory-warning">{error}</div>}
    </>
  );
}
