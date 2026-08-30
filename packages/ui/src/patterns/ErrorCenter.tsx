import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '../primitives/Button.js';
import { IconButton } from '../primitives/IconButton.js';
import { CloseIcon, WarningIcon } from '../icons/index.js';

export interface ErrorRecord {
  id: string;
  message: string;
  source: string;
  createdAt: number;
  read: boolean;
}

export interface ErrorStoreAdapter {
  load(): Promise<ErrorRecord[]>;
  append(rec: Omit<ErrorRecord, 'read'>): Promise<ErrorRecord>;
  clearOne(id: string): Promise<void>;
  clearAll(): Promise<void>;
  markAllRead(): Promise<void>;
}

export function createMemoryErrorStore(): ErrorStoreAdapter {
  let records: ErrorRecord[] = [];
  return {
    load: async () => records,
    append: async (rec) => {
      const next: ErrorRecord = { ...rec, read: false };
      records = [next, ...records];
      return next;
    },
    clearOne: async (id) => {
      records = records.filter((r) => r.id !== id);
    },
    clearAll: async () => {
      records = [];
    },
    markAllRead: async () => {
      records = records.map((r) => ({ ...r, read: true }));
    },
  };
}

interface ErrorsValue {
  records: ErrorRecord[];
  unreadCount: number;
  toast: ErrorRecord | null;
  reportError(message: string, opts?: { source?: string }): void;
  dismissToast(id: string): void;
  clearOne(id: string): void;
  clearAll(): void;
  markAllRead(): void;
}

const ErrorsContext = createContext<ErrorsValue | null>(null);

const NOOP: ErrorsValue = {
  records: [],
  unreadCount: 0,
  toast: null,
  reportError: () => {},
  dismissToast: () => {},
  clearOne: () => {},
  clearAll: () => {},
  markAllRead: () => {},
};

export function useErrors(): ErrorsValue {
  return useContext(ErrorsContext) ?? NOOP;
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `err-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ErrorProvider({ store, children }: { store: ErrorStoreAdapter; children: ReactNode }) {
  const [records, setRecords] = useState<ErrorRecord[]>([]);
  const [toast, setToast] = useState<ErrorRecord | null>(null);

  useEffect(() => {
    let cancelled = false;
    store.load().then((list) => {
      if (!cancelled) setRecords(list);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [store]);

  const reportError = useCallback((message: string, opts?: { source?: string }) => {
    const rec: ErrorRecord = {
      id: makeId(),
      message,
      source: opts?.source ?? '通用智能体',
      createdAt: Date.now(),
      read: false,
    };
    setRecords((prev) => [rec, ...prev]);
    setToast(rec);
    store.append(rec).catch(() => {});
  }, [store]);

  const dismissToast = useCallback((id: string) => {
    setToast((cur) => (cur?.id === id ? null : cur));
  }, []);

  const clearOne = useCallback((id: string) => {
    setRecords((prev) => prev.filter((r) => r.id !== id));
    store.clearOne(id).catch(() => {});
  }, [store]);

  const clearAll = useCallback(() => {
    setRecords([]);
    store.clearAll().catch(() => {});
  }, [store]);

  const markAllRead = useCallback(() => {
    setRecords((prev) => prev.map((r) => (r.read ? r : { ...r, read: true })));
    store.markAllRead().catch(() => {});
  }, [store]);

  const unreadCount = useMemo(() => records.filter((r) => !r.read).length, [records]);

  const value = useMemo<ErrorsValue>(() => ({
    records,
    unreadCount,
    toast,
    reportError,
    dismissToast,
    clearOne,
    clearAll,
    markAllRead,
  }), [records, unreadCount, toast, reportError, dismissToast, clearOne, clearAll, markAllRead]);

  return (
    <ErrorsContext.Provider value={value}>
      {children}
      <ErrorToaster />
    </ErrorsContext.Provider>
  );
}

export function ErrorToaster() {
  const { toast, dismissToast } = useErrors();
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!toast || paused) return;
    const timer = setTimeout(() => dismissToast(toast.id), 5000);
    return () => clearTimeout(timer);
  }, [toast, paused, dismissToast]);

  if (!toast) return null;

  return (
    <div
      className="ui-error-toast"
      role="alert"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <WarningIcon />
      <div className="ui-error-toast-msg">{toast.message}</div>
      <button type="button" className="ui-error-toast-close" aria-label="关闭" onClick={() => dismissToast(toast.id)}>
        <CloseIcon />
      </button>
    </div>
  );
}

export function ErrorCenterPanel() {
  const { records, unreadCount, clearOne, clearAll, markAllRead } = useErrors();

  return (
    <div className="ui-error-center">
      <div className="ui-error-center-actions">
        <Button size="sm" onClick={markAllRead} disabled={unreadCount === 0}>全部标为已读</Button>
        <Button size="sm" variant="danger" onClick={clearAll} disabled={records.length === 0}>全部清空</Button>
      </div>
      {records.length === 0 ? (
        <div className="ui-muted">暂无报错记录</div>
      ) : (
        <div className="ui-error-center-list">
          {records.map((r) => (
            <div key={r.id} className={`ui-error-center-row${r.read ? '' : ' ui-error-center-row--unread'}`}>
              <WarningIcon />
              <div className="ui-error-center-main">
                <div className="ui-error-center-msg">{r.message}</div>
                <div className="ui-error-center-meta">{r.source} · {formatTime(r.createdAt)}</div>
              </div>
              <IconButton label="删除" size="sm" onClick={() => clearOne(r.id)}><CloseIcon /></IconButton>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
