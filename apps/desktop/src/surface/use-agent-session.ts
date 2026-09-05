import { useEffect, useRef, useState } from 'react';
import type { AgentSession, SessionEntry } from './contract.js';
import { applySurfaceEvent, deriveWorkflowTimeline, extractWorkflowResult } from './normalize.js';
import { applySnapshotThenBuffer, shouldRebuildOnCompaction, type SessionSnapshot } from './open-session.js';

const EMPTY: AgentSession = { entries: [], streaming: false, status: 'idle', meta: { currentStep: null } };

function withWorkflowFromEntries(
  session: AgentSession,
  entries: SessionEntry[],
  extra: Partial<AgentSession> = {},
): AgentSession {
  const timeline = deriveWorkflowTimeline(entries);
  return {
    ...session,
    ...extra,
    entries,
    status: timeline.status,
    result: extractWorkflowResult(entries),
    meta: {
      ...session.meta,
      ...extra.meta,
      currentStep: timeline.step ?? extra.meta?.currentStep ?? session.meta.currentStep,
    },
  };
}

function normalizeInputs(res: any): Array<{ path: string; name?: string; missing?: boolean }> | undefined {
  if (Array.isArray(res?.inputs)) {
    return res.inputs.map((i: any) => typeof i === 'string'
      ? { path: i }
      : {
          path: String(i?.path ?? ''),
          name: typeof i?.name === 'string' ? i.name : undefined,
          ...(i?.missing ? { missing: true } : {}),
        });
  }
  if (Array.isArray(res?.documents)) {
    return res.documents.map((i: any) => (typeof i === 'string' ? { path: i } : { path: String(i?.path ?? '') }));
  }
  return undefined;
}

/**
 * 一条会话只有一条数据面：先订阅、把事件缓冲住，再取一次快照，铺底那一下把快照和缓冲一起画上。
 *
 * `mode` 不在依赖里：从历史打开再续问不重开会话，否则新快照会把已画内容整表覆盖。
 */
export function useAgentSession(agentId: string, sessionId: string | null, _mode: 'live' | 'history'): AgentSession {
  const [session, setSession] = useState<AgentSession>(EMPTY);
  const generationRef = useRef(0);

  useEffect(() => {
    setSession(EMPTY);
    if (!sessionId) return;

    const api = (window as any).sparkii;
    let disposed = false;
    // 非 null 表示还在等快照：这段时间事件只进缓冲，不画时间线。
    let buffer: unknown[] | null = [];

    const open = () => {
      const generation = ++generationRef.current;
      buffer = [];
      const snapshot = api?.openChatSession?.(sessionId);
      if (!snapshot?.then) {
        buffer = null;
        return;
      }
      snapshot.then((res: SessionSnapshot & Record<string, unknown>) => {
        if (disposed || generation !== generationRef.current) return; // 快照和它的缓冲一起丢
        const pending = buffer ?? [];
        buffer = null;
        const entries = applySnapshotThenBuffer(res ?? {}, pending);
        const inputs = normalizeInputs(res);
        setSession((s) => withWorkflowFromEntries(s, entries, {
          streaming: Boolean(res?.streaming),
          meta: { ...s.meta, currentStep: (res as any)?.currentStep ?? null, inputs: inputs ?? s.meta.inputs },
        }));
      }).catch(() => {
        // 读取失败就是空会话，不打断 UI；放开闸门让后续事件照常画。
        if (disposed || generation !== generationRef.current) return;
        buffer = null;
      });
    };

    // 先听后取：订阅必须早于 openChatSession，否则起步那几拍会掉。
    const offChat = api?.on?.('chat-event', (p: any) => {
      if (p?.sessionId !== sessionId) return;
      if (p?.type === 'session_unbound') {
        // 进程卸下了，转圈停掉，但已画的时间线留着。
        setSession((s) => (s.streaming ? { ...s, streaming: false } : s));
        return;
      }
      if (shouldRebuildOnCompaction(p)) {
        open();
        return;
      }
      if (buffer) {
        buffer.push(p);
        return;
      }
      setSession((s) => {
        const entries = applySurfaceEvent(s.entries, p);
        let streaming = s.streaming;
        if (p?.type === 'agent_start') streaming = true;
        else if (p?.type === 'agent_end' || p?.type === 'agent_settled') streaming = false;
        return withWorkflowFromEntries(s, entries, { streaming });
      });
    });

    open();

    return () => {
      disposed = true;
      generationRef.current += 1;
      offChat?.();
    };
  }, [agentId, sessionId]);

  return session;
}
