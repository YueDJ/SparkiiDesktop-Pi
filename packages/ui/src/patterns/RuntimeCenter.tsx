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

function parsePageLabel(parse: DocumentParseSnapshot): string | undefined {
  if (parse.page == null) return undefined;
  if (parse.total != null && parse.total > 0) return `第 ${parse.page}/${parse.total} 页`;
  if (parse.page > 0) return `第 ${parse.page} 页`;
  return undefined;
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

function ParseCurrent({ parse }: { parse: DocumentParseSnapshot }) {
  const page = parse.status === 'parsing' ? parsePageLabel(parse) : undefined;
  let main = '';
  let secondary: string | undefined;
  switch (parse.status) {
    case 'stopped':
      main = '未启动';
      break;
    case 'starting':
      main = '正在加载';
      secondary = parse.fileName;
      break;
    case 'parsing':
      main = parse.fileName || '正在解析';
      break;
    case 'idle':
      main = '空闲';
      secondary = parse.idleRemainingSec == null ? undefined : formatIdleRemaining(parse.idleRemainingSec);
      break;
    case 'resident':
      main = '常驻';
      break;
  }

  return (
    <div className="ui-runtime-parse-current">
      <div className="ui-runtime-parse-main">{main}</div>
      {parse.status === 'parsing' && parse.fileName ? <div className="ui-runtime-parse-sub">正在解析</div> : null}
      {secondary ? <div className="ui-runtime-parse-sub">{secondary}</div> : null}
      {page ? <div className="ui-runtime-parse-sub">{page}</div> : null}
      {parse.status === 'parsing' && parse.total != null && parse.total > 0 ? (
        <progress className="ui-runtime-progress" aria-label="解析进度" max={parse.total} value={parse.page ?? 0} />
      ) : null}
    </div>
  );
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
  const idle = Math.max(0, snapshot.maxAgents - snapshot.active);
  const waitCells = Math.min(snapshot.queued, idle);
  const agentsEmpty = snapshot.sessions.length === 0 && snapshot.queue.length === 0;

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
      <section className="ui-runtime-section">
        <div className="ui-runtime-section-head">
          <h3>智能体</h3>
          <div className="ui-runtime-meter" role="img" aria-label={`运行 ${snapshot.active}，排队 ${snapshot.queued}，空闲 ${idle}`}>
            {Array.from({ length: snapshot.maxAgents }, (_, i) => {
              const cls = i < snapshot.active ? 'is-run' : i < snapshot.active + waitCells ? 'is-wait' : '';
              return <span key={i} className={cls} />;
            })}
          </div>
        </div>
        {agentsEmpty ? (
          <div className="ui-muted">暂无智能体占用</div>
        ) : (
          <>
            {snapshot.sessions.map((s) => (
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
            {snapshot.queue.map((q) => (
              <div key={q.queueId} className="ui-runtime-row">
                <div className="ui-runtime-main">
                  <span className="ui-runtime-pos" aria-label={`第 ${q.position} 位`}>{q.position}</span>
                  <b>{q.profileName}</b>
                  <span className="ui-muted">{q.label}</span>
                </div>
                <Button size="sm" disabled={busy === `cancel:${q.queueId}`} onClick={() => void run(`cancel:${q.queueId}`, () => onCancelQueue(q.queueId))}>取消排队</Button>
              </div>
            ))}
          </>
        )}
      </section>
      <section className="ui-runtime-section">
        <div className="ui-runtime-section-head">
          <h3>文档解析</h3>
          {parseAction}
        </div>
        <div className="ui-runtime-row">
          <div className="ui-runtime-main">
            <ParseCurrent parse={parse} />
          </div>
        </div>
        {parse.waiting.map((w, i) => (
          <div key={`${w.sessionId}:${w.fileName}:${i}`} className="ui-runtime-row">
            <div className="ui-runtime-parse-wait">
              <div>{w.fileName}</div>
              <div className="ui-muted">{w.agentDisplayName}</div>
            </div>
          </div>
        ))}
      </section>
      <Modal open={confirm !== null} title={copy?.title ?? ''} onClose={() => setConfirm(null)}>
        <p>{copy?.body}</p>
        <Button variant={copy?.danger ? 'danger' : 'primary'} onClick={confirmAction}>{copy?.button}</Button>
      </Modal>
    </div>
  );
}
