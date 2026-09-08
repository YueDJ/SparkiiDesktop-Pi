import { Drawer } from '@sparkii/ui';
import { ApprovalCard } from './ApprovalCard.js';
import { useApprovalInbox } from './ApprovalInbox.js';

export interface ApprovalDrawerProps {
  open: boolean;
  currentSessionId?: string | null;
  onClose(): void;
}

export function ApprovalDrawer({ open, currentSessionId = null, onClose }: ApprovalDrawerProps) {
  const { proposals, claimed, decide } = useApprovalInbox();
  const unclaimed = [...proposals.values()].filter((p) => p.risk !== 'high-risk' && !claimed.has(p.id));
  const current = unclaimed.filter((p) => p.sessionId === currentSessionId);
  const others = unclaimed.filter((p) => p.sessionId !== currentSessionId);

  return (
    <Drawer open={open} fixed title="需要你确认" onClose={onClose} className="ui-approval-drawer">
      <div className="ui-approval-qhead">
        <b>{unclaimed.length ? `${unclaimed.length} 处改动等你看` : '暂无待确认'}</b>
      </div>
      <div className="ui-approval-queue">
        {unclaimed.length === 0 ? (
          <div className="ui-muted ui-approval-empty">没有待确认的事项</div>
        ) : (
          <>
            {current.length > 0 && (
              <section className="ui-approval-group">
                <div className="ui-approval-group-title">当前会话</div>
                {current.map((p) => (
                  <ApprovalCard key={p.id} proposal={p} onDecide={(id, ok, note) => { void decide(id, ok, note); }} />
                ))}
              </section>
            )}
            {others.length > 0 && (
              <section className="ui-approval-group">
                <div className="ui-approval-group-title">其他会话</div>
                {others.map((p) => (
                  <ApprovalCard key={p.id} proposal={p} onDecide={(id, ok, note) => { void decide(id, ok, note); }} />
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}
