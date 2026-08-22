import { createHash, randomUUID } from 'node:crypto';
import type { SideEffect } from '@sparkii/connectors';

export type ProposalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'executed' | 'failed';
export interface ProposalRequest { toolName: string; targetSystem: string; summary: string; payload: unknown; risk: SideEffect; }
export interface Proposal {
  id: string; profileId: string; sessionId: string;
  toolName: string; targetSystem: string; summary: string;
  payloadHash: string; payload: unknown; risk: SideEffect;
  status: ProposalStatus; createdAt: number;
  decidedAt?: number; decisionBy?: string; decisionNote?: string;
  execution?: { ok: boolean; result?: unknown; error?: string };
}

export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, val]) => [k, sort(val)]));
    return v;
  };
  return JSON.stringify(sort(value));
}
export function hashPayload(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export function summarizePayload(value: unknown, maxLen = 512): string {
  const s = canonicalJson(value);
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

export function createProposal(req: ProposalRequest, meta: { profileId: string; sessionId: string }): Proposal {
  return {
    id: randomUUID(), ...meta, toolName: req.toolName, targetSystem: req.targetSystem,
    summary: req.summary, payloadHash: hashPayload(req.payload), payload: req.payload,
    risk: req.risk, status: 'pending', createdAt: Date.now(),
  };
}

const allowed: Record<ProposalStatus, ProposalStatus[]> = {
  pending: ['approved', 'denied', 'expired'],
  approved: ['executed', 'failed'],
  denied: [], expired: [], executed: [], failed: [],
};

export function transition(p: Proposal, to: Exclude<ProposalStatus, 'pending'>): Proposal {
  if (!allowed[p.status].includes(to)) throw new Error(`illegal proposal transition ${p.status} -> ${to}`);
  return { ...p, status: to, decidedAt: to === 'denied' || to === 'expired' || to === 'executed' || to === 'failed' ? Date.now() : p.decidedAt };
}
