/** 更新失败一律给一句人能看懂的话；代码与阶段名只写日志/审计。 */
const FAILURE_TEXT: Record<string, string> = {
  INVALID_BASE_URL: '更新源地址无效，请检查地址格式',
  CHOICE_REQUIRED: '有两个版本可选，请先选择其中一个',
  MIN_SUPPORTED: '当前版本过低，无法通过自动更新升级',
  ARTIFACT_INVALID: '下载的安装包校验未通过，请重新下载',
  DOWNLOAD_FAILED: '下载失败，请检查网络后重试',
  INSTALL_FAILED: '安装未完成，请重试',
  INSTALL_BLOCKED: '当前有任务正在运行，暂时无法安装',
  VERSION_MISMATCH: '安装后版本与预期不一致，请重试',
  EXEC_PATH_UNAVAILABLE: '无法确认安装位置，请手动安装',
  PATH_UNPARSABLE: '无法确认安装位置，请手动安装',
  INSTALL_DIR_MISMATCH_WITH_RUNNING_LOCATION: '无法确认安装位置，请手动安装',
  INSTALL_DIR_TOO_BROAD: '无法确认安装位置，请手动安装',
  RESULT_MISSING: '安装未完成，请重试',
  RESULT_MISSING_BUT_VERSION_OK: '安装结果未确认，请重启后检查版本',
  SENTINEL_INVALID: '安装未完成，请重试',
  SENTINEL_EXPIRED: '安装未完成，请重试',
  STATE_TAMPERED: '更新状态异常，需手动恢复',
  EXPIRED: '更新包已过期，请重新检查更新',
  NETWORK_OFFLINE: '网络不可用，请检查网络后重试',
  DISABLED: '自动检查已关闭',
  NO_BASE_URL: '尚未配置更新源',
  ACTIVE_WORK: '当前有任务正在运行，稍后再试',
  DEFERRED: '已推迟本次检查',
  BACKOFF: '刚刚检查过，请稍后再试',
};

export function updateFailureText(reason?: string): string | undefined {
  if (!reason) return undefined;
  return FAILURE_TEXT[reason] ?? '操作未完成，请稍后重试';
}
