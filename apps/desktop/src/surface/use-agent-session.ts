import { useEffect, useState } from 'react';
import type { AgentSession } from './contract.js';
import { normalizeSessionEntries, applySurfaceEvent } from './normalize.js';
import { normalizeMessages as uiNormalizeMessages } from '@sparkii/ui';

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
        const rawEntries = Array.isArray(res?.entries) ? res.entries : undefined;
        const rawMessages = Array.isArray(res?.messages) ? res.messages : undefined;
        const entries = rawEntries?.length
          ? normalizeSessionEntries(rawEntries)
          : rawMessages?.length
            ? uiNormalizeMessages(rawMessages)
            : [];
        const inputs = Array.isArray(res?.inputs)
          ? res.inputs.map((i: any) => typeof i === 'string'
            ? { path: i }
            : { path: String(i?.path ?? ''), name: typeof i?.name === 'string' ? i.name : undefined })
          : Array.isArray(res?.documents)
            ? res.documents.map((i: any) => typeof i === 'string'
              ? { path: i }
              : { path: String(i?.path ?? '') })
            : undefined;
        setSession((s) => ({
          ...s,
          entries,
          streaming: Boolean(res?.streaming),
          meta: { ...s.meta, currentStep: res?.currentStep ?? null, inputs: inputs ?? s.meta.inputs },
        }));
      })
      .catch(() => {
        // 读取失败保持空会话，不打断 UI
      });

    const offChat = (window as any).sparkii?.on?.('chat-event', (p: any) => {
      if (p?.sessionId !== sessionId || mode !== 'live') return;
      setSession((s) => {
        const entries = applySurfaceEvent(s.entries, p);
        let streaming = s.streaming;
        if (p?.type === 'agent_start') streaming = true;
        else if (p?.type === 'agent_end' || p?.type === 'agent_settled') streaming = false;
        return { ...s, entries, streaming };
      });
    });
    const offWorkflow = (window as any).sparkii?.on?.('workflow', (e: any) => {
      if (e?.sessionId !== sessionId || mode !== 'live') return;
      if (e.type === 'step_started') setSession((s) => ({ ...s, status: 'running', meta: { ...s.meta, currentStep: e.stepId } }));
      else if (e.type === 'workflow_completed') setSession((s) => ({ ...s, status: 'done' }));
      else if (e.type === 'workflow_failed') setSession((s) => ({ ...s, status: 'failed' }));
    });
    const offState = (window as any).sparkii?.on?.('state', (p: any) => {
      if (p?.sessionId !== sessionId || mode !== 'live') return;
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
