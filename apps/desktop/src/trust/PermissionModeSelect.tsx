import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ChevronDownIcon, Menu, MenuItem, ShieldIcon } from '@sparkii/ui';
import type { PermissionModeState, SparkiiApi } from '../types/sparkii-api.js';

type PermissionMode = PermissionModeState['mode'];

const MODES: Array<{ id: PermissionMode; label: string; hint: string }> = [
  { id: 'ask', label: '每次询问', hint: '需要时停下来确认' },
  { id: 'auto_review', label: '自动审查', hint: '外部写入仍需确认' },
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

export function PermissionModeSelect() {
  const { state, setMode } = usePermissionMode();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const current = MODES.find((entry) => entry.id === state.mode) ?? MODES[0];
  const close = () => setOpen(false);

  return (
    <div ref={wrapperRef} className="permission-mode-select">
      <button
        type="button"
        role="combobox"
        className="permission-mode-select-trigger"
        data-testid="permission-mode-trigger"
        aria-label={`审批方式：${current.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={current.hint}
        onClick={() => setOpen((value) => !value)}
      >
        <ShieldIcon />
        <span className="permission-mode-select-label">{current.label}</span>
        <ChevronDownIcon />
      </button>
      {open && (
        <Menu open onClose={close} containerRef={wrapperRef} placement="top" align="start">
          {MODES.map((entry) => {
            const active = state.mode === entry.id;
            const allowed = state.allowedModes.includes(entry.id);
            return (
              <MenuItem
                key={entry.id}
                label={entry.label}
                hint={entry.hint}
                trailing={active ? '✓' : ''}
                current={active}
                disabled={!allowed}
                onSelect={() => {
                  close();
                  void setMode(entry.id);
                }}
              />
            );
          })}
        </Menu>
      )}
    </div>
  );
}
