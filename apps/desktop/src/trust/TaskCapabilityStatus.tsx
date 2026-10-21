import type { TaskCapabilityStatus as TaskCapabilityStatusValue } from '../types/sparkii-api.js';

export function TaskCapabilityStatus({
  status,
  onRevoke,
  revoking = false,
}: {
  status: TaskCapabilityStatusValue;
  onRevoke?: () => void;
  revoking?: boolean;
}) {
  if (!status.active) {
    return (
      <div className="task-capability-status" aria-live="polite">
        <span className="task-capability-status-copy">
          任务权限将在发送消息后建立
        </span>
      </div>
    );
  }

  const network = status.networkDomains?.length
    ? `网络：${status.networkDomains.join('、')}`
    : '无网络';
  const external = status.externalCapabilities?.length
    ? `外部能力：${status.externalCapabilities.join('、')}`
    : '外部系统未授权';

  return (
    <div className="task-capability-status" aria-label="当前任务权限">
      <div className="task-capability-status-row">
        <span className="task-capability-badge is-positive">工作区可写</span>
        <span className={`task-capability-badge ${status.processExec ? 'is-positive' : 'is-muted'}`}>
          {status.processExec ? '沙箱内命令' : '命令执行未启用'}
        </span>
        <span className="task-capability-badge is-muted">{network}</span>
        <span className="task-capability-badge is-muted">{external}</span>
        {onRevoke && (
          <button
            type="button"
            className="task-capability-revoke"
            onClick={onRevoke}
            disabled={revoking}
          >
            {revoking ? '正在撤销…' : '撤销本任务权限'}
          </button>
        )}
      </div>
      {status.limitations?.length ? (
        <p className="task-capability-limitation">
          安全能力受限：{status.limitations.join('；')}
        </p>
      ) : null}
    </div>
  );
}
