import { useState, type ReactNode } from 'react';
import { Button } from '../primitives/Button.js';
import { Modal } from '../primitives/Modal.js';
import { useErrors } from './ErrorCenter.js';

export type RuntimeCenterStatus = 'running' | 'waiting-approval' | 'idle';

export interface RuntimeCenterSession {
  sessionId: string;
  profileId: string;
  profileName: string;
  label: string;
  status: RuntimeCenterStatus;
}

export interface RuntimeCenterQueueItem {
  queueId: string;
  profileId: string;
  profileName: string;
  label: string;
  position: number;
}

export interface RuntimePoolSummary {
  active: number;
  queued: number;
  maxAgents: number;
  sessions: RuntimeCenterSession[];
  queue: RuntimeCenterQueueItem[];
}

export type DocumentParseStatus = 'stopped' | 'starting' | 'parsing' | 'idle' | 'resident';

export interface DocumentParseWaiting {
  sessionId: string;
  agentDisplayName: string;
  fileName: string;
}

export interface DocumentParseSnapshot {
  status: DocumentParseStatus;
  fileName?: string;
  agentDisplayName?: string;
  page?: number;
  total?: number;
  idleRemainingSec?: number;
  waiting: DocumentParseWaiting[];
  circuitOpen?: boolean;
}

export const EMPTY_DOCUMENT_PARSE: DocumentParseSnapshot = { status: 'stopped', waiting: [] };

type ConfirmState =
  | { kind: 'stop'; sessionId: string }
  | { kind: 'release'; sessionId: string }
  | { kind: 'stop-parse' }
  | { kind: 'release-parse' }
  | null;

function formatIdleRemaining(sec: number): string {
  return sec >= 60 ? `${Math.round(sec / 60)}分钟后释放` : `${sec}秒后释放`;
}

function documentParseStatusLabel(parse: DocumentParseSnapshot): string {
  switch (parse.status) {
    case 'stopped':
      return '未启动';
    case 'starting':
      return '正在加载';
    case 'parsing': {
      const parts = ['正在解析'];
      if (parse.agentDisplayName) parts.push(parse.agentDisplayName);
      if (parse.fileName) parts.push(parse.fileName);
      if (parse.page != null && parse.total != null) parts.push(`第 ${parse.page}/${parse.total} 页`);
      return parts.join(' · ');
    }
    case 'idle':
      return parse.idleRemainingSec == null ? '空闲' : `空闲 · ${formatIdleRemaining(parse.idleRemainingSec)}`;
    case 'resident':
      return '常驻';
  }
}

function confirmCopy(confirm: Exclude<ConfirmState, null>): { title: string; body: string; button: string; danger: boolean } {
  switch (confirm.kind) {
    case 'stop':
      return { title: '停止会话', body: '确认中断当前这一轮？会话和线程会保留。', button: '确认停止', danger: false };
    case 'release':
      return { title: '释放线程', body: '确认释放线程？会话记录会保留，工作进程将被复用。', button: '确认释放', danger: true };
    case 'stop-parse':
      return {
        title: '确认停止这次文档解析？智能体会收到失败结果。',
        body: '确认停止这次文档解析？智能体会收到失败结果。',
        button: '确认停止解析',
        danger: false,
      };
    case 'release-parse':
      return {
        title: '确认释放文档解析？下次扫描文件会重新加载。',
        body: '确认释放文档解析？下次扫描文件会重新加载。',
        button: '确认释放',
        danger: true,
      };
  }
}

