import { useEffect, useState } from 'react';
import type { AgentSession } from './contract.js';
import { normalizeSessionEntries, applySurfaceEvent } from './normalize.js';

const EMPTY: AgentSession = { entries: [], streaming: false, meta: { currentStep: null } };

export function useAgentSession(agentId: string, sessionId: string | null, mode: 'live' | 'history'): AgentSession {
  const [session, setSession] = useState<AgentSession>(EMPTY);

  useEffect(() => {
    setSession(EMPTY);
    if (!sessionId) return;

    let open = true;
    (window as any).sparkii?.openChatSession?.(sessionId)
      .then((res: any) => {
        if (!open) return;
        const entries = normalizeSessionEntries(res?.entries ?? res?.messages ?? []);
        setSession({
          entries,
          streaming: Boolean(res?.streaming),
          meta: { currentStep: res?.currentStep ?? null },
        });
      })
      .catch(() => {
        // 读取失败保持空会话，不打断 UI
      });

    const off = (window as any).sparkii?.on?.('chat-event', (p: any) => {
      if (p?.sessionId !== sessionId || mode !== 'live') return;
      setSession((s) => ({
        ...s,
        entries: applySurfaceEvent(s.entries, p),
        streaming: p?.type === 'agent_start',
      }));
    });
    return () => {
      open = false;
      off?.();
    };
  }, [agentId, sessionId, mode]);

  return session;
}
