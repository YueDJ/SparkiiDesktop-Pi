import { useEffect, useRef, useState } from 'react';
import type { AgentSession, SessionEntry } from './contract.js';
import { applySurfaceEvent, deriveWorkflowTimeline, extractWorkflowResult } from './normalize.js';
import { applySnapshotThenBuffer, shouldRebuildOnCompaction, type SessionSnapshot } from './open-session.js';

const EMPTY: AgentSession = { entries: [], streaming: false, status: 'idle', meta: { currentStep: null } };
const PENDING_CAP = 200;

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

function applyLiveEvent(session: AgentSession, p: any): AgentSession {
  const entries = applySurfaceEvent(session.entries, p);
  let streaming = session.streaming;
  if (p?.type === 'agent_start') streaming = true;
  else if (p?.type === 'agent_end' || p?.type === 'agent_settled') streaming = false;
  return withWorkflowFromEntries(session, entries, { streaming });
}

/**
 * 一条会话只有一条数据面：先订阅、把事件缓冲住，再取一次快照，铺底那一下把快照和缓冲一起画上。
 *
 * 草稿（sessionId 还是 null）也要听：合同点「开始审核」时 loop 已经在跑，id 要等 runWorkflow
 * 返回后才 bind。若这时候拆掉订阅，步骤行会在「先听后取」之前溜走；切到历史再回来才会重新起步。
 *
 * `mode` 不在依赖里：从历史打开再续问不重开会话，否则新快照会把已画内容整表覆盖。
 */
export function useAgentSession(agentId: string, sessionId: string | null, _mode: 'live' | 'history'): AgentSession {
  const [session, setSession] = useState<AgentSession>(EMPTY);
  const generationRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  // 非 null 表示还在等快照：这段时间事件只进缓冲，不画时间线。有 id 的首次挂载就要闸上，
  // 否则 Effect 订阅和取快照之间那一拍会先画再被 EMPTY 擦掉。
  const bufferRef = useRef<unknown[] | null>(sessionId ? [] : null);
  // 草稿帧收到的、还不知道归哪条会话的事件。bind 时按 id 捞进这一次打开的缓冲。
  const pendingRef = useRef<unknown[]>([]);
  const takeSnapshotRef = useRef<() => void>(() => {});

  if (sessionIdRef.current !== sessionId) {
    // bind / 换会话发生在这一拍：立刻改过滤器和闸门，避免 render→effect 之间的事件先画再被 EMPTY 擦掉。
    sessionIdRef.current = sessionId;
    bufferRef.current = sessionId ? [] : null;
  }

  takeSnapshotRef.current = () => {
    const sid = sessionIdRef.current;
    const api = (window as any).sparkii;
    if (!sid) {
      bufferRef.current = null;
      return;
    }
    const generation = ++generationRef.current;
    const arrived = bufferRef.current ?? [];
    const pending = pendingRef.current.filter((p: any) => p?.sessionId === sid);
    pendingRef.current = pendingRef.current.filter((p: any) => p?.sessionId !== sid);
    bufferRef.current = [...pending, ...arrived];
    const snapshot = api?.openChatSession?.(sid);
    const apply = (res: (SessionSnapshot & Record<string, unknown>) | null) => {
      if (generation !== generationRef.current) return;
      const buffered = bufferRef.current ?? [];
      bufferRef.current = null;
      const entries = applySnapshotThenBuffer(res ?? {}, buffered);
      const inputs = res ? normalizeInputs(res) : undefined;
      setSession((s) => withWorkflowFromEntries(s, entries, {
        streaming: Boolean(res?.streaming),
        meta: { ...s.meta, currentStep: (res as any)?.currentStep ?? null, inputs: inputs ?? s.meta.inputs },
      }));
    };
    if (!snapshot?.then) {
      apply(null);
      return;
    }
    snapshot.then((res: SessionSnapshot & Record<string, unknown>) => {
      apply(res ?? {});
    }).catch(() => {
      // 读取失败就是空会话，不打断 UI；缓冲里已有的步骤行仍要铺上，并放开闸门。
      if (generation !== generationRef.current) return;
      apply({});
    });
  };

  useEffect(() => {
    const api = (window as any).sparkii;
    // 按 agent 订一次。sessionId 从 null bind 成正式 id 时不能拆管，否则点火后、bind 前的步骤行会丢。
    const offChat = api?.on?.('chat-event', (p: any) => {
      const sid = sessionIdRef.current;
      if (!sid) {
        if (!p?.sessionId) return;
        pendingRef.current.push(p);
        if (pendingRef.current.length > PENDING_CAP) pendingRef.current.shift();
        return;
      }
      if (p?.sessionId !== sid) return;
      if (p?.type === 'session_unbound') {
        // 进程卸下了，转圈停掉，但已画的时间线留着。
        setSession((s) => (s.streaming ? { ...s, streaming: false } : s));
        return;
      }
      if (shouldRebuildOnCompaction(p)) {
        takeSnapshotRef.current();
        return;
      }
      if (bufferRef.current) {
        bufferRef.current.push(p);
        return;
      }
      setSession((s) => applyLiveEvent(s, p));
    });
    return () => {
      offChat?.();
    };
  }, [agentId]);

  useEffect(() => {
    setSession(EMPTY);
    if (!sessionId) {
      generationRef.current += 1;
      bufferRef.current = null;
      return;
    }
    takeSnapshotRef.current();
    return () => {
      generationRef.current += 1;
      bufferRef.current = null;
    };
  }, [agentId, sessionId]);

  return session;
}
