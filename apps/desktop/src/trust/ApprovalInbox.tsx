import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Proposal } from '@sparkii/approval';
import type { SparkiiApi } from '../types/sparkii-api.js';

export type ApprovalDecisionResult =
  | { ok: true; status: 'approved' | 'denied' }
  | { ok: false; status: 'expired' | 'failed'; error: { code: string; message: string } };

interface InboxValue {
  proposals: ReadonlyMap<string, Proposal>;
  claimed: ReadonlySet<string>;
  claim(id: string): void;
  release(id: string): void;
  decide(id: string, approved: boolean, note?: string): Promise<ApprovalDecisionResult>;
  onDecided(cb: () => void): () => void;
}

const InboxContext = createContext<InboxValue | null>(null);

function isPendingProposal(value: unknown): value is Proposal {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.id === 'string'
    && typeof rec.requestId === 'string'
    && typeof rec.sessionId === 'string'
    && rec.status === 'pending';
}

export function ApprovalInboxProvider({ api, children }: { api: SparkiiApi; children: ReactNode }) {
  const [proposals, setProposals] = useState<Map<string, Proposal>>(new Map());
  const [claimed, setClaimed] = useState<Set<string>>(new Set());
  const decidedCbs = useRef(new Set<() => void>());

  const refresh = useCallback(async () => {
    const list = (await api.listPendingApprovals()) as unknown[];
    const next = new Map<string, Proposal>();
    for (const item of list) {
      if (isPendingProposal(item)) next.set(item.id, item);
    }
    setProposals(next);
  }, [api]);

  useEffect(() => {
    void refresh();
    return api.on('approval', (raw: unknown) => {
      if (!isPendingProposal(raw)) {
        const id = (raw as Record<string, unknown> | undefined)?.id;
        if (typeof id === 'string') {
          setProposals((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Map(prev);
            next.delete(id);
            return next;
          });
          setClaimed((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }
        return;
      }
      setProposals((prev) => {
        const next = new Map(prev);
        next.set(raw.id, raw);
        return next;
      });
    });
  }, [refresh, api]);

  const claim = useCallback((id: string) => {
    setClaimed((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const release = useCallback((id: string) => {
    setClaimed((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const onDecided = useCallback((cb: () => void) => {
    decidedCbs.current.add(cb);
    return () => { decidedCbs.current.delete(cb); };
  }, []);

  const decide = useCallback(async (id: string, approved: boolean, note?: string): Promise<ApprovalDecisionResult> => {
    setProposals((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    try {
      await api.decideApproval(id, approved, note);
      for (const cb of decidedCbs.current) cb();
      return { ok: true, status: approved ? 'approved' : 'denied' };
    } catch (e) {
      await refresh();
      const err = e as Error;
      return { ok: false, status: 'failed', error: { code: err.name, message: err.message } };
    }
  }, [api, refresh]);

  const value = useMemo<InboxValue>(() => ({
    proposals,
    claimed,
    claim,
    release,
    decide,
    onDecided,
  }), [proposals, claimed, claim, release, decide, onDecided]);

  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>;
}

export function useApprovalInbox(): InboxValue {
  const value = useContext(InboxContext);
  if (!value) throw new Error('useApprovalInbox must be used within ApprovalInboxProvider');
  return value;
}

export function useSessionApprovals(sessionId: string | null) {
  const { proposals, decide } = useApprovalInbox();
  const waiting = useMemo(() => {
    if (sessionId == null) return [];
    return [...proposals.values()].filter((p) =>
      p.sessionId === sessionId && p.status === 'pending' && p.risk !== 'high-risk',
    );
  }, [proposals, sessionId]);
  return {
    waiting,
    approve: (id: string, opts?: { note?: string }) => decide(id, true, opts?.note),
    reject: (id: string, opts?: { note?: string }) => decide(id, false, opts?.note),
  };
}
