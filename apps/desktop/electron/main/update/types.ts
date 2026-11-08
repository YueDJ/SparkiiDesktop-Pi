// 自动升级共享数据类型（契约 §3）。
// 本文件由 G3 独占定义，其它组只 import，不得修改。

export type UpdatePhase =
  | 'disabled' | 'idle' | 'checking' | 'available' | 'downloading'
  | 'readyToInstall' | 'installing' | 'restarting' | 'completed'
  | 'rolledBack' | 'error';

export interface UpdateProgress {
  percent: number;             // 0..100
  bytesDownloaded: number;
  bytesTotal: number;
  savePath: string | null;
}

export interface RemoteUpdateInfo {
  version: string;
  sequence: number;
  nonce: string;
  publishedAt: string;
  expiresAt: string;
  summary: string;             // 取自已验签 release.json，不用 UpdateInfo.releaseNotes
  highlights: string[];
  bytes: number;
  minSupportedVersion: string;
  allowDowngrade: boolean;
}

export interface LocalUpdateInfo {
  version: string;
  sequence: number;
  nonce: string;
  artifactPath: string;
  bytes: number;
  sha512: string;
  expiresAt: string;
  valid: boolean;              // 伴生清单校验通过
}

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  baseUrl: string | null;
  autoCheck: boolean;
  lastCheckedAt: number | null;
  lastSuccessAt: number | null;
  remote: RemoteUpdateInfo | null;
  local: LocalUpdateInfo | null;
  progress: UpdateProgress | null;
  choiceRequired: boolean;      // local 与 remote 同时存在且版本不同
  errorCode: string | null;
  stateTampered: boolean;       // update-state.json HMAC 损坏 → 拒绝一切自动更新
  httpWarning: boolean;
  pendingApprovals: number;     // B 关安装确认弹窗用
  activeSessions: number;       // Pi 池活跃会话数：§7.5「有活跃进程 ⇒ 居中确认」的判定源
}

export interface UpdateSettingsPublic {
  baseUrl: string;
  autoCheck: boolean;
  checkIntervalHours: number;
  checkOnStartup: boolean;
  startupDelaySeconds: number;
  checkOnNetworkResume: boolean;
  checkOnSystemResume: boolean;
  remindIntervalHours: number;
  requestTimeoutMs: number;
  autoDownload: false;          // 恒 false
  isHttp: boolean;
}

export interface UpdateSettingsPatch {
  baseUrl?: string;
  autoCheck?: boolean;
  checkIntervalHours?: number;
  checkOnStartup?: boolean;
  startupDelaySeconds?: number;
  checkOnNetworkResume?: boolean;
  checkOnSystemResume?: boolean;
  remindIntervalHours?: number;
  requestTimeoutMs?: number;
}

export interface UpdateActionResult {
  ok: boolean;
  reason?: string;              // §1.11 错误码
  message?: string;             // 可直接展示的中文短句
}

export interface UpdateStatusSummary {  // StatusBar 用，最小子集
  phase: UpdatePhase;
  percent: number | null;
  label: string;
  version: string | null;
}

// ---- 协议数据类型（G1 发布侧按同一 schema 产出） ----

export interface ChannelJson {
  schemaVersion: 1;
  product: 'Sparkii';
  channel: 'stable';
  platform: 'win-x64';
  sequence: number;
  targetVersion: string;
  manifestPath: string;
  manifestSha256: string;
  signaturePath: string;
  publishedAt: string;
}

export interface ReleaseJson {
  schemaVersion: 2;
  product: 'Sparkii';
  channel: 'stable';
  platform: 'win-x64';
  sequence: number;
  nonce: string;
  publishedAt: string;
  expiresAt: string;
  version: string;
  minSupportedVersion: string;
  rollback: boolean;
  allowDowngrade: boolean;
  mandatory: false;
  mandatoryAfter: null;
  rollout: { percentage: 100; salt: string };
  releaseNotes: { summary: string; highlights: string[] };
  artifact: { name: string; bytes: number; sha512: string; url: string };
  requires: { minOSBuild: string; minFreeDiskBytes: number };
}

export interface SignatureEnvelope { kid: string; signature: string; }  // .sig 文件 JSON

// ---- 事件与目录常量（契约 §5） ----

export const UPDATE_EVENT_STATE = 'sparkii:event:update-state';
export const UPDATE_EVENT_PROGRESS = 'sparkii:event:update-progress';
export const UPDATE_FEED_DIRNAME = 'feed';
export const UPDATE_PENDING_DIRNAME = 'pending';

// ---- 内部辅助类型（G3 自用，可额外导出） ----

export interface AuditLike {
  append(ev: {
    actor: string;
    action: string;
    resource?: string;
    decision?: string;
    payloadSummary?: string;
  }): Promise<unknown>;
}

export interface LoggerLike {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** 已验签策略密钥集合形态。 */
export type PublicKeyMap = Record<string, { pem: string; notBefore: string; notAfter: string }>;
