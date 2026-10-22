import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { PermissionModeState, SparkiiApi } from '../types/sparkii-api.js';

type PermissionMode = PermissionModeState['mode'];

const MODES: Array<{ id: PermissionMode; label: string; hint: string }> = [
  { id: 'ask', label: 'Ask', hint: '需要我确认有风险的操作' },
  { id: 'auto_review', label: 'Auto review', hint: '让平台单独审查有风险的操作' },
];

const DEFAULT_STATE: PermissionModeState = {
  mode: 'ask',
  allowedModes: ['ask', 'auto_review'],
  taskActive: false,
  hostShellAvailable: false,
  reviewerAvailable: false,
  limitations: [],
};

interface PermissionModeValue {
  state: PermissionModeState;
  setMode(mode: PermissionMode): Promise<void>;
}

const Context = createContext<PermissionModeValue>({
  state: DEFAULT_STATE,
  async setMode() {},
});

export function PermissionModeProvider(props: {
  api: SparkiiApi;
  agentId: string;
  sessionId: string | null;
  children: ReactNode;
}) {
  const { api, agentId, sessionId } = props;
  const [state, setState] = useState<PermissionModeState>(DEFAULT_STATE);
  /** A draft has no session yet, so its choice stays local until the first prompt. */
  const [draftMode, setDraftMode] = useState<PermissionMode | null>(null);

  useEffect(() => {
    let alive = true;
    void api.getPermissionModeState(agentId, sessionId).then((next) => {
      if (alive) setState(next);
    }).catch(() => {
      if (alive) {
        setState((prev) => ({
          ...prev,
          mode: 'ask',
          limitations: [...prev.limitations, '权限状态读取失败，已按 Ask 运行'],
        }));
      }
    });
    return () => { alive = false; };
  }, [api, agentId, sessionId]);

  useEffect(() => {
    const offMode = api.on('permission-mode', (raw: unknown) => {
      const next = (raw ?? {}) as Partial<PermissionModeState>;
      setState((prev) => ({ ...prev, ...next }));
    });
    const offEvent = api.on('permission-event', (raw: unknown) => {
      const event = (raw ?? {}) as Record<string, unknown>;
      if (typeof event.decision !== 'string') return;
      setState((prev) => ({
        ...prev,
        reviewerAvailable: true,
        lastReview: {
          decision: event.decision as 'allow' | 'ask' | 'deny',
          risk: String(event.risk ?? ''),
          reason: String(event.reason ?? ''),
        },
      }));
    });
    return () => { offMode?.(); offEvent?.(); };
  }, [api]);

  const setMode = useCallback(async (mode: PermissionMode) => {
    const allowedModes = state.allowedModes;
    if (!allowedModes.includes(mode)) return;
    if (!sessionId) {
      setDraftMode(mode);
      return;
    }
    try {
      const out = await api.setChatPermissionMode(sessionId, mode);
      if (!out.ok) throw new Error(out.error ?? 'permission mode change rejected');
      setState((prev) => ({ ...prev, mode }));
    } catch {
      setState((prev) => ({
        ...prev,
        mode: 'ask',
        limitations: [...prev.limitations, '权限模式切换失败，已回退到 Ask'],
      }));
    }
  }, [api, sessionId, state.allowedModes]);

  const value = useMemo<PermissionModeValue>(() => ({
    state: sessionId ? state : { ...state, mode: draftMode ?? state.mode },
    setMode,
  }), [draftMode, sessionId, setMode, state]);

  return <Context.Provider value={value}>{props.children}</Context.Provider>;
}

export function usePermissionMode(): PermissionModeValue {
  return useContext(Context);
}

export function PermissionModeBar() {
  const { state, setMode } = usePermissionMode();
  return (
    <div className="permission-mode-bar" aria-label="平台权限模式">
      <div className="permission-mode-bar-modes" role="group" aria-label="权限模式">
        {MODES.map((entry) => {
          const active = state.mode === entry.id;
          const allowed = state.allowedModes.includes(entry.id);
          return (
            <button
              key={entry.id}
              type="button"
              className={`permission-mode-chip${active ? ' is-active' : ''}`}
              aria-pressed={active}
              disabled={!allowed}
              title={allowed ? entry.hint : '当前智能体不提供此模式'}
              onClick={() => { void setMode(entry.id); }}
            >
              {entry.label}
            </button>
          );
        })}
      </div>
      <div className="permission-mode-bar-facts">
        <span className="permission-mode-fact">Host Git Bash · 宿主执行，非沙箱</span>
        <span className="permission-mode-fact">网络由宿主进程决定</span>
        <span className={`permission-mode-fact${state.hostShellAvailable ? ' is-positive' : ' is-muted'}`}>
          {state.hostShellAvailable ? '命令执行可用' : '命令执行未启用'}
        </span>
        <span className={`permission-mode-fact${state.reviewerAvailable ? ' is-positive' : ' is-muted'}`}>
          {state.reviewerAvailable
            ? 'Reviewer 可用'
            : (state.mode === 'auto_review'
              ? 'Reviewer 不可用，已回退到人工审批'
              : 'Reviewer 不可用')}
        </span>
        {state.lastReview && (
          <span className="permission-mode-fact">
            {`最近审查：${state.lastReview.decision} / ${state.lastReview.risk} / ${state.lastReview.reason}`}
          </span>
        )}
      </div>
    </div>
  );
}
