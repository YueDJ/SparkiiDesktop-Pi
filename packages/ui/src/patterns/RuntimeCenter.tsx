import { useState } from 'react';
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

type ConfirmState = { kind: 'stop' | 'release'; sessionId: string } | null;

export function RuntimeCenter({
  snapshot,
  onStop,
  onRelease,
  onCancelQueue,
}: {
  snapshot: RuntimePoolSummary;
  onStop(sessionId: string): Promise<void> | void;
  onRelease(sessionId: string): Promise<void> | void;
  onCancelQueue(queueId: string): Promise<void> | void;
}) {
  const { reportError } = useErrors();
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, action: () => Promise<void> | void) => {
    setBusy(key);
    try {
      await action();
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e), { source: '运行中心' });
    } finally {
      setBusy(null);
    }
  };

  const confirmAction = () => {
    if (!confirm) return;
    if (confirm.kind === 'stop') void run(`stop:${confirm.sessionId}`, () => onStop(confirm.sessionId));
    else void run(`release:${confirm.sessionId}`, () => onRelease(confirm.sessionId));
    setConfirm(null);
  };

  const statusLabel = (status: RuntimeCenterStatus) =>
    status === 'running' ? '生成中' : status === 'waiting-approval' ? '等待审批' : '空闲占用';

  return (
    <div className="ui-runtime-center">
      <div className="ui-runtime-summary">
        运行 {snapshot.active}/{snapshot.maxAgents} · 排队 {snapshot.queued} · 空闲 {Math.max(0, snapshot.maxAgents - snapshot.active)}
      </div>
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
      <Modal open={confirm !== null} title={confirm?.kind === 'stop' ? '停止会话' : '释放线程'} onClose={() => setConfirm(null)}>
        <p>{confirm?.kind === 'stop' ? '确认中断当前这一轮？会话和线程会保留。' : '确认释放线程？会话记录会保留，工作进程将被复用。'}</p>
        <Button variant={confirm?.kind === 'release' ? 'danger' : 'primary'} onClick={confirmAction}>确认{confirm?.kind === 'stop' ? '停止' : '释放'}</Button>
      </Modal>
    </div>
  );
}