export function RuntimeCenter({
  snapshot,
  documentParse = EMPTY_DOCUMENT_PARSE,
  onStop,
  onRelease,
  onCancelQueue,
  onStopParse,
  onReleaseParse,
  onCancelLoad,
}: {
  snapshot: RuntimePoolSummary;
  documentParse?: DocumentParseSnapshot;
  onStop(sessionId: string): Promise<void> | void;
  onRelease(sessionId: string): Promise<void> | void;
  onCancelQueue(queueId: string): Promise<void> | void;
  onStopParse?(): Promise<void> | void;
  onReleaseParse?(): Promise<void> | void;
  onCancelLoad?(): Promise<void> | void;
}) {
  const { reportError } = useErrors();
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const parse = documentParse;

  const run = async (key: string, action: () => Promise<void> | void, source = '运行中心') => {
    setBusy(key);
    try {
      await action();
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e), { source });
    } finally {
      setBusy(null);
    }
  };

  const confirmAction = () => {
    if (!confirm) return;
    const current = confirm;
    setConfirm(null);
    if (current.kind === 'stop') void run(`stop:${current.sessionId}`, () => onStop(current.sessionId));
    else if (current.kind === 'release') void run(`release:${current.sessionId}`, () => onRelease(current.sessionId));
    else if (current.kind === 'stop-parse') void run('stop-parse', () => onStopParse?.(), '文档解析');
    else void run('release-parse', () => onReleaseParse?.(), '文档解析');
  };

  const statusLabel = (status: RuntimeCenterStatus) =>
    status === 'running' ? '生成中' : status === 'waiting-approval' ? '等待审批' : '空闲占用';

  const copy = confirm ? confirmCopy(confirm) : null;

  let parseAction: ReactNode = null;
  if (parse.status === 'starting') {
    parseAction = (
      <Button size="sm" disabled={busy === 'cancel-load'} onClick={() => void run('cancel-load', () => onCancelLoad?.(), '文档解析')}>
        取消加载
      </Button>
    );
  } else if (parse.status === 'parsing') {
    parseAction = (
      <Button size="sm" disabled={busy === 'stop-parse'} onClick={() => setConfirm({ kind: 'stop-parse' })}>
        停止解析
      </Button>
    );
  } else if (parse.status === 'idle' || parse.status === 'resident') {
    parseAction = (
      <Button size="sm" variant="danger" disabled={busy === 'release-parse'} onClick={() => setConfirm({ kind: 'release-parse' })}>
        释放
      </Button>
    );
  }

  return (
    <div className="ui-runtime-center">
      <div className="ui-runtime-summary">
        运行 {snapshot.active}/{snapshot.maxAgents} · 排队 {snapshot.queued} · 空闲 {Math.max(0, snapshot.maxAgents - snapshot.active)}
      </div>
      <div className="ui-runtime-section">
        <div className="ui-rail-label">智能体</div>
        <div className="ui-rail-label">运行中</div>
        {snapshot.sessions.length === 0 ? <div className="ui-muted">暂无运行中的智能体</div> : snapshot.sessions.map((s) => (
          <div key={s.sessionId} className="ui-runtime-row">
            <div className="ui-runtime-main">
              <b>{s.profileName}</b>
              <span className="ui-muted">{s.label}</span>
              <span className={`ui-status-badge ui-status-badge--${s.status === 'waiting-approval' ? 'approval' : s.status === 'running' ? 'running' : 'ok'}`}>{statusLabel(s.status)}</span>
            </div>
            <div className="ui-runtime-actions">
              <Button size="sm" disabled={s.status === 'idle' || busy === `stop:${s.sessionId}`} onClick={() => setConfirm({ kind: 'stop', sessionId: s.sessionId })}>停止</Button>
              <Button size="sm" variant="danger" disabled={busy === `release:${s.sessionId}`} onClick={() => setConfirm({ kind: 'release', sessionId: s.sessionId })}>释放线程</Button>
            </div>
          </div>
        ))}
        <div className="ui-rail-label">排队中</div>
        {snapshot.queue.length === 0 ? <div className="ui-muted">暂无排队任务</div> : snapshot.queue.map((q) => (
          <div key={q.queueId} className="ui-runtime-row">
            <div className="ui-runtime-main">
              <b>{q.profileName}</b>
              <span className="ui-muted">{q.profileName} · {q.label} · 第 {q.position} 位</span>
            </div>
            <Button size="sm" disabled={busy === `cancel:${q.queueId}`} onClick={() => void run(`cancel:${q.queueId}`, () => onCancelQueue(q.queueId))}>取消排队</Button>
          </div>
        ))}
      </div>
      <div className="ui-runtime-section">
        <div className="ui-rail-label">文档解析</div>
        <div className="ui-runtime-row">
          <div className="ui-runtime-main">{documentParseStatusLabel(parse)}</div>
          {parseAction ? <div className="ui-runtime-actions">{parseAction}</div> : null}
        </div>
        {parse.waiting.length > 0 && (
          <>
            <div className="ui-rail-label">等待中的文件</div>
            {parse.waiting.map((w, i) => (
              <div key={`${w.sessionId}:${w.fileName}:${i}`} className="ui-runtime-row">
                <div className="ui-runtime-main">
                  <span className="ui-muted">{w.agentDisplayName} · {w.fileName}</span>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
      <Modal open={confirm !== null} title={copy?.title ?? ''} onClose={() => setConfirm(null)}>
        <p>{copy?.body}</p>
        <Button variant={copy?.danger ? 'danger' : 'primary'} onClick={confirmAction}>{copy?.button}</Button>
      </Modal>
    </div>
  );
}
