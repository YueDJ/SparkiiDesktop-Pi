export type RiskLevel = 'high' | 'mid' | 'low';

export interface RiskInfo { level: RiskLevel; label: string; cls: string; }

export function riskInfo(risk: string | undefined): RiskInfo {
  if (risk === 'high-risk') return { level: 'high', label: '高风险', cls: 'risk-high' };
  if (risk === 'read') return { level: 'low', label: '低风险', cls: 'risk-low' };
  return { level: 'mid', label: '中风险', cls: 'risk-mid' };
}

export function payloadSummary(payload: unknown): string {
  if (payload === undefined || payload === null) return '{}';
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

export interface ApprovalProposalLike {
  id: string;
  summary: string;
  risk: string;
  createdAt: number;
  toolName?: string;
  targetSystem?: string;
  payload?: unknown;
  payloadHash?: string;
  sessionId?: string;
  profileId?: string;
}
