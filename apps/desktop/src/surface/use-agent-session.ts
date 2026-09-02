import { useEffect, useState } from 'react';
import type { AgentSession } from './contract.js';
import { normalizeSessionEntries, applySurfaceEvent } from './normalize.js';

const EMPTY: AgentSession = { entries: [], streaming: false, status: 'idle', meta: { currentStep: null } };

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

    const offChat = (window as any).sparkii?.on?.('chat-event', (p: any) => {
      if (p?.sessionId !== sessionId || mode !== 'live') return;
      setSession((s) => ({
        ...s,
        entries: applySurfaceEvent(s.entries, p),
        streaming: p?.type === 'agent_start',
      }));
    });
    const offWorkflow = (window as any).sparkii?.on?.('workflow', (e: any) => {
      if (e?.sessionId !== sessionId) return;
      if (e.type === 'step_started') setSession((s) => ({ ...s, status: 'running', meta: { ...s.meta, currentStep: e.stepId } }));
      else if (e.type === 'workflow_completed') setSession((s) => ({ ...s, status: 'done' }));
      else if (e.type === 'workflow_failed') setSession((s) => ({ ...s, status: 'failed' }));
    });
    const offState = (window as any).sparkii?.on?.('state', (p: any) => {
      if (p?.sessionId !== sessionId) return;
      const result = (p?.workflow as Record<string, unknown> | undefined)?.result as Record<string, unknown> | undefined;
      if (result) setSession((s) => ({ ...s, result }));
    });
    return () => {
      open = false;
      offChat?.();
      offWorkflow?.();
      offState?.();
    };
  }, [agentId, sessionId, mode]);

  return session;
}
