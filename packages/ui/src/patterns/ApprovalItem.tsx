import type { ReactNode } from 'react';

export function ApprovalItem({
  title,
  badge,
  countdown,
  meta,
  onOpenDetail,
}: {
  title: string;
  badge?: ReactNode;
  countdown?: ReactNode;
  meta?: ReactNode;
  onOpenDetail(): void;
}) {
  const hasChrome = badge != null || countdown != null;
  return (
    <div className="ui-approval-item">
      <div className="ui-approval-item-main">
        <b>{title}</b>
        {meta ? <div className="ui-muted">{meta}</div> : null}
      </div>
      {hasChrome && (
        <span className="ui-approval-item-meta">
          {badge}
          {badge != null && countdown != null ? ' · ' : null}
          {countdown != null ? <span>{countdown}</span> : null}
        </span>
      )}
      <button type="button" className="ui-btn ui-btn--sm ui-btn--primary" onClick={onOpenDetail}>详情</button>
    </div>
  );
}
