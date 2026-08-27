import { RiskBadge } from './RiskBadge.js';

export function ApprovalItem({ summary, risk, toolName, sessionId, countdownText, onOpenDetail }: { summary: string; risk: string; toolName?: string; sessionId?: string; countdownText: string; onOpenDetail(): void }) {
  return (
    <div className="ui-approval-item">
      <div className="ui-approval-item-main"><b>{summary}</b><div className="ui-muted">{toolName}{sessionId ? ` · 会话 ${sessionId.slice(0, 8)}` : ''}</div></div>
      <span className="ui-approval-item-meta"><RiskBadge risk={risk} /> · {countdownText}</span>
      <button type="button" className="ui-btn ui-btn--sm ui-btn--primary" onClick={onOpenDetail}>详情</button>
    </div>
  );
}
