# 自动升级实现契约（主 Agent 独占，2026-11-06）

> 本文件是**并行派活前落地**的唯一跨组契约，主 Agent 独占维护，sub agent **只读、不得修改**。
> 权威设计稿：`docs/superpowers/specs/2026-11-06-auto-update-design.md`（v3 + §0.7 修订 + §5.2 定案 A）。
> 阶段 0 实测：`docs/superpowers/specs/2026-11-06-task0-results.md`。
> **以设计稿为准**；本契约只把设计稿的接口「钉死」成可编译的签名。若契约与设计稿冲突，**以设计稿为准并立即回报主 Agent**，不得在代码里静默偏离。

---

## 1. 全局约定（所有组必须遵守）

1. **路径基准**：桌面端根为 `apps/desktop/`。本契约中所有 `update/*` 指 `apps/desktop/electron/main/update/*`，`test/update/*` 指 `apps/desktop/test/update/*`。
2. **ESM + `.js` 后缀**：`electron/main` 下的相对 import 一律带 `.js` 后缀（仓库既有约定），`type: "module"`。
3. **网络只发生在 Main 进程**：Renderer 只经 IPC 拿结构化数据，**永不传 URL 给 Renderer 加载**。
4. **fail closed**：任何验签 / 新鲜度 / sequence / nonce / HMAC / 形态校验失败 → 当作「无更新」+ 写 `update.verify-failed` 审计，**绝不退化成放行**。
5. **不削弱的硬约束**：IPC 层验签门禁、`autoDownload === false`、§5.2 定案 A 的 `httpExecutor` 约束、`disableDifferentialDownload === true`、`lastSeenSequence` HMAC 与「损坏即拒绝」、整 `data\` 一致性快照、伴生清单校验。
6. **禁止事项**：不写私钥 / 真实服务器 IP / token 到仓库；不改真实 `%LOCALAPPDATA%\SparkiiDesktop\data`；不执行真实 NSIS `/S`；不 `git commit` / `git push`；不伪造测试输出。
7. **公钥形态**：`update/config.ts` 导出 `RELEASE_PUBLIC_KEYS`（编译期常量对象，`kid → {pem, notBefore, notAfter}`）。示例密钥由 G1 离线生成后，**私钥立即加入忽略规则**，公钥 PEM 由主 Agent 合入 `config.ts`（G3 先放 `RELEASE_PUBLIC_KEYS = {}` 占位 + 单测用运行时注入的测试密钥）。
8. **签名输入**：`sign(kid || 0x00 || sha256(fileBytes))`（Ed25519，base64 `.sig`，头部 `kid`）；签名覆盖**原始字节**，不做 JSON 归一化。
9. **目录**（`dataDir = process.env.SPARKII_DATA_DIR ?? defaultDataDir()`）：
   ```
   <dataDir>/updates/
     ├── feed/latest.yml                 # 本地派生（每次检查后原子覆盖）
     ├── pending/<version>/<artifact>   # 下载完成后迁移
     ├── pending/<version>/release.json
     ├── pending/<version>/release.json.sig
     ├── pending/<version>/channel.json
     ├── pending/<version>/channel.json.sig
     ├── update-state.json               # 调度 + 防降级状态，HMAC 保护
     ├── update-audit-chain.jsonl        # 客户端审计哈希链（B 关）
     ├── pending-update.json             # 安装事务哨兵（B 关）
     ├── install-result.json             # watchdog 单一写入（B 关）
     └── snapshots/<txnId>/…             # 整 data\ 一致性快照（B 关）
   ```
10. **审计事件名**（`AuditStore.append` 的 `action` 字段）：`update.available` / `update.download-start` / `update.download-complete` / `update.verify-failed` / `update.check-failed` / `update.install-start` / `update.install-cancelled` / `update.install-abort` / `update.completed` / `update.failed` / `update.rolledBack` / `update.cleanup`。`update.*` 按「类型 + 天」限流；「已是最新」不写审计。
11. **错误码**（`errorCode` 字段，稳定字符串）：`DISABLED` / `NO_BASE_URL` / `INVALID_BASE_URL` / `NETWORK` / `SIGNATURE_INVALID` / `MANIFEST_HASH_MISMATCH` / `POINTER_INVALID` / `EXPIRED` / `SEQUENCE_REGRESSION` / `NONCE_MISMATCH` / `STATE_TAMPERED` / `VERSION_BLOCKED` / `MIN_SUPPORTED` / `REQUIRES_UNMET` / `DOWNLOAD_FAILED` / `ARTIFACT_INVALID` / `CHOICE_REQUIRED` / `NOT_READY` / `INSTALL_BLOCKED` / `INSTALL_FAILED`。
12. **测试**：Vitest，`apps/desktop/test/**/*.test.{ts,tsx}` 走 jsdom + `apps/desktop/test/setup.ts`。**禁止 mock 掉验签本身**；可用离线生成的测试密钥对。

---

## 2. IPC 契约（G5 实现，G3 消费）

所有 invoke 走 `sparkii:<name>`（`preload/api.ts` 的 `invoke` 前缀）；事件走 `sparkii:event:<channel>`。

### 2.1 invoke 方法（`SparkiiApi` 新增成员，签名逐字一致）

| 名称 | 签名 | 返回 / 说明 |
| --- | --- | --- |
| `getAppVersion` | `(): Promise<string>` | `app.getVersion()` |
| `getUpdateState` | `(): Promise<UpdateState>` | 见 §3 |
| `checkForUpdate` | `(force?: boolean): Promise<UpdateActionResult>` | 手动检查；`force` 绕过调度闸门，但**不绕过验签** |
| `downloadUpdate` | `(opts: { version: string }): Promise<UpdateActionResult>` | **IPC 层先验签门禁**（重验清单签名/新鲜度/sequence/nonce/minSupportedVersion），通过才调 updater |
| `cancelDownload` | `(): Promise<UpdateActionResult>` | 清理 `.part`，回 `available` |
| `installUpdate` | `(opts: { version: string }): Promise<UpdateActionResult>` | **IPC 层再验**：重开包句柄验 sha512 + 伴生清单签名 + sequence/nonce 绑定 + `expiresAt`，持有句柄直到交给安装器 |
| `clearDownloaded` | `(opts: { version: string }): Promise<UpdateActionResult>` | 删除已下载包 + 伴生清单 |
| `deferUpdate` | `(): Promise<UpdateActionResult>` | 稍后（按 `remindIntervalHours`） |
| `skipUpdate` | `(opts: { version: string }): Promise<UpdateActionResult>` | 跳过此版本 |
| `getUpdateSettings` | `(): Promise<UpdateSettingsPublic>` | 见 §3；**不含任何凭据** |
| `saveUpdateSettings` | `(partial: UpdateSettingsPatch): Promise<UpdateActionResult>` | `baseUrl` 变更写审计 + 二次确认；严格校验 URL |

> `preload/api-types.ts` 的 `SparkiiApi` 追加以上 11 个方法；`preload/api.ts` 的 `buildApi()` 追加同名实现；`test/preload-api.test.ts` 的 `names` 数组追加这 11 个名字（**该测试文件由主 Agent 独占**，G5/G2 只提交改动清单）。

### 2.2 事件 payload

| 事件 | payload | 节流 |
| --- | --- | --- |
| `sparkii:event:update-state` | `UpdateState`（完整快照） | 阶段变化立即；进度走下一行 |
| `sparkii:event:update-progress` | `UpdateProgress` | ≥200ms 节流 |

`on(channel, cb)` 的既有签名不变；G5 需在 `buildApi` 里保证新增事件通道可被 `on()` 订阅（沿用既有白名单/转发逻辑，若无白名单则无需改）。

### 2.3 UI 契约（G5）

- `src/shell/StatusBar.tsx`（`packages/ui/src/patterns/StatusBar.tsx`）新增可选 `update?: UpdateStatusSummary` 属性，渲染小进度条 / pill；**不改动既有 props 语义**，缺省时完全保持现状。
- `src/shell/SettingsView.tsx` 的 `about` pane 增加：当前版本（`getAppVersion`）、更新源、自动检查开关、「检查更新」按钮、HTTP 中性提示、`update-state` 异常提示、上次成功检查时间。
- 0.2 / 0.3 二选一：`UpdateState.choiceRequired === true` 时 UI 显示两个按钮：本地 `local.version` → `installUpdate({version: local.version})`；远端 `remote.version` → `downloadUpdate({version: remote.version})`。**不得同时下载/安装两个版本**。

---

## 3. 共享数据类型（`update/types.ts`，G3 独占定义，其它组只 import）

```ts
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
```

**协议数据类型**（`update/types.ts` 一并定义，G1 的发布侧按同一 schema 产出）：

```ts
export interface ChannelJson {
  schemaVersion: 1; product: 'Sparkii'; channel: 'stable'; platform: 'win-x64';
  sequence: number; targetVersion: string; manifestPath: string;
  manifestSha256: string; signaturePath: string; publishedAt: string;
}
export interface ReleaseJson {
  schemaVersion: 2; product: 'Sparkii'; channel: 'stable'; platform: 'win-x64';
  sequence: number; nonce: string; publishedAt: string; expiresAt: string;
  version: string; minSupportedVersion: string; rollback: boolean;
  allowDowngrade: boolean; mandatory: false; mandatoryAfter: null;
  rollout: { percentage: 100; salt: string };
  releaseNotes: { summary: string; highlights: string[] };
  artifact: { name: string; bytes: number; sha512: string; url: string };
  requires: { minOSBuild: string; minFreeDiskBytes: number };
}
export interface SignatureEnvelope { kid: string; signature: string; }  // .sig 文件 JSON
```

> `api-types.ts` **不得** import `electron/main/update/*`（preload 层不得依赖主进程实现）。G5 在 `api-types.ts` 里用**结构等价的重复类型声明**（或 import 一个独立的 `update-types.ts` 到 `electron/preload/`）；推荐：把上面 `UpdateState` 等纯数据类型也复制/再导出到 `api-types.ts`，字段名逐字一致，由 `test/preload-api.test.ts` + 类型检查保证对齐。

---

## 4. `UpdateService` 门面契约（`update/service.ts`，G3 独占）

`main/ipc.ts`（G5）**只**通过下面这个门面访问更新能力；`main/index.ts`（主 Agent）只调用 `initUpdateService` / `getUpdateService` / `shutdownForUpdate`。

```ts
export interface UpdateDeps {
  dataDir: string;
  currentVersion: string;                 // app.getVersion()
  resourcesPath: string;                  // process.resourcesPath（app-update.yml 所在）
  logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  audit: { append(ev: { actor: string; action: string; resource?: string; decision?: string; payloadSummary?: string }): Promise<unknown> };
  /** channel 是完整事件名：UPDATE_EVENT_STATE / UPDATE_EVENT_PROGRESS（即 'sparkii:event:update-state' 等）。
   *  main/ipc.ts 直接把它透传给 BrowserWindow.webContents.send(channel, payload)。 */
  sendEvent(channel: string, payload: unknown): void;
  loadSettings(): Promise<AppSettingsLike>;
  saveSettings(patch: Partial<AppSettingsLike>): Promise<void>;
  keyringSecret(): Promise<Buffer>;       // HMAC 密钥（DPAPI）
  rt: {                                    // B 关关机协议用，A 关可为 undefined
    pool: { stopAll(): Promise<void> };
    auditStore: { close(): void };
    chatSessions: { close(): void };
    errors: { close(): void };
    gate: { abortPendingForQuit(reason: string): Promise<number> };
    reviewer: { dispose(): Promise<void> };
    documentParseSupervisor: { beginQuit(): Promise<void> };
  } | undefined;
  isUpdatingRef: { value: boolean };      // 由 main/index.ts 提供，before-quit 读取
  quitApp(): void;                         // 触发 app.quit()/app.exit()
  now(): number;                           // 可注入时钟，便于单测
}

export interface UpdateService {
  getAppVersion(): Promise<string>;
  getState(): Promise<UpdateState>;
  checkForUpdate(force?: boolean): Promise<UpdateActionResult>;
  downloadUpdate(opts: { version: string }): Promise<UpdateActionResult>;
  cancelDownload(): Promise<UpdateActionResult>;
  installUpdate(opts: { version: string }): Promise<UpdateActionResult>;
  clearDownloaded(opts: { version: string }): Promise<UpdateActionResult>;
  deferUpdate(): Promise<UpdateActionResult>;
  skipUpdate(opts: { version: string }): Promise<UpdateActionResult>;
  getSettings(): Promise<UpdateSettingsPublic>;
  saveSettings(partial: UpdateSettingsPatch): Promise<UpdateActionResult>;
  /** 启动时本地扫描 pending/ + 自检安装结果；零网络 */
  startupScan(): Promise<void>;
  /** 关机协议（B 关）：由 main/index.ts 在 before-quit 中调用，返回 false 表示需 preventDefault */
  onBeforeQuit(): boolean;
  shutdown(): Promise<void>;
}

export function initUpdateService(deps: UpdateDeps): UpdateService;
export function getUpdateService(): UpdateService;
export function hasUpdateService(): boolean;
```

> **A 关**：`installUpdate` / `onBeforeQuit` 允许返回 `INSTALL_BLOCKED`（B 关未实现）或调用 B 关实现；G3 必须让 A 关整体 `pnpm typecheck` / `pnpm test` 全绿。
> **B 关**：G7 接管 `installer.ts` 后由 `service.ts` 调用；接口不变。

---

## 5. 模块导出签名（`electron/main/update/*`，G3 独占；`installer.ts` 见 §6）

每个模块至少导出下列名字（可额外导出内部 helper）。**跨组只能依赖这些名字**。

| 模块 | 必须导出的签名 |
| --- | --- |
| `types.ts` | §3 全部类型；`UPDATE_EVENT_STATE = 'sparkii:event:update-state'`、`UPDATE_EVENT_PROGRESS = 'sparkii:event:update-progress'`、`UPDATE_FEED_DIRNAME = 'feed'`、`UPDATE_PENDING_DIRNAME = 'pending'` |
| `config.ts` | `DEFAULT_UPDATE_URL: string`（读 `typeof __SPARKII_UPDATE_URL__ !== 'undefined' ? … : ''`）；`normalizeBaseUrl(raw: string): { ok: true; url: string } \| { ok: false; reason: string }`；`resolveUpdateSettings(s: AppSettingsLike): ResolvedUpdateSettings`；`RELEASE_PUBLIC_KEYS: Record<string, { pem: string; notBefore: string; notAfter: string }>`；`isHttpUrl(url: string): boolean`；`globals.d.ts`（`declare const __SPARKII_UPDATE_URL__: string \| undefined`） |
| `verifier.ts` | `fetchAndVerify(opts: VerifyOptions): Promise<VerifyOutcome>`；`deriveLatestYml(release: ReleaseJson, baseUrl: string): { ok: true; yml: string; artifactUrl: string } \| { ok: false; reason: string }`；`verifySignatureEnvelope(bytes: Buffer, sigText: string, keys?: typeof RELEASE_PUBLIC_KEYS): { ok: true; kid: string } \| { ok: false; reason: string }`；`validateChannelPointer(ch: ChannelJson, baseUrl: string): { ok: true } \| { ok: false; reason: string }` |
| `state-store.ts` | `class UpdateStateStore { constructor(opts: { dataDir: string; secret: Buffer; now(): number }); read(): Promise<PersistedState>; write(next: PersistedState): Promise<void>; isTampered(): boolean; lastSeenSequence(): number \| null; nonceFor(sequence: number): string \| null; recordSeen(sequence: number, nonce: string, version: string): Promise<void>; markSuccess(at: number): Promise<void>; markCheck(at: number): Promise<void>; defer(at: number): Promise<void>; skip(version: string): Promise<void>; }` |
| `decision.ts` | `decide(opts: DecideOptions): Promise<DecideOutcome>`；`assertMinSupportedVersion(current: string, release: ReleaseJson): { ok: true } \| { ok: false; reason: string }`；`compareVersions(a: string, b: string): number` |
| `downloader.ts` | `planDownload(opts: DownloadPlanOptions): Promise<DownloadPlan>`；`finalizeDownload(opts: FinalizeOptions): Promise<{ ok: true; artifactPath: string } \| { ok: false; reason: string }>`；`verifyArtifactBytes(filePath: string, expectedSha512: string, expectedBytes: number): Promise<{ ok: true } \| { ok: false; reason: string }>` |
| `local-artifacts.ts` | `scanPending(dataDir: string, opts: ScanOptions): Promise<LocalUpdateInfo[]>`；`verifyCompanion(pendingDir: string, opts: ScanOptions): Promise<{ ok: true; release: ReleaseJson; channel: ChannelJson } \| { ok: false; reason: string }>`；`clearPending(dataDir: string, version: string): Promise<void>` |
| `updater-adapter.ts` | `createLocalFeedExecutor(opts: LocalFeedExecutorOptions): CustomHttpExecutor`；`createUpdater(opts: CreateUpdaterOptions): { updater: NsisUpdaterLike; executor: CustomHttpExecutor }`；`writeDerivedFeed(dataDir: string, yml: string): Promise<string>`（返回 `file://` feed URL）；`crossCheckUpdateInfo(info: unknown, release: ReleaseJson): { ok: true } \| { ok: false; reason: string }` |
| `audit.ts` | `logUpdateEvent(audit: UpdateDeps['audit'], action: string, fields?: Record<string, unknown>): Promise<void>`；`UPDATE_EVENTS: readonly string[]` |
| `scheduler.ts` | `shouldCheck(opts: ShouldCheckOptions): { ok: true; reason: string } \| { ok: false; reason: string }`；`jitterDelay(installId: string, baseSeconds: number): number`；`backoffMs(failureCount: number): number` |
| `service.ts` | §4 全部 |
| `installer.ts` | 见 §6（**B 关 G7 接管**） |

### 5.1 `electron/main/shutdown.ts`（G4 独占，主进程装配共用）

```ts
export interface ShutdownStep { name: string; at: number; }
export interface ShutdownHooks {
  abortPendingApprovals(reason: string): Promise<number>;  // ① 审批门显式过期
  stopPool(): Promise<void>;                              // ② pool.stopAll()
  stopDocumentParse(): Promise<void>;                     // ③ documentParse.beginQuit()
  disposeReviewer(): Promise<void>;                      // ④ reviewer.dispose()
  closeStores(): Promise<void>;                          // ⑤ audit → chatSessions → errors
  snapshotData(): Promise<void>;                         // ⑥ 整 data\ 一致性快照（A 关可 no-op）
  now(): number;
}
/** 严格按 §7.7 顺序执行；返回每一步的名称与时间戳，供单测断言顺序 */
export function runShutdownSequence(hooks: ShutdownHooks): Promise<ShutdownStep[]>;
```

> `main/index.ts`（主 Agent）与 B 关 `installer.ts`（G7）都可调用它；**顺序不得改变**：关新任务入口 → 审批门显式过期 → `pool.stopAll()` → `documentParse.beginQuit()` → `reviewer.dispose()` → 三个 store `close()` → 整 `data\` 快照。

`CustomHttpExecutor` 形态（必须同时实现，且由 `updater-adapter.ts` 在 **`setFeedURL()` 之前**赋给 `updater.httpExecutor`）：

```ts
export interface CustomHttpExecutor {
  maxRedirects: 0;
  request(options: { protocol?: string; hostname?: string; port?: string | number; path?: string; url?: URL; headers?: Record<string, string> }): Promise<Buffer>;
  download(url: URL, destination: string, options: DownloadExecutorOptions): Promise<string>;
}
```

`request()` 只接受 `file:`（读本地派生 feed，严格限定在 `<dataDir>/updates/feed/latest.yml`），其它 scheme **抛错**；`download()` 强制 host/port/scheme == `baseUrl`、`redirect: 'manual'`、`maxRedirects = 0`、8s 连接超时、字节上限 = `artifact.bytes`、sha512 终检、`onProgress`、响应 `cancellationToken`。

---

## 6. `installer.ts` 契约（**G7 独占**，A 关由 G3 放置可编译占位）

```ts
export interface InstallRequest {
  dataDir: string;
  currentVersion: string;
  targetVersion: string;
  artifactPath: string;
  packageSha512: string;
  resourcePath: string;       // app-update.yml 所在
  appId: string;              // 'com.sparkii.desktop'
  now(): number;
}
export interface InstallPlanResult {
  ok: boolean;
  reason?: string;
  txnId?: string;
  watchdogPid?: number;
  installDir?: string | null;
  snapshotPath?: string;
}
/** 关机协议主体：返回 false 表示 before-quit 需 preventDefault */
export function runInstallTransaction(req: InstallRequest, deps: InstallDeps): Promise<InstallPlanResult>;
/** 启动时自检：哨兵 + install-result + app.getVersion()；成功清理、失败给恢复入口 */
export function verifyStartup(dataDir: string, currentVersion: string): Promise<StartupVerdict>;
/** 解析安装目录：InstallLocation → UninstallString 回退 → 失败返回 null（fail closed，不传 /D） */
export function resolveInstallDirectory(appId: string): Promise<string | null>;
/** 整 data\ 一致性快照（含 SQLite -wal/-shm），逐文件 SHA256 写哨兵 */
export function snapshotDataDir(dataDir: string, txnId: string, excludeRel: string[]): Promise<SnapshotResult>;
/** 断电/失败恢复 */
export function recoverFromSnapshot(dataDir: string, txnId: string): Promise<{ ok: boolean; reason?: string }>;
/** 磁盘保留策略：只保留最近 N 个快照与 pending 包 */
export function pruneRetained(dataDir: string, keep: number): Promise<void>;
/** 客户端审计哈希链：prevHash + eventHash */
export function appendClientAuditChain(dataDir: string, event: Record<string, unknown>): Promise<string>;
```

`watchdog` 载体（B1 修复后）是**独立镜像名的可执行文件** `sparkii-update-watchdog.exe`（Node SEA，
由 `apps/desktop/scripts/build-watchdog-sea.mjs` 从 `apps/desktop/scripts/update-watchdog.mjs` 构建）：
构建产物随包放在 `<resources>/scripts/`，安装事务运行时把它**部署到 `$INSTDIR` 之外**
（`<dataDir>/updates/watchdog/`）再 spawn。镜像名 ≠ `Sparkii.exe` 且路径不在 `$INSTDIR` 之下，
是避开 NSIS 两个 `CHECK_APP_RUNNING` kill 点与旧卸载器 `un.atomicRMDir` 文件锁的硬条件。

CLI 契约（逐字）：
`sparkii-update-watchdog.exe --parent-pid <pid> --sentinel <abs> --result <abs> --timeout-ms 60000 --installer <abs> -- --updated --force-run /S /D=<dir>`

行为：等待 PID 消失 → **重哈希安装器并比对哨兵 `packageSha512`（不符即拒绝，spawn 前）** → spawn 安装器 →
**单一写入** `install-result.json`。watchdog 自己的退出码：`0` ⇔ `ok:true`；
安装器非 0 ⇒ **透传该码**且 `ok:false`；七个提前退出现场（`ARGS_INVALID` / `SENTINEL_INVALID` /
`INSTALLER_MISSING` / `INSTALLER_HASH_MISMATCH` / `INSTALLER_NOT_EXECUTABLE` / `PARENT_TIMEOUT` /
`SPAWN_FAILED`）⇒ `2`。watchdog 不核对版本，也不改判安装结果——「装到了哪个版本」由客户端
`verifyStartup()` 用 `app.getVersion()` 对照哨兵判定（§7.5）。

⚠ **spawn 的进程边界是契约的一部分**：`/D=` 必须原样到 CreateProcess 命令行结尾、**不带引号**。
Node 默认会给含空格的参数自动加引号（`"/D=C:\Users\John Smith\…"`），NSIS 因此识别不到 `/D`，
`$INSTDIR` 落到默认值或被解析成带尾引号的非法路径。因此真实安装器分支必须使用
`windowsVerbatimArguments: true` 直连（**不要**用 `shell: true` / `cmd /c` 包装——那会把 `A&B`
这类合法路径截断/注入）。该行为由 `apps/desktop/test/update/watchdog-command-line.test.ts`
用真实 makensis 探针断言 `$INSTDIR`，只断言 args 数组不够。

`install-result.json` 的字段以 `update-watchdog.mjs` 的 `writeResultAtomic()` 为准（R8 · Minor-3：本表此前漏了
`spawnedAt` 与 `reason`，客户端与运维口径按漏写的那份解释就会读不到失败原因）：

| 字段 | 形态 | 来源与含义 |
| --- | --- | --- |
| `ok` | `boolean` | **只等于「安装器退出码 === 0」**（`update-watchdog.mjs` 的 `const ok = exitCode === 0`）。哨兵 / 版本一致性不在这里判。 |
| `exitCode` | `number \| null` | 安装器进程退出码（被信号终止记 `-1`）；提前退出与 `SPAWN_FAILED` 时为 `null`。 |
| `targetVersion` | `string \| null` | 哨兵里的目标版本；供 `verifyStartup()` 与 `app.getVersion()` 对照。 |
| `packageSha512` | `string \| null` | 哨兵里的包哈希（**只是留痕**，客户端不拿它当判据；判据在伴生清单 + 验签）。watchdog 在 spawn 前用它做重哈希比对（M4）。 |
| `parentGoneAt` | `string \| null` | 观测到主进程 PID 消失的时刻（ISO）。 |
| `spawnedAt` | `string \| null` | 进入 spawn 那一步的时刻（ISO）。与 `parentGoneAt` **成对出现**：两者都有值 ⇒ 真的拉起了安装器（`SPAWN_FAILED` 也算，只是子进程报错）；两者都为 `null` ⇒ 死在更早的提前退出，靠 `reason` 区分。`spawnedAt` 有值而 `exitCode` 为 `null` ⇒ `SPAWN_FAILED`。 |
| `writtenAt` | `string` | 本次写入时刻（ISO），由写入方自己盖。 |
| `writer` | `'watchdog'` | 单一写入方标识；客户端不据此放行，只用于事后归因。 |
| `reason` | `string`（**可选**） | 仅在未能走到「安装器正常退出」时出现，取值就是 watchdog 的七个提前退出码：`ARGS_INVALID` / `SENTINEL_INVALID` / `INSTALLER_MISSING` / `INSTALLER_HASH_MISMATCH` / `INSTALLER_NOT_EXECUTABLE` / `PARENT_TIMEOUT` / `SPAWN_FAILED`。⚠ 安装器**跑完但退出码非 0** 时**不写 `reason`**，失败信息只在 `ok:false` + `exitCode` 里——运维区分「装坏了」与「没装上 / 根本没启动」靠这两条不同形态。`INSTALLER_NOT_EXECUTABLE` 只在 SEA 载体里出现：脚本形态的 `--installer` 会被拒绝（否则 `process.execPath` 指向 watchdog 自身、递归回本进程）。 |

**并发下的让位语义**（I-52 / R8）：Windows 上 `rename` 覆盖正被打开的目标会 `EPERM/EBUSY`，两个 watchdog 同时收尾时
落后的一方 rename 失败 ⇒ **删掉自己的 `.tmp` 并放弃这一次覆盖**（`data\updates\` 不留残留文件，结果文件仍由先赢的写入方持有，
内容是完整 JSON）。放弃写入**不改判** `ok`，也不使 watchdog 崩溃；因此「结果文件里的写入方与本次 PID 不同」是合法现场，
不是被篡改的证据。

---

## 7. 文件归属表（**每个文件唯一 owner，禁止跨界写**）

| Owner | 文件（白名单） |
| --- | --- |
| **主 Agent（G0 / 集成，独占）** | `docs/superpowers/specs/2026-11-06-auto-update-design.md`、`2026-11-06-task0-results.md`、`2026-11-06-update-interfaces.md`（本文件）、`2026-11-06-implementation-review.md`、`docs/superpowers/specs/2026-11-06-task0-scripts/*`、`.codex-handoff/*`、`apps/desktop/package.json`、`apps/desktop/electron/main/index.ts`、`apps/desktop/test/preload-api.test.ts`、`apps/desktop/test/release-config.test.ts`、`pnpm-lock.yaml`、`.gitignore` |
| **G1 · 发布侧** | `apps/desktop/scripts/sign-release.mjs`、`publish-release.mjs`、`release-keys.mjs`、`verify-release.mjs`、`apps/desktop/scripts/update-source-template/**`、`docs/operations/update-service.md`、`apps/desktop/test/publish-release.test.ts`、`apps/desktop/test/sign-release.test.ts` |
| **G2 · 构建配置** | `apps/desktop/electron-builder.config.mjs`、删除 `apps/desktop/electron-builder.yml`、`apps/desktop/test/update-artifacts.test.ts`（新建）。**`apps/desktop/package.json` / `test/release-config.test.ts` / `test/preload-api.test.ts` 是主 Agent 独占，G2 只提交改动清单** |
| **G3 · 更新核心** | `apps/desktop/electron/main/update/*`（**除 `installer.ts` 之外全部**；`installer.ts` 仅允许在 A 关放置满足 §6 签名的可编译占位，B 关由 G7 接管重写）、`apps/desktop/test/update/*`（**除 `install*` 前缀测试文件外**；`test/update/install*.test.ts` 归 G7） |
| **G4 · 主进程装配** | `apps/desktop/electron/main/runtime.ts`（如需）、`document-parse-quit.ts`、`apps/desktop/electron/main/settings.ts`、`packages/approval/src/gate.ts`、`packages/agent-host/src/pi-runtime-pool.ts`、`apps/desktop/test/shutdown-order.test.ts`、`apps/desktop/test/document-parse-quit.test.ts`（如需）、`apps/desktop/test/gate-expire.test.ts` |
| **G5 · UI / IPC / preload** | `apps/desktop/electron/preload/api-types.ts`、`api.ts`、`apps/desktop/electron/main/ipc.ts`、`apps/desktop/src/shell/*`（新建 update pane 组件）、`packages/ui/src/patterns/StatusBar.tsx`、**`apps/desktop/test/update-ipc.test.ts`**（新建） |
| **G6 · 安装事务 NSIS** | `apps/desktop/build/installer.nsh`、`apps/desktop/scripts/update-watchdog.mjs`、`apps/desktop/test/update-watchdog.test.ts` |
| **G7 · 快照与恢复** | `apps/desktop/electron/main/update/installer.ts`（B 关接管）、`apps/desktop/electron/main/update/snapshot.ts`（新建）、`apps/desktop/test/update/install*.test.ts`、`apps/desktop/test/update/snapshot*.test.ts`、`apps/desktop/test/update/power-cut.test.ts` |
| **G8 · 文档契约** | `docs/release-windows.md`、`docs/deploy.md`、`docs/superpowers/plans/2026-10-23-windows-internal-release.md`、`README.md`、`README.en.md`、`PRODUCT.md`、`TODO.md`、`apps/desktop/src/branding.ts` |

### 共享文件改动协议（**强制**）

- `apps/desktop/package.json`：G2 需要改 `dist` 脚本与 `build:main` 的 esbuild `define`；G1/G6 若需新增 script 也走这里。**sub agent 一律不写该文件**，只在返回里给「需要主 Agent 合并的改动清单」（精确 JSON 片段）。
- `apps/desktop/electron/main/index.ts`：主 Agent 独占。G3/G4/G5 需要的装配（单实例锁、`initUpdateService`、两个 `before-quit`、`isUpdating`、三个 store `close()`）以「改动清单」提交。
- `test/preload-api.test.ts` / `test/release-config.test.ts`：主 Agent 独占。G2/G5 提交改动清单。
- **任何组不得修改 `AGENTS.md`、`.codex-handoff/CURRENT.md`、设计稿、本契约、以及别人的白名单文件。**

---

## 8. 主 Agent 集成收口清单（并行返回后逐项核对）

1. 逐个 `git diff --stat` / 读文件核对**实际改动**，不只信汇报。
2. 合并共享文件改动清单：`package.json`（`dist` 加 `--config electron-builder.config.mjs`、esbuild `define` 注入 `__SPARKII_UPDATE_URL__`）、`main/index.ts`（单实例锁、服务装配、关机顺序）、两个测试断言文件。
3. `pnpm install` → `pnpm typecheck` → `pnpm lint` → `pnpm test` → 最小构建产物断言，真跑全绿。
4. 核对 §5.2 定案 A 的 7 步在代码里逐条有对应实现；核对 D1–D18 无静默偏离。
5. 清理自己创建的 `.codex-handoff/G*.md`（**绝不碰 `CURRENT.md`**）。

---

## 9. 验收映射（§9 A 关①–⑦ / B 关①–⑥ → 测试文件）

| 验收项 | 承担测试 |
| --- | --- |
| A② 篡改 `release.json` / `.sig` / 包体 / 指针 / 同 sequence 换 nonce 一律拒绝 | `test/update/verifier.test.ts`、`test/update/state-store.test.ts`、`test/update/downloader.test.ts` |
| `autoDownload === false` | `test/update/updater-adapter.test.ts` |
| ⑤ derived state 扫描（关机重开不重下） | `test/update/local-artifacts.test.ts` |
| sequence 单调 + HMAC 损坏 fail closed | `test/update/state-store.test.ts` |
| 下载进度与取消不丢包 | `test/update/downloader.test.ts` |
| ⑥ 0.2 / 0.3 二选一 | `test/update/decision.test.ts` |
| A⑦ 全量 `pnpm test` | 集成收口 |
| B① 活跃进程确认 / 关机顺序 | `test/shutdown-order.test.ts`、`test/update/install-transaction.test.ts`、`test/update-status-ui.test.tsx` |
| B③ 整 `data\` 快照完整性 | `test/update/snapshot.test.ts` |
| B④ 断电注入恢复 | `test/update/power-cut.test.ts` |
| watchdog 时序与退出码 | `test/update-watchdog.test.ts` |
| 客户端审计哈希链 | `test/update/install-audit-chain.test.ts` |

---

## 10. 集成变更记录（主 Agent，A 关收口 + B 关装配）

> 本节由主 Agent 追加，记录「并行派活之后、集成时实际发生的接口偏差」。**设计稿仍是权威源**；这里的每条都能在代码里指认。
> sub agent 只读本节，不得据此改自己的白名单文件。

| # | 契约原文 | 集成后的实际形态 | 落点（代码 / 测试） | 对应设计稿 |
| --- | --- | --- | --- | --- |
| I-1 | §4 `checkForUpdate(force?: boolean)` | 追加**可选**第二参 `trigger?: 'network' \| 'system' \| null`，透传给 `shouldCheck.resumeTrigger`；不传即 `null`，IPC / preload 签名不变（不破坏 §2.1） | `update/service.ts` 的 `checkForUpdate` | §7.10 触发源③ |
| I-2 | §4 `UpdateDeps` | 新增可选字段：`shutdownController`、`hasActiveWork()`、`isNetworkOffline()`；`rt.pool` 增 `activeCount?()`、`rt.gate` 增 `listPending?()`（都是可选，既有注入方不受影响） | `update/service.ts`、`electron/main/index.ts` | §7.7 / §7.10 / §7.5 |
| I-3 | §3 `UpdateState.pendingApprovals` | 同批新增 `activeSessions: number`；两字段由 Main 侧 `refreshActivity()`（`gate.listPending().length` / `pool.activeCount()`）在每次 `emitState()` 与 `getState()` 时刷新，Renderer 只展示不判定 | `update/types.ts`、`preload/api-types.ts`、`main/ipc.ts` 的 `UPDATE_DISABLED_STATE`、`test/update-status-ui.test.tsx` | §7.5「有活跃进程 ⇒ 居中确认」 |
| I-4 | §5 `ShouldCheckOptions` | 新增可选 `activeWork` / `networkOffline` 两个闸门输入；`ACTIVE_WORK` 分支排在退避与周期判定之前，`NETWORK_OFFLINE` 排在最后（与设计 §7.10 的列举顺序一致）。同文件导出 `ACTIVE_WORK_DEFER_MS = 15min` | `update/scheduler.ts`、`test/update/scheduler.test.ts`（G3 原有用例仍绿） | §7.10 统一闸门 | ⚠ 被 I-34 Major-1 取代：`NETWORK_OFFLINE` 现在排在所有「提前放行」通道之前（不再是「最后」）。
| I-5 | §6 `runInstallTransaction(req, deps)` 的 `deps` | 不再是 `{}`：`installUpdate` 传入 `{ now, logger, quitApp, isUpdatingRef, shutdownController, rt, release, channel }`；并且**在调用事务前**就置 `isUpdatingRef.value = true`（§7.7 步骤 1），事务失败则撤销该标志回到普通退出语义 | `update/service.ts` 的 `installUpdate` | §7.7 步骤 1 / 6 / 7 |
| I-6 | §5 `downloader.planDownload` | 磁盘预检按 §7.6 改为 `max(requires.minFreeDiskBytes, bytes × 2 + DISK_PRECHECK_SLACK_BYTES)`（旧实现是「下限 + 1× 包体」，偏松） | `update/downloader.ts`、`test/update-config-keys.test.ts` | §7.6 / C1 |
| I-7 | §5 `updater-adapter.CustomHttpExecutor.download` | 落实 §7.6 / C1 的断点续传与 `.part`：写 `<destination>.part`，带 `Range: bytes=<已下字节>-`；接受 206 追加、服务端回 200 则整包重写；成功后原子改名到 destination。**超时口径修正**：`requestTimeoutMs` 只约束「连接 + 响应头」，响应体改用 `STALL_TIMEOUT_MS`（30s 无新字节即中止）——旧写法会让 401MB 大包必然在 8s 被误杀 | `update/updater-adapter.ts`、`test/update-download-resume.test.ts` | §5.2 步骤 4 / §7.6 / C1 |
| I-8 | §5.2 定案 A 的下载链路 | `service.downloadUpdate` 改为真正经 `updater.downloadUpdate(cancellationToken)`（D5「只用 checkForUpdates / downloadUpdate」），由注入的 executor 执行网络；产物从 updater 缓存目录迁移到 `pending/<version>/`。`crossCheckUpdateInfo` 不等即 fail closed（不再只记警告） | `update/service.ts` 的 `checkedUpdater` / `downloadUpdate`、`test/update/service.test.ts`（fake updater 已改为经 executor 真实下载） | §5.2.1 步骤 3 / D5 / §6.5 / §7.6 |
| I-9 | §5 `local-artifacts.verifyCompanion` | 追加包体名形态校验 `^[A-Za-z0-9._-]+$`；`dirs.pendingVersionDir` 对 `version` 段做同一校验并抛错（防已验签清单里的恶意文件名做路径穿越，落实不变量 4） | `update/local-artifacts.ts`、`update/dirs.ts` | §0.4 不变量 4 | ⚠ 被 I-30 取代：`pendingVersionDir` 现在用完整 semver 判据（`isSafeVersionSegment`），不再是该字符类正则。
| I-10 | §5.4 公钥「编译期常量内置」 | `RELEASE_PUBLIC_KEYS` 改为由 esbuild define `__SPARKII_RELEASE_PUBLIC_KEYS__` 填充，构建期来源是 `SPARKII_RELEASE_KEYS_FILE`（`scripts/release-keys.mjs` 产出的 `public-key.json`）。未注入 / JSON 非法 / 任一条目不可信 ⇒ **整表为空 ⇒ 所有验签失败**（fail closed，绝不放行未签名）。新增导出 `parseReleasePublicKeys()` | `scripts/build-main.mjs`、`update/config.ts`、`update/globals.d.ts`、`test/update-config-keys.test.ts` | §5.4 / §6.3 / §8.3 |
| I-11 | 本契约无对应条目（装配层） | 新增主 Agent 独占模块 `electron/main/update-bootstrap.ts`：`resolveUpdateHmacKey()`（DPAPI 取/生成 HMAC 密钥，取不到即抛错 ⇒ **不装配更新服务**）、`createShutdownController()`（§7.7 序列幂等 `runOnce()`）、`createUpdateQuitGuard()`（before-quit 守卫）、`startUpdateScheduling()`（§7.10 四类触发源 + 周期 + 阶梯退避 + 连续 7 轮不可用降级为仅手动） | `electron/main/index.ts`、`test/update-bootstrap.test.ts` | §7.7 / §7.10 / §6.3 第 4 条 |
| I-12 | §5 `退避阶梯` | 设计写「30s → 5min → 30min → 2h → 24h」（5 档），而「连续 7 天不可用降级为仅手动」若照字面用天数需要额外持久字段。集成实现取**保守口径**：调度层连续 **7 次**真实不可用即停止自动排期（比 7 天更早停），阶梯补一档 12h 使「最后一次退避」正好落在 24h 档前 | `update-bootstrap.ts` 的 `UNAVAILABLE_BACKOFF_MS` / `MAX_CONSECUTIVE_UNAVAILABLE` | §7.10 失败退避 |
| I-13 | §10 影响面「状态栏」 | 原实现只有 `packages/ui` 的 `StatusBar` 支持 `update` prop，宿主从未传过 ⇒ pill 在实际应用里不可见。集成后：`Shell` 增 `update` / `onUpdateClick` props 并透传，`App.tsx` 订阅 `update-state` 并经 `mapUpdateSummary()` 映射；pill 点击进设置 → 关于（§7.5 的「小面板」由既有关于页 pane 承担，不重复造第二套操作入口） | `packages/ui/src/patterns/Shell.tsx`、`StatusBar.tsx`、`src/App.tsx`、`src/shell/Shell.tsx`、`test/update-status-ui.test.tsx` | §7.5 / D16 |
| I-14 | §7.5 安装确认 | `SettingsUpdatePane` 之前**直接**发 `installUpdate`。集成后：`activeSessions > 0 \|\| pendingApprovals > 0` ⇒ 先弹居中 `Modal`（列出活跃会话数 / 将被放弃的待审批数 / 目标版本），取消即回「可安装」且不发任何 IPC；无活跃工作才直接开始。二选一里的「安装已下载的 X」同受此约束 | `src/shell/SettingsUpdatePane.tsx`、`test/update-status-ui.test.tsx` | §7.5 / §7.7 步骤 2 / §9 B① |

| I-15 | §2.1「11 个方法」/ §6.6 三入口 | 集成后共 **12 个** invoke：新增 `resetInstallId(): Promise<UpdateActionResult>`（→ `sparkii:resetInstallId`）。`state-store.ts` 相应新增 `regenerateInstallId()`。设置页三入口（§6.6）全部落地：更新源地址**可编辑 + 变更二次确认**（保存仍由 Main 侧严格校验并写审计）、「查看本地检查记录」（用既有 `queryAudit({ resource: 'auto-update' })`，纯文本渲染，不生成链接）、「重置检查标识」。§7.4「设置页可手填 IP」此前**未实装**（G5 只做了只读展示），现已补齐 | `update/state-store.ts`、`update/service.ts`、`main/ipc.ts`、`preload/api.ts`、`preload/api-types.ts`、`src/shell/SettingsUpdatePane.tsx`、`test/preload-api.test.ts`、`test/update-status-ui.test.tsx`、`test/update-service-settings.test.ts` | §6.6 / §7.4 / D10 / C4 |
| I-16 | §10 影响面 · 打包 | watchdog 脚本必须随包可达，否则 §7.7 的安装执行链在生产包里永远拿不到脚本（只会 fail closed）。已在 `electron-builder.config.mjs` 的 `extraResources` 追加第 9 项 `{ from:'scripts/update-watchdog.mjs', to:'scripts/update-watchdog.mjs' }`；`update/installer.ts` 按 `resourcesPath/scripts/update-watchdog.mjs` 优先定位。相应放宽 `test/update-artifacts.test.ts` 的「与已删除 yml 逐字一致」断言为「前 9 项逐字一致 + 第 9 项是 watchdog」 | `electron-builder.config.mjs`、`test/update-artifacts.test.ts` | §7.7 步骤 7 / §10 | ⚠ 编号口径修正（R9 · D-1）：`extraResources` 共 **9** 项，watchdog 是第 9 项（此处原先误写为第 10 项）；yml 快照常量本身是 **8** 项。断言逻辑（slice(0,8) + 总长 9）一直是正确的。
| I-17 | §5 `updater-adapter` | 新增 `UpdaterUnavailableError` / `isUpdaterUnavailable()`：`require('electron-updater')` 失败（生产包缺件）归一为「环境缺件」，service 据此回 `NOT_READY` 而**不是** `ARTIFACT_INVALID`；元数据逐字段比对不符仍按 fail closed 写 `update.verify-failed`。两者都不放行，但诊断不再误导 | `update/updater-adapter.ts`、`update/service.ts`、`test/update-download-resume.test.ts` | §5.2 / §6.5 / §1.11 错误码 |
| I-18 | §7.9「verify-failed 镜像到 errors」 | 镜像不落在验签内核（`update/audit.ts` 仍只写 AuditStore，签名未变），而在装配层新增 `createUpdateAuditSink(rt.audit, rt.errors)`：仅 `update.verify-failed` 额外写一条可读的 error 事件（id 含时间戳、source='update'），普通 `update.*` 一律不进 errors（§7.5「更新提示是通知不是错误」）。限流仍由内核负责，因此镜像天然不刷屏 | `update-bootstrap.ts`、`main/index.ts`、`test/update-bootstrap.test.ts` | §7.9 / §7.5 |
| I-19 | §7.10 退避阶梯与「连续 7 天」 | 「连续 7 次即降级为仅手动」与 5 档阶梯存在「停排前最后一档仍是 30min」的语义缺口：阶梯补一档 12h（共 6 档），使第 7 次之前一定经过 24h 档；停排后 `logger.warn` 只记一次，重启恢复调度 | `update-bootstrap.ts` 的 `UNAVAILABLE_BACKOFF_MS`、`test/update-bootstrap.test.ts` | §7.10 失败退避（是 I-12 的补充） |
| I-20 | §7.10 统一闸门的执行窗口 | 四类触发源可能同时命中（周期 + resume + 网络边沿），旧写法会并发跑两次 `checkForUpdate` ⇒ 两次网络请求与交错的阶段迁移。调度层加单一执行窗口（`running` 闸门：检查进行中的触发直接丢弃，后续仍由周期覆盖） | `update-bootstrap.ts` 的 `tick()`、`test/update-bootstrap.test.ts`（「触发源叠加不并发跑两次检查」） | §7.10 统一闸门 |
| I-21 | 审核前自证：发布侧 ↔ 客户端同构 | 新增**零 mock 端到端对拍**：用真实 `assembleRelease()`（G1 发布 CLI）产出 `channel.json` / `release.json` / `.sig` 原始字节，再交给真实 `verifySignatureEnvelope` / `validateChannelPointer` / `deriveLatestYml` 校验，覆盖「换 kid 失败」「改一字节失败」「expiresAt 被签名覆盖」「manifestSha256 与实收字节一致」「派生 URL 同源且不含发布说明正文」「产物内无地址/私钥/IP」 | `test/update-signature-parity.test.ts` | §6.1.1 / §6.3 / §8.2 / §9 A② |
| I-22 | 已接受的残余风险（不修，只登记） | watchdog 的 `/D=<installDir>` 来自 HKCU 注册表（§0.7 P0-2 的回退链）。`spawn` 用 args 数组、不经 shell ⇒ 无命令注入；但能写 HKCU 的攻击者本就能以该用户身份执行代码，故不把它算作升级链路的新增攻击面。缓解：`/D=` 恒为最后一个参数且来自只读解析结果；解析不出即 fail closed 不传 `/D` | `scripts/update-watchdog.mjs`、`update/installer.ts`（`resolveInstallDirectory`） | §7.7 安装目录一致性 |
| I-23 | §7.5「重启后：成功不打扰；失败给明确提示 + 重试 / 回滚入口」 | 此前 `startupScan()` 调完 `verifyStartup()` 就**丢弃结论**，失败现场对用户不可见。集成后按 `verdict.pending / verdict.ok` 映射：失败 ⇒ `phase='error' + errorCode='INSTALL_FAILED'`（保留 `pending/` 扫描结果，使重试有目标版本）；成功收尾 ⇒ `phase='completed'`（不打扰）；无待处理事务 ⇒ 维持 `readyToInstall / idle` 原语义。UI 侧新增告警块与「重试安装」「删除已下载包」两个入口，重试仍受活跃工作确认约束 | `update/service.ts` 的 `startupScan`、`src/shell/SettingsUpdatePane.tsx`、`test/update-status-ui.test.tsx` | §7.5 / §7.7 结果回传 / §9 B④ |
| I-24 | §7.10「启动后 90s + 抖动」的**基准时刻** | 集成期自审发现真实缺陷：`service.checkForUpdate` 把 `startupAt` 传成 `p.lastCheckedAt ?? deps.now()`。全新安装（`lastCheckedAt == null`）时它等于「此刻」，于是闸门条件 `now < startupAt + 90s` 恒真 ⇒ **首次自动检查被永久推迟**；又因 `STARTUP_DELAY` 不在调度层的「闸门抑制」集合里，它被当成真实不可用计入退避阶梯，7 次后直接把自动检查降级为仅手动。修法：新增可注入 `processStartedAt()`（缺省 `now() - process.uptime()`，装配时算一次），`startupAt` 改用它；调度层把 `STARTUP_DELAY` 归入抑制集合。两条回归用例锁住「窗口内仍推迟 / 窗口后必须放行」 | `update/service.ts` 的 `startupBase` 与 `UpdateDeps.processStartedAt`、`update-bootstrap.ts` 的 `GATE_SUPPRESSED`、`test/update-service-settings.test.ts` | §7.10 统一闸门 / D7 |
| I-25 | §1.10 审计事件名清单 | 代码里还写了一个清单上没有的事件名 `update.settings-changed`（`service.saveSettings` 与 `resetInstallId` 都走它）。它是**故意绕过** `logUpdateEvent` 的「类型 + 天 + reason」限流、直接 `audit.append` 的：地址变更与 installId 重置都是用户显式动作、频率天然极低，若被限流反而会吞掉「谁在什么时候改了更新源」这条关键留痕。其余 `update.*` 事件仍严格走 §1.10 清单与限流。本行把它补进登记表，避免被读成「未登记的事件名」 | `update/service.ts` 的 `saveSettings` / `resetInstallId` | §1.10 / §6.6「变更写审计」 |
| I-26 | §7.7「超时 / 残留时幂等清理，避免每次启动都提示」+ §7.5「成功不打扰」 | G7c 补测时发现真实缺陷并已修：`verifyStartupWith` 的幂等清理原来**只由 `expiresAt` 触发**，于是「安装结果回传丢失 / 半截 / 属于别的事务」且**运行版本已是目标版本**这一现场，会在 TTL（≤30min）内每次启动都判 `pending:true`；叠加 I-23 的映射后，**升级实际成功的用户会反复看到「上次升级没有成功完成」告警 + 重试入口**。修法：新增分支 ③′（排在过期清理之前）——版本证据成立且无可用结果 ⇒ `pending:false` 收敛、只清哨兵、包与快照一律不动。**语义收紧**：因安装器回传凭据本身不可用，`ok` 仍为 `false`，即「停止 nag」不等于「宣称已验证成功」；结果文件归 watchdog 单写，客户端不越权删除。原分支 `RESULT_MISSING` 仅在版本证据不存在时保留 | `update/installer.ts` 的 `verifyStartupWith` ③′、`test/update/power-cut.test.ts`（场景②③⑤ 改为双向覆盖：版本未到位 / 已到位）、`test/update/install-startup-verify.test.ts` | §7.5 / §7.7 结果回传 / §9 B④ |
| I-27 | §7.9 保留策略 × D13 derived state 的相互作用 | 第二条真实缺陷（本 Agent 自查所得，非代理上报）：§7.9 明文要求成功后**保留当前版本的安装包**作为恢复介质，而 D13 的「可安装」完全由扫描 `pending/` 推导，`verifyCompanion` 的版本判据又是 `version >= app.getVersion()`（§6.5 原式）⇒ 升级成功后状态栏会**永久**显示「已下载完，可以安装 0.3.0」，而用户运行的正是 0.3.0。修法：不改 §6.5 的验签判据（那是设计明文的 `>=`，用于防降级），而在**状态推导层** `pickBestLocal(locals, currentVersion)` 排除「版本恰等于当前运行版本」的那一份——包仍留在盘上作恢复介质，只是不再被显示成待办动作 | `update/service.ts` 的 `pickBestLocal` 与其两处调用、`test/update/service.test.ts`（既有 0.3.0 vs 当前 0.1.0 用例不受影响） | §7.2 / §7.5 / §7.9 / D13 |
| I-28 | §7.7 恢复入口的可定位性 | G7c 发现的第二条：`SENTINEL_INVALID` 分支的 message 只说「可从快照回灌」，却不给路径（其它失败分支都给到 `recoverFromSnapshot(txnId)` 级入口）。已追加 `snapshotsRoot(dataDir)`；恢复介质本身自描述（`manifest.json` 可读），不依赖被损坏的哨兵 | `update/installer.ts` 的 `verifyStartupWith`（SENTINEL_INVALID 分支）、`test/update/power-cut.test.ts` | §7.7 结果回传与恢复 / §9 B④ |
| I-29 | §7.7 步骤 2「逐条写 `update.install-abort` 审计」+ §7.9 事件清单 | 盘点 13 个 `update.*` 事件名的发射点后确认：`update.install-abort` 原先**只在 `update/audit.ts` 的允许清单里出现过，从未被任何代码写过**——gate 的 `abortPendingForQuit` 只记 `proposal.expired`，于是「哪些待审批项被安装动作放弃」在更新事件流里查不到，等于 §7.7 步骤 2 的留痕要求落空。修法：关机钩子的 `abortPendingApprovals` 在 `aborted > 0` 时补写 `update.install-abort {aborted, reason}`（0 条不写，避免噪音）。同时把这套句柄接线从 `main/index.ts` 提为 `update-bootstrap.ts` 的 `createShutdownHooks(rt, dataDir, opts)`，使「六个钩子各接谁 + closeStores 固定顺序 + 快照失败即抛错 / `INSTALL_BLOCKED` 视为跳过」都能被单测直接钉住（此前 index.ts 里的装配代码没有任何测试能覆盖）。**同批盘点结果**：`update.install-cancelled` 至今无发射点，这是**刻意的**——§1.1 明文「取消安装、关机重开、手动删包：都不写状态」，取消确认弹窗因此不产生任何 Main 侧调用；事件名保留在清单中但不谎称已接线（见审核记录 §1.6 U-6） | `update-bootstrap.ts` 的 `createShutdownHooks`、`main/index.ts`、`test/update-bootstrap.test.ts`（5 条新用例） | §7.7 步骤 2 / §7.9 / §1.1 |
| I-30 | §0.4 不变量 3+4 / §9 A②（**R2 · B2，第 1 轮审核**） | `version` 曾被**四条各自为政的宽正则**（`ipc.ts` / `service.ts` / `dirs.ts` / `local-artifacts.ts`）用同一个 `^[0-9A-Za-z.+-]+$` 校验，实测该串**允许 `..`** ⇒ `pendingVersionDir(dataDir,'..')` 折叠成 `<dataDir>/updates`：一次 `clearDownloaded({version:'..'})` 递归删掉整棵更新工作区（含 `update-state.json` 的防降级下限、派生 feed、全部已下载包）；`installUpdate({version:'..'})` 又能把裸放在 `updates/` 根的一套真签名清单当成合法 `pending/<version>/`。修法：判据收敛为**唯一 choke point** `dirs.ts` 的 `isSafeVersionSegment()`（完整 semver + 长度上限，点段无从表达），`pendingVersionDir` 用它并对非法值抛错；三处调用改调同一判据；`verifyCompanion` 追加「目录段必须等于 `release.version`」⇒ 签名有效不再顺带代表落点合法。旧文档里「`../..` 被拒」曾让人误以为穿越已防住——它只是恰好含 `/` | `update/dirs.ts`、`update/local-artifacts.ts`、`update/service.ts`、`main/ipc.ts`、`test/update-version-traversal.test.ts`（新增 7 例，含「攻击尝试后现场完好」） | §0.4 不变量 3/4 / §7.3 / §9 A② |
| I-31 | §6.3 第 4 条「缺失即 fail closed，不得回退到默认状态」（**R2 · B1**） | `update-state.json` 缺失原先等价于 `lastSeenSequence=null` ⇒ 验签第Ⅶ步整体跳过，删档即让「sequence 回退」与「同 sequence 换 nonce」两类重放失效（既有单测还把该行为当期望钉住）。修法：新增 DPAPI 侧**序号下限镜像** `createSeqMirror(keyring)`，它不充当第二份权威状态，只回答「文件缺失是首次装机还是用过之后被删」：镜像空 + 文件缺失 ⇒ 首装放行（本就没有历史可重放）；镜像有序号 + 文件缺失 ⇒ **本次运行拒绝自动更新**并写 `verify-failed`，同时按镜像重建文件，使下次启动恢复正常（既不静默降级也不永久锁死）。配套：`state-store.fileStatus()` 区分 absent/ok/tampered、`enforceFloorFromMirror()` 挡住「MAC 合法但更旧」的回滚文件；`startupScan` 在下限不可信时**不做删坏包的扫描**，避免二次伤害 | `update-bootstrap.ts`、`update/state-store.ts`、`update/service.ts`、`main/index.ts`、`test/update-state-mirror.test.ts`（新增） | §6.3 第 4 条 / §0.4 不变量 1 / §9 A③ |
| I-32 | §0.4 不变量 4 后半句「目标目录…由本机安装位置计算」（**R2 · B3**） | 安装目录此前只来自 HKCU 卸载键（`InstallLocation` → `UninstallString` 父目录），从不与「当前运行的 exe 到底在哪」核对；同用户可写 HKCU ⇒ 可把更新指向任意绝对目录（含 UNC），用户以为已升级而快捷方式仍指旧版。修法：新增 `assertInstallDirAnchored(candidate, execPath)`，以 `dirname(process.execPath)` 为权威，要求候选目录等于其或为其祖先；不符或 `execPath` 取不到 ⇒ **在进入任何关机动作之前** fail closed（顺带把开发态运行位置与安装目录不一致的情况自然挡住）。⚠ **本行的「或为其祖先」半句已被 I-55 收紧为「只认精确相等」并加了盘根 / UNC 共享根 / 用户主目录的兜底拒绝（R8 · Major-3）**：那句话留着会让下一个读者以为祖先算相符——恰恰是 R8 判定的攻击入口；本行按原文保留作过程记录 | `update/installer.ts`、`test/update/install-transaction.test.ts`（新增 4 组 + 3 处 fixture 的 execPath 改为与注册表目录一致） | §0.4 不变量 4 / §7.7 安装目录一致性 / §9 B② |
| I-33 | §7.7 单向性 / §0.4 不变量 3「失败必须可恢复」（**R1 · B-1**） | `blocked()` 原先无条件撤销 `isUpdatingRef` 并把控制权交回运行态：在 `runOnce()` 之后失败时，三个 store 已 close、`pool.stopped` 已置位、documentParse 与 reviewer 已停 ⇒ 留下不能再写库、不能再开会话、重试安装还返回「可安装」的半关机僵尸进程（且 `controller.reset()` 全仓零调用，本进程永不能再跑序列）。修法：控制器新增 `progress()`（记录**已进入**的步骤），`blocked()` 据此判不可逆 ⇒ 保持 `isUpdating`、返回 `quitRequested:true` 并请求退出；仅在序列尚未开始的可撤销阶段才回到普通退出语义。service 侧对应用 `phase='restarting' + INSTALL_FAILED` 如实反馈，不再谎报「回到可安装」。`InstallPlanResult` 增可选 `quitRequested`（契约 §6 必备字段未变） | `update-bootstrap.ts`、`update/installer.ts`、`update/service.ts`、`test/update/install-transaction.test.ts`（6 例改写 + 2 例新增） | §7.7 严格顺序 / §0.4 不变量 3 / §9 B④ |
| I-34 | 第 1 轮 Major / Minor 的集中落地 | ①**Major-1**：`shouldCheck` 把离线判定提到所有「提前放行」通道之前——`RESUME` 分支原先排在 `NETWORK_OFFLINE` 之前，resume / 解锁补检会在 `net.online===false` 时照样发请求，直接违反 §7.10「离线不发请求」（§7.10 的列举顺序是叙述顺序，不是判定顺序）。②**Major-2**：启动首检的排期与闸门上界错位（bootstrap 用 `jitterDelay(seed,90)∈[76.5,103.5]s`，闸门是 `90+[−9,+9]s`）⇒ 约半数现场首趟白跑、退到 15min 心跳；改为 `max((delay+15)s, jitter)` 恒越过闸门且保留散布。③**Major-3**：executor 的审计按性质分流——`corrupt` / 异源跳转 / https→http / 无 Range 的 206 ⇒ `update.verify-failed`；404/5xx、连接与停滞超时、用户取消 ⇒ `update.failed`（取消不写审计），避免把普通下载失败镜像成「验签失败」误告警。④**Minor**：`second-instance` 增加 `win.isDestroyed()` 检查；`SettingsView` 新增 `initialPane`，pill 直达「关于」（I-13 的前半句此前不成立，R1 · B-2） | `update/scheduler.ts`、`update-bootstrap.ts`、`update/updater-adapter.ts`、`main/index.ts`、`src/shell/SettingsView.tsx`、`src/App.tsx`、`test/update-bootstrap.test.ts`、`test/update-status-ui.test.tsx` | §7.10 / §7.9 / §7.5 / I-13 |
| I-35 | §6.3 第 4 条「本次运行停用」的可见性（I-31 的自检补漏） | I-31 落地后自查发现：`refreshTiming()` 每次都用 `st.isTampered()` **重算** `state.stateTampered`，而删档分支里状态文件已按镜像重建 ⇒ `isTampered()` 变回 `false` ⇒ Renderer 下一次 `getState()` 就把「本次运行已停用自动更新」的告警抹掉了（`SettingsUpdatePane` 的 `tampered` 判据来自这个字段），磁盘下限仍在但界面上看不出异常；`startupScan()` 的同名赋值有同样问题。修法：新增**只抬不降的闩锁** `tamperLatched`，在「文件被抹掉」「MAC 校验失败」两处置位，`refreshTiming` / `startupScan` / `checkForUpdate` 一律从闩锁取值为 `state.stateTampered`；闩锁不写盘、不跨进程 ⇒ 不引入任何「持久封锁」，重启后按镜像正常恢复 | `update/service.ts`、`test/update-state-mirror.test.ts`（新增 12 例，其中「重建后不再报状态异常」与「本次运行拒绝」成对钉住两侧） | §6.3 第 4 条 / §7.5 / §9 A③ |

| I-36 | §6.5 扫描的健壮性 / §0.4 不变量 3（**R3 · Major-4**） | I-30 把 `pendingVersionDir` 改成「非法段直接抛错」之后，`scanPending` 的 `readdir` 循环把**目录名原样喂给它** ⇒ `pending/` 下任何遗留的非 semver 目录（`0.2.0.tmp`、`Thumbs.db`、用户手工放的文件夹）都会让整个 `scanPending` 抛错；而 `startupScan` 的抛错在 `index.ts` 被装配 try 吞掉 ⇒ **更新服务静默不装配、排期永不启动**，手动检查则被折算成 NETWORK 失败并进退避阶梯。修法：循环内先用唯一判据 `isSafeVersionSegment` 过滤，非法段**跳过且不删除**（抛错会把无关目录的影响放大到整条链路，删除则是在动一个无法证明属于更新链路的路径；坏包删除仍只发生在通过判据的目录里） | `update/local-artifacts.ts`、`test/update-version-traversal.test.ts`（新增 5 例：混合现场 / 纯遗留目录 / startupScan 实跑） | §6.5 / §0.4 不变量 3 / §9 A⑤ |
| I-37 | §7.7 单向性（**R3 · Blocker-2 后半**） | 安装失败走不可逆分支后 `isUpdating` 保持 true 并 `requestQuit`，而 before-quit 守卫只看 `hasRun()`——序列**半途抛错时 `hasRun()` 是 false** ⇒ 守卫 preventDefault 再跑一遍 `runOnce()`，把 `closeStores` 与整 `data\` 快照在已拆掉的躯体上执行第二遍。修法：`progress()`（已进入的步骤名）提升为 `UpdateShutdownController` 的正式可选成员，守卫在 `progress().length > 0` 时**不重跑**、只放行退出并 warn 一条（现场已不可逆，恢复入口交给哨兵与下次启动） | `update/service.ts`（接口）、`update-bootstrap.ts`（`createUpdateQuitGuard`）、`test/update-bootstrap.test.ts`（新增 1 例：两次 before-quit 后 `closeStores` 仍只 1 次） | §7.7 严格顺序 / §9 B⑤ |
| I-38 | 第 10 条纪律：测试必须真的钉住判据（**R3 · Blocker-1 + Major-3**） | 两处「测试看着绿、其实没测」：①`update-state-mirror.test.ts` 的闸门用例依赖真实 `Date.now()` + `installId=randomUUID()` 的 ±9s 抖动 ⇒ 同一用例 P(STARTUP_DELAY)≈0.5063（R3 用 2 万随机 UUID 实测，单文件重复 8 次 PASS=2/FAIL=6），我此前把一次运气跑当成了全量结论；改法是在 fixture 里固定 `processStartedAt`（进程已启动 1h），现在 10/10 稳定。②`update-version-traversal.test.ts` 的落点用例用**假签名信封**且未传 `keys`，`verifyCompanion` 在 `SIGNATURE_INVALID` 就返回，I-30 的新分支从未被执行到，再加一条 `expect(x).not.toBe(undefined)` 的**恒真断言**；改法是真 Ed25519 签 + 同字节对照组（名字一致 ⇒ ok）+ 精确断言 `reason === 'POINTER_INVALID'`。③I-33 的「不可逆」判据此前零覆盖：假控制器不带 `progress()`，`entered` 恒空，整个分支删掉也全绿；改法是用真的 `createShutdownController` 写两条（已进入 `stopPool` ⇒ `quitRequested` + 保持 `isUpdating`；第一步就抛 ⇒ 可撤销） | `test/update-state-mirror.test.ts`、`test/update-version-traversal.test.ts`、`test/update/install-transaction.test.ts`、`test/update-bootstrap.test.ts` | §9 A⑦ / 第 10 条纪律 / I-30 / I-31 / I-33 |
| I-39 | 口径与落点一致性（R3 · Minor） | ①设计稿 §9 A⑤「不依赖状态文件」按 R3 的表态**订正措辞**（加前提，原句不删，见审核记录 §1.5 第 3 行），代码顺序不动；②`service.installUpdate` 里手写 `join(dataDir,'updates','pending',version,…)` 绕开了 choke point（version 已在入口校验，无可利用性，但属判据漂移风险）⇒ 改走 `pendingVersionDir()`；③`service.ts` 文件头与安装调用处还留着「installer.ts 为 A 关占位、返回 INSTALL_BLOCKED」的过时注释 ⇒ 就地改为描述真实事务 | 设计稿 §9（A⑤ 括注）、`update/service.ts` | §9 A⑤ / §0.4 不变量 3 / §7.7 |

| I-40 | §7.7 单向性（**I-37 的自检补漏，非代理上报**） | I-37 只堵住了 before-quit 这一扇门：`blocked()` 保持 `isUpdating` 之后，用户**立刻再点一次「安装」**（或直接调 `sparkii:installUpdate`）会再次进入 `runInstallTransaction` ⇒ 控制器此时 `done=null`、`inFlight=null`、`entered` 非空，`runOnce()` 的幂等门只认前两者，于是把 `stopPool` / `closeStores` / 整盘快照**从头再执行一遍**。修法：控制器把「已进入过 `abortPendingApprovals` 之外的任一步」定义为 `dismantled()`，`runOnce()` 在 dismantled 时直接抛错拒绝（既不静默成功也不重跑），`blocked()` 因此自然落到不可逆分支并保持退出意图；`installer.ts` 的不可逆判据同时改为**优先用 `dismantled()`**（原来只查 `stopPool` / `closeStores` 两步，漏了 `stopDocumentParse` / `disposeReviewer` / `snapshotData`——只走到这三步的现场同样不可能继续正常服务）。可撤销现场（只有审批门显式过期）不受影响，仍可正常重跑 ⇒ 拒绝重跑不等于永久封锁 | `update-bootstrap.ts`、`update/installer.ts`、`update/service.ts`（接口）、`test/update-bootstrap.test.ts`（新增 2 例）、`test/update/install-transaction.test.ts`（新增 1 例端到端二次点击） | §7.7 严格顺序 / §0.4 不变量 3 / §9 B⑤ |

| I-41 | 同 I-38：闸门不得用「运气」当判据（**I-38 的延伸，自己扫出来的第二处**） | 顺着「还有谁把随机/环境当结论」这条线，把全仓 `checkForUpdate(false)` 的调用点逐个过了一遍，又找到一处：`test/update-service-settings.test.ts` 的「缺省基准取自 `process.uptime()`」用例读**真实进程存活时长**，并写成 `if (uptimeSec > 95) expect(r.reason).toBe('NETWORK')` 的条件断言。`startupBase` 走 uptime 时 elapsed 与 `90 + 抖动(±9s)` 比较 ⇒ 当存活时长落在 `(95, 90+抖动]` 这段窄窗且抖动为正时，`reason` 是 `STARTUP_DELAY` 而条件断言要求 `NETWORK` ⇒ 直接翻红。修法：`vi.spyOn(process,'uptime').mockReturnValue(600)` 把基准钉死（try/finally 还原），断言改为确定性的 `toBe('NETWORK')`——这条用例的证明目标本来就是「基准取 uptime 而不是取 now」，打桩之后反而更贴合原意。修后同一文件连跑 6 次 PASS=6 / FAIL=0 | `test/update-service-settings.test.ts` | §7.10 / §9 A⑦ / I-38 |

| I-42 | §0.4 不变量 3「版本段判据只有一处」的收尾（R3 旁证，我判断后决定收紧） | R3 在复核 I-30 时留下一条旁证：`verifier.ts` 还留着第二条独立判据 `VERSION_RE = /^[0-9A-Za-z.+-]+$/`，**它同样允许 `..`**；它不参与落盘路径（用于 `releases/<version>/<name>` 的 URL 派生与 `channel.json` 指针形态校验），加上强制同源 + 字节哈希终检，确实不可利用——但「同一件事两条判据」正是 R2 · B2 出事的形态，留着就是下一次漂移的种子。修法：删除 `VERSION_RE`，`validateChannelPointer` 与 `deriveLatestYml` 两处都直接调用 `dirs.isSafeVersionSegment`（判据回到一处） | `update/verifier.ts`、`test/update-version-traversal.test.ts`（新增 2 组：正常 semver 两条判据都放行 = 对照，`..` / `.` / `../..` / `0.1.0/..` / `0.1;rm -rf` 在指针校验与 URL 派生两处一律被拒） | §0.4 不变量 3 / §6.3 / I-30 |

| I-43 | §6.3 第 4 条的**存储前提** / §7.8 快照可恢复性（我自己为写运维口径而实测发现） | 更新密钥原名带冒号（`update:hmacKey` / `update:seqMirror`），而 `Keyring.file()` 拼的是 `${name}.enc`。Windows 把带冒号的路径解析成「基名 `update` 上的**备用数据流 ADS**」：本机 `writeFileSync`/`readFileSync` 全部成功（因此单测与开发机一路绿），但 `readdirSync` 只列出 `update`，目录里并不存在那两个可枚举的文件。后果：①§7.8 的整 `data\` 一致性快照按文件逐条哈希，主 stream 是 0 字节的 `update` ⇒ 「快照保住了 keyring 里的更新密钥」这句话不成立；②任何不保留流的复制 / 备份 / 漫游都会静默丢掉 HMAC 密钥与**序号下限镜像**，镜像一丢，I-31 的删档防护就退化成「当作首装」；③运维手册原本要写的「删除 `keyring/update:seqMirror` 排障」在真机上无从下手。修法：两个 keyring 名去冒号（`update-hmacKey` / `update-seqMirror`），并加两条回归钉（名字不得含 `:` 或 Windows 保留字符；按 `Keyring.file()` 形状必须写出**两个可枚举文件**、且不得出现基名 `update`）。功能未发布 ⇒ 不存在需要迁移的真实用户机器；跑过旧名的开发机需先手工删 `updates/update-state.json` 再验（不加兼容垫片）。⚠ 同一形态在产品既有代码里也存在（`settings.ts:100` 的 `apiKey:<providerId>`，真机 `keyring/` 里只有一个 0 字节 `apiKey` 基名文件），**不在本次范围**、未改动，仅登记 | `update-bootstrap.ts`（两个常量 + 注释）、`test/update-bootstrap.test.ts`（新增 2 例）、`docs/operations/update-service.md`、`docs/release-windows.md`（M-10 名字更正） | §6.3 第 4 条 / §7.8 / §7.9 密钥存储 / I-31 |

| I-44 | §6.3 第 4 条的**写侧**闭合（I-43 同一次运维口径撰写中发现） | `checkForUpdate` 成功后把下限同步进 DPAPI 镜像那一步原本是 `await deps.seqMirror?.write({...}).catch(() => undefined)` —— **写失败被静默放过**。攻击面不是理论上的：同用户把 `keyring/` 目录设成只读（或让 safeStorage 写入抛错），镜像就永远为空，之后再删 `update-state.json` 在这台机器上就**永远表现为首次装机** ⇒ I-31 的删档防护被整条绕开，而读侧的 fail closed 全对（read 侧确实会毒化）。修法：写镜像改为显式 try/catch，失败时 `markCheck` + 写 `update.verify-failed`（detail `seq mirror write failed: …`）+ 走统一的 `tamperRefusal()`：**抬闩锁、置 `stateTampered`、`phase=error`、返回结构化拒绝**，本次运行不再放行；顺带把「文件缺失」那一条也收敛到同一个出口（两条现场的 message 与审计各自保留，不重复记录）。⚠ 语义要说准：这不是「本机已确认被攻击」，而是「防回退锚点当前不可写 ⇒ 无法区分首装与被删档 ⇒ 按不可信处置」，所以拒绝只维持到本次运行，重启后若镜像可写即恢复正常 | `update/service.ts`（新增 `tamperRefusal()`、写侧 try/catch）、`test/update/service.test.ts`（新增 1 例：`read→null` + `write 抛错` 的镜像，两次检查都拒绝、标志保持、审计落痕） | §6.3 第 4 条 / §0.4 不变量 1 / I-31 / I-35 |

| I-45 | §5.5 / §6.1 产物口径的**可无人构建性**（由 skip 计数漂移引出） | `test/update-artifacts.test.ts:154` 用 `it.skipIf(!existsSync(appUpdateYmlPath))` 守「app-update.yml 不含 `publisherName` / 不含真实 IP」这条断言 ⇒ 没跑过 `dist` 时它静默跳过。核对时发现**当时没有任何恒实跑的同类断言兜着**（我原以为 `test/release-config.test.ts` 有，grep 其 `it(` 列表证伪）。补法：新增一条从**配置侧**恒实跑的断言——`publish` 恰为 `{provider:'generic', url:PLACEHOLDER}`、URL 不匹配 IPv4、`win.publisherName` 缺省，与产物侧断言口径一致（前者证「配置不会生成带 publisherName 的 app-update.yml」，后者证「生成结果确实如此」） | `test/release-config.test.ts`（+1 例 ⇒ 2→3） | §5.5 / §6.1 / §9 A②③ 的产物面 |

| I-46 | 拒绝的**入口一致性**（I-44 的第三扇门，正是 I-40 那条教训的复用） | I-44 让 `checkForUpdate` 在锚点不可写时拒绝本次运行，但 `downloadUpdate` / `installUpdate` 各自只跑自己的验签门禁，**不读闩锁** ⇒ 同一现场下界面明明写着「本次运行已停用自动更新」，手动点下载 / 安装却仍能走通（历史包重放在这条路径上只靠已被删除的状态文件下限，形同无防线）。修法：两个入口开头各加一道 `if (tamperLatched) return bad('STATE_TAMPERED', …)`；**`clearDownloaded` 刻意不加**（用户在被拒绝的运行里仍应能丢弃已下载的包，封锁清理只会把现场留在盘上）。另在 §1.6 新增 U-7 把这条链路的**信任边界上限**写清：同一 Windows 用户可以把状态文件与镜像**一起**删掉，此时任何本地锚点都表现为首装，所以镜像的准确定位是「防误删 / 防单点回滚」，不是「防同用户攻击者」；后者的真边界是签名 + `expiresAt` 可撤回 + P2 的服务端发布透明日志 | `update/service.ts`（`downloadUpdate` / `installUpdate` 开头各一处 + 注释）、`test/update/service.test.ts`（I-44 用例扩出 4 条断言：下载拒、安装拒、清理不连带被封）、审核记录 §1.6 U-7、`docs/operations/update-service.md` §3.1（症状表补上：被拒绝的运行里手动下载 / 安装同样被拒、`clearDownloaded` 不受此门限制、四种审计 detail 字符串怎么区分） | §6.3 第 4 条 / §7.3 门禁 / §0.4 不变量 2 / I-40 / I-44 |

| I-47 | §7.7 单向性 / §9 B⑤（**R4 · Major-1 + Minor-1/2/3**） | R4 判 I-37 的守卫「方向对但工具选错了」：它用 `progress().length > 0` 一刀切放行，**分不清「正在进行」与「试过但失败」** ⇒ 序列 in-flight 时用户第二次关窗，守卫直接放行，主进程可以在 `stopPool` / `closeStores` 做到一半时被终止 ⇒ Pi 子进程残留、SQLite 不 checkpoint（正是 §9 B⑤ 要防的）。四处修改：①控制器新增 `running()`（= `inFlight != null`），守卫在 running 时**照常 preventDefault 并挂到同一次 `runOnce()`**（内部共享 inFlight ⇒ 既不拆第二遍，也保证退出发生在序列结束之后）；②「试过但失败」的放行分支改用 `dismantled()` 判据，与 `installer.ts` 的 `blocked()` **同一条口径**（Minor-1：原先一个看 `progress()`、一个看 `dismantled()`，只在「仅审批门进去过」这种现场结论相反）；③多个等待者共享一次序列时 `app.quit()` 只允许真正请求一次（新增 `doQuit()` 去重，否则 before-quit 会被连环触发）；④**删除 `reset()`**（全仓零调用点，却会把 `entered` 记忆清空 ⇒ 留着等于自带一个绕过 I-40 的把手，Minor-2）。另修 R4 · Minor-3 的**真实那一半**：`mirrorSaysStateWasDestroyed` 里的 `enforceFloorFromMirror()` 是写盘操作，原来裸奔 ⇒ 只读目录 / EACCES / 磁盘满时异常一路抛出 `startupScan`，打断装配；现在两处都包起来，写不回锚点就**按不可信处置**（结构化 STATE_TAMPERED 拒绝 + 审计 detail `state rebuild failed` / `floor raise failed`）。⚠ **R4 该条的另一半被我证伪**：`pruneRetainedDetailed` 的每个 `rm` 与 `listDir` 都各自 catch（`installer.ts` 的 prune 循环内 `catch (err)` + warn，`listDir` 失败返回 `[]`），不存在它担心的「保留策略抛错打断启动」⇒ 未为此改代码 | `update-bootstrap.ts`（`running()`、守卫三分支、`doQuit()`、删 `reset()`）、`update/service.ts`（接口 + 重建兜底）、`test/update-bootstrap.test.ts`（+1 例：in-flight 第二次退出仍被拦、拆机步各只执行一次、序列结束后才 quit；并把原 I-37 用例的判据换成 `dismantled()` 口径）、`test/update-state-mirror.test.ts`（+1 例：把 `update-state.json` 占成目录以逼出 rename 失败，断言结构化拒绝且 `startupScan` 不抛） | §7.7 严格顺序 / §0.4 不变量 3 / §9 B⑤ / I-37 / I-40 |

| I-48 | §6.3 第 4 条的**假阳性**（**R5 · Blocker-1，本轮最严重的一条**） | I-31 引入的 `UpdateStateStore._absent` 是「只置不清」的闩锁：`applyDecode(null)` 置 true（`state-store.ts:78/101`），但 `persist()` 写完文件后**从不清它**（只在重新读到内容时清，`:105`）⇒ 同一个 store 实例一旦经历过「首装 ⇒ 第一次成功检查」，`fileStatus()` 就永远返回 `'absent'`；而镜像恰恰是同一次检查写下的（有值），于是 `mirrorSaysStateWasDestroyed()` 把**正常机器**判成「删档攻击」：同进程内第二次 `checkForUpdate` 起一律 `STATE_TAMPERED`、`stateTampered=true`、写 `update.verify-failed`（并经审计 sink 镜像到错误面板），I-46 之后还连带封掉下载与安装 ⇒ §9 A① / A④ / A⑤ 在默认路径上不成立。R5 用真 HTTP 源 + 真签名 + 真状态文件实测：写后同一实例得 `'absent'`，而**新实例读同一份字节**得 `'ok'`、`isTampered()=false`（两个锚点都完好）。测试为什么没抓到：`fileStatus()` 只在**新建实例**上被断言（`state-store.test.ts:33`、`update-state-mirror.test.ts:64-105`），而所有服务级用例的 baseUrl 都注定网络失败 ⇒ `recordSeen` + 镜像写 + 第二次检查从未在同一个实例里连起来跑过。**这是同一课第三次**（I-38 假替身 / I-41 运气跑 / 这次「真实成功路径从未跑过」）。修法：`persist()` 成功 rename 之后清掉 `_absent`（文件此刻确实存在且 MAC 由我们自己算）。安全方向没有放宽任何一条：写不回文件时 `persist()` 抛错，仍由 I-47 的兜底转成结构化拒绝 | `update/state-store.ts`（persist 尾部 + 注释说明为什么必须清）、`test/update/state-store.test.ts`（新增 1 例：同一实例 `absent → ok`，含 `enforceFloorFromMirror` 那条路）、`test/update/service.test.ts`（新增 1 例端到端：检查 → 下载 → **再检查** → `startupScan` → 安装，全程不得出现 `STATE_TAMPERED`） | §6.3 第 4 条 / §9 A①④⑤ / I-31 / I-35 / I-46 |
| I-49 | §0.4 不变量 3 / §6.3 判据同源（**R5 · Major-1**） | I-42 只把客户端一侧收敛了，**发布侧还留着两条各自为政的判据**：`verify-release.mjs:26/54` 对 `channel.targetVersion` / `release.version` 只判「非空字符串」，`publish-release.mjs:23` 的 `SEMVER_RE = ^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$` 也允许 `1.0.0..evil` 这类点段尾巴。R5 实测 8 条非法段（`..` / `...` / `0.3.0/..` / `%2e%2e` / `0.3.0::$DATA` / `CON` / 70 字长）：**发布自检一律 `OK 放行`，客户端一律 `POINTER_INVALID`**——而发布 SOP 的上传门正是那条 OK ⇒ 手搓树或上游回归时能静默上线一份 100% 客户端拒收的清单。修法：把判据做成发布侧的单一导出口 `publish-release.isValidVersionSegment()`（与客户端 `dirs.ts` 的 `VERSION_SHAPE_RE` 逐字同形），`assembleRelease` / `verify-release` 的 `targetVersion` / `version` 全部改调它；另外把 `artifact.name` / `artifact.url` 从「宽字符类正则」升级为**必须由已判合法的版本段推出**（`Sparkii-<version>-win-x64.exe` 与 `releases/<version>/<name>` 逐字相等），否则 `Sparkii-..-win-x64.exe` 仍能过关 | `scripts/publish-release.mjs`（导出 `isValidVersionSegment`、删掉本地 `SEMVER_RE`）、`scripts/verify-release.mjs`（4 处：import + targetVersion + version + 名字/URL 推导相等）、`test/update-version-parity.test.ts`（**新增**：同一语料两侧逐条对拍 + 合法段正路对照 + `assembleRelease` 拒非法段 + 真签名树把 `targetVersion` 换成 `..` 后自检必须拒且拒因含 `POINTER_INVALID`）、`test/publish-release.test.ts`（一条既有用例的期望从 `/manifestPath/` 改为 `/invalid --version/`——防线前移，判据只剩一条，不是放宽） | §0.4 不变量 3 / §6.3 / §6.1.1 / I-30 / I-42 |
| I-50 | §7.9 审计限流的可用性（**R5 · Minor-1**） | 限流键是 `action\|天\|reason`，不含现场标识 ⇒ 四种 `STATE_TAMPERED` 现场（文件被删 / 镜像写不回 / 状态文件写不回 / 抬不动下限）在同一天只落 **1 条**审计，而运维手册 §3.1 教人「按 detail 区分根因」——只有第一条成立；`scanPending` 的 `removed:true` 也被同键吞掉。修法：键里加一个**受限的** `subreason` 标识（`^[A-Z][A-Z0-9_]{0,31}$`，四个站点各给固定值），非法/超长/小写一律退化为空；绝不把 detail 原文放进键——那等于给攻击者一个「每次换个键」的刷库通道。`scanPending` 那类可被服务端垃圾清单触发的事件保持原粒度不细化 | `update/audit.ts`（限流键 + 注释）、`update/service.ts`（四处 `subreason: 'STATE_FILE_DELETED' \| 'MIRROR_WRITE_FAILED' \| 'STATE_REBUILD_FAILED' \| 'FLOOR_RAISE_FAILED'`）、`test/update-state-mirror.test.ts`（新增 1 例：四种现场各一条、同现场重复 50 次仍一条、无 subreason 的旧形态不受影响、非法 subreason 退化为空）、`docs/operations/update-service.md` §3.1 | §7.9 / §6.3 第 4 条 / I-34 / I-44 / I-47 |
| I-51 | 审核记录与发布检查表的**说做一致**（**R5 · Major-2**） | 审核记录 R2 处置列写着「发布脚本与客户端的密钥有效期口径差异**写进发布检查**」，但 `docs/release-windows.md` 的「发布检查」节与 `update-service.md` 的发布 SOP 都没有这句话——属「把将来的动作写成已完成」（本仓第 10 条纪律点名过的老毛病，这次落在我自己写的处置列里）。修法：真的把三条人工确认项（kid↔公钥对应、密钥有效期口径、上传后的远端回读）逐条写进 `release-windows.md` 的发布检查节，并加上 I-49 那条「判据两侧同源，改任一侧必须让 parity 测试先红」；A1–A3 本身仍**如实标为后续加固**，不冒充已闭合 | `docs/release-windows.md`（发布检查节新增 4 条）、审核记录 R5 表 | §8.2 / §7.9 / R2 · Minor A1–A3 的登记口径 |

| I-52 | §7.7 步骤 9「`install-result.json` 单一写入方」在 Windows 上的**真实形态**（验证窗口里自己抓到的产品缺陷，非代理上报） | 起因是收口纪律「连跑两次数字一致」：I-48…I-51 之后第一次空闲连跑，RUN 1 红了 `test/update-watchdog.test.ts` 的「单一写入」用例、RUN 2 全绿。按 §1.1 的纪律我先去隔离复现，**隔离连跑 10 次红 2 次 ⇒ 不是负载噪声，是真缺陷**。根因：`writeResultAtomic()` 先写 `<result>.<pid>.<ts>.tmp` 再 `renameSync(tmp, result)`，注释还写着「Windows 上 rename 可覆盖已存在目标」——但目标若正被另一个进程打开（另一 watchdog 刚 rename 完、或父进程正在读结果），Windows 的 rename 会以 `EPERM/EBUSY` **失败**，而原实现裸调 ⇒ 抛错的一方把自己的 `.tmp` 永久留在 `data\updates\`（每约 5 次并发触发 1 次）。修法：rename 包 try/catch，失败时尽力 `unlinkSync` 自己的临时文件、把这一次写入**让给先赢的写入方**（结果文件仍是先写者那份完整 JSON，绝不覆盖、不留垃圾），并向 stderr 记一行让位原因；watchdog 不因让位而崩溃、不改判安装结果。测试面：该用例从「单轮现场」改成 **8 轮独立现场**（每轮都断言完整 JSON + 零 `.tmp` 残留）——这条性质只在竞态真被触发时才可见，单轮跑等于把结论交给运气；改后隔离连跑 10 次 = 10/10（合计 80 组并发、零残留）。**⚠ **真机可能性要说准**（否则等于夸大）：两个 watchdog 并发不是纯人为构造——用户在第一次安装还没结束时再点一次「重试安装」，`runInstallTransaction` 会各起一个 detached watchdog 并同写一个 `install-result.json`，所以残留会真发生；但"同一秒内两个都活着"这一具体时序本机无法验证，已列 **M-12** 供真机确认。而同一轮还红过另一条**（`packages/agent-host/test/pi-runtime-pool-skill-isolation.test.ts`，15s 超时），那条隔离 6/6 通过且机理上碰不到本次改的闸门，判为负载抖动，已登记 U-8——两条一起构成教训：**「RUN 1 红、RUN 2 绿」不能笼统归因于负载，必须逐条隔离重跑才能分辨** | `scripts/update-watchdog.mjs`（`writeResultAtomic` + 文件头第 6 条口径 + 新增 `unlinkSync` 导入）、`test/update-watchdog.test.ts`（8 轮化 + 120s 预算） | §7.7 步骤 9 / §6.5 结果文件 / §9 B②④ / I-16 |

| I-53 | §7.7 退出路径 / §6.3 第 4 条的**入口枚举**（**R7 复审：3 Major + 1 Minor**） | R7 判 I-47「四件事都在盘上」，但其中三件各自留了一个只有跑起来才现形的洞：① **N-1**——`doQuit()` 的一次性去重闩锁与「在飞分支不撤销 `isUpdating`」叠加，造出新的死区：事务那趟 `runOnce()` 在飞时用户关窗 ⇒ 守卫挂在同一次 promise 上；那趟在**第一步（审批门）**失败 ⇒ reject 分支请求退出并把闩锁立死，而现场根本没拆过，于是第二次退出重跑成功、六步全做完，`doQuit()` 却已成空操作 ⇒ 进程带着已关闭的 SQLite 常驻，正是 I-33 禁止的半关机僵尸态（守卫路径上还没有 `index.ts` 的 3s `exit(0)` 兜底）。② **N-2**——`deferUpdate` / `skipUpdate` / `resetInstallId` 三个写状态的入口把 `EPERM: rename` **原样抛给 IPC**（无结构化 reason、无审计），UI 直接显示操作系统错误串：I-47④ 定的「写不回＝结构化拒绝」标准只落在 5 个写入点中的 2 个。③ **N-3**——`checkForUpdate` **不读 `tamperLatched`**：删档被检出并按镜像重建之后，同一次运行里调度器补检 / 用户手动检查会恢复出网并报「发现新版本」，与 §6.3.4「本次运行一律拒绝自动更新」和闩锁自己的注释矛盾；而原用例看着像覆盖了，实为 fixture 恒 `read()=null` 反复撞镜像写失败，从未跑到「重建成功之后」那一格。④ **M-4**——`cancelDownload` 完成后无条件 `setPhase(available)`，把 `errorCode=STATE_TAMPERED` 洗成正常。修法：①删掉 `quitRequested` 闩锁（`app.quit()` 可重入，重复请求只会再派一次 before-quit，而那时守卫的两个前置判断会直接放行），并在在飞分支的 reject 里按「未拆机 ⇒ 退回普通退出语义」同口径处理；②三个入口统一走新增的 `refusalOnWriteFailure()`（结构化 `STATE_WRITE_FAILED` + 审计，subreason 带方法名 ⇒ 三种方法各留一条，枚举有限不构成刷库通道）；③`checkForUpdate` 开头读闩锁直接拒绝；④`cancelDownload` 在闩锁立着时保持 `error/STATE_TAMPERED`。测试：`update-bootstrap.test.ts` 新增 1 例（建模 Electron 的 quit 重入，断言「拦而不得两次」）、`service.test.ts` 新增 2 例（三个方法的状态写失败；被拒之后再检查不出网且取消下载不洗状态） | `update-bootstrap.ts`、`update/service.ts`、`test/update-bootstrap.test.ts`、`test/update/service.test.ts`、`docs/operations/update-service.md` §3.1 | §7.7 / §6.3 第 4 条 / §9 B⑤ / I-33 / I-37 / I-40 / I-46 / I-47 |
| I-54 | 第 10 条纪律（证据必须承重）与文档口径的收尾（**R9 复审：10 条不一致 + 3 条零覆盖**） | R9 逐行核完 §10 的 I-1…I-52（未抽样），六个重点条目实测落地，但挑出：① **D-4（中）** I-27 的 `pickBestLocal` 排除「版本恰等于当前运行版本」在全仓**没有任何正向用例**——把 filter 删掉照样全绿；② **D-6（中低）** I-45 只补了 `publisherName` / publish URL 两条，`latest.yml 不含真实 IP` 那条仍只有 `it.skipIf(产物存在)` 版，没构建时无人守；③ **D-5（低）** `release-config.test.ts` 从 yml 迁到 mjs 时丢了 `win.icon` 断言；④ **D-1（低）** I-16 行写「extraResources 第 10 项」，实际共 9 项（watchdog 是第 9，yml 快照常量 8 项）；⑤ **D-2 / D-3（低）** I-4「离线判定排在最后」与 I-9「同一字符类校验」都已被 I-34 / I-30 推翻却未标注取代关系；⑥ **D-7 / D-8 / D-9 / D-10（低）** §3.1③ 的 10/12 用例、§3.2 的 21 文件 376 用例、§3.5 的 37 ??、`publish-release.test.ts:279` 把 I-49 写成 I-48，均未随盘态回写。修法：①在 `service.test.ts` 补一条用例，内含**正向**（同版本 ⇒ 不显示可安装、包不被删）与**对照**（低版本 ⇒ 仍显示）两组断言；②在 `test/update/verifier.test.ts` 加**恒实跑**的派生 yml 判据（不含任何 IPv4、主机只来自配置）；③补回 `win.icon` 断言；④⑤在 §10 对应行就地改数或加「已被 I-xx 取代」交叉引用；⑥按当轮实测回写（其中依赖本轮新增用例的那几个计数，以收口验证那一批取数为准，不提前写死）。另外 R9 明确它**没有跑**全量与 lint，故 A⑦ 在那一轮记为「未判定」，由主 Agent 的空闲连跑两组数字承担 | `test/update/service.test.ts`（+3 例：N-2、N-3/M-4、I-27 正向钉）、`test/update/verifier.test.ts`（+1 例）、`test/release-config.test.ts`（win.icon 一条）、§10 的 I-4 / I-9 / I-16 三行、审核记录 §3.1③ / §3.2 / §3.5、`test/publish-release.test.ts` 注释串号 | 第 10 条纪律 / §9 A②③⑤⑦ / I-27 / I-45 / I-49 |
| I-55 | §0.4 不变量 4 后半句 / §7.7「安装目录与旧版一致」（**R8 · Major-3**，安全线复审判不通过的第 3 条） | I-32 的锚点判据是「候选目录等于 `dirname(execPath)` **或是它的祖先**」，而候选来自同用户可写的 HKCU 卸载键。放掉祖先等于放掉三类真实攻击/事故形态：`C:\`（盘根）、`%USERPROFILE%`（主目录）、`\\fs\share`（UNC 共享根）都能被写成「运行位置的祖先」并通过检查，于是 `/D=<那个目录>` 把升级铺到别处，用户以为升级完成而快捷方式仍指旧版——正是本条要防的那件事。修法：**只认精确相等**（大小写与尾分隔符归一后），任何祖先/子孙关系一律 `INSTALL_DIR_MISMATCH_WITH_RUNNING_LOCATION`；相等之后再加一道「过宽目录」兜底 `INSTALL_DIR_TOO_BROAD`（盘根 / UNC 共享根 / `USERPROFILE`|`HOME` 本身），per-user NSIS 的安装目录就是 exe 所在目录，精确相等已经够用，宽目录宁可拒绝自管安装、交人工确认。拒绝点仍在**任何关机动作之前**，`blocked()` 的可撤销分支照旧恢复普通退出语义。测试面：既有的「相等 / 子孙通过」那条**期望本身就是错的**，改成「相等通过、子孙与祖先一律拒」并新增盘根 / UNC 共享根 / 主目录三组 `INSTALL_DIR_TOO_BROAD`；顺带发现另一条 fixture（`test/update/install-transaction.test.ts` 的注入缝用例）用 `...\bin\node.exe` 当运行位置来证明「子目录也算本机安装位置」——那句话已被本条推翻，改成安装目录内的真实 exe 形态；再加一条端到端（HKCU 填 `C:\` ⇒ `INSTALL_BLOCKED` 且 `runOnce`/`spawn` 都没跑到） | `update/installer.ts`（`assertInstallDirAnchored` 判据 + 注释 + `INSTALL_DIR_TOO_BROAD` 的用户文案）、`test/update/install-transaction.test.ts`（重写 1 例、新增 2 例、修 1 条 fixture 的期望）、本契约 §6 与审核记录 §3.2② / §3.4 M-11 | §0.4 不变量 4 / §7.7 / §9 B② / I-32 |
| I-56 | §6.5 派生 yml / §7.9 判据同源（**R8 · Major-2**） | 客户端有**三份**包名/文件名字符集（`verifier.RELEASE_PATH_RE` 的文件段、`verifier.deriveLatestYml` 的内联正则、`local-artifacts.ARTIFACT_NAME_RE`），三份都不含 `+`；发布侧的 `publish-release/verify-release` 却含 `+`，`isSafeVersionSegment` 也**明确允许**构建元数据（`0.3.0+build.7` 在合法语料里）。结果：一个按设计发布的合法版本，发布自检 OK、客户端 100% 拒收，而用户侧只表现为「一直没有更新」，且没有任何一处报错指向字符集——与 I-49 那次「版本段两侧分叉」是同一个缺陷模式的第二次发生。修法：字符集收敛到 `dirs.ts` 的 `ARTIFACT_NAME_RE` **唯一权威**，`RELEASE_PATH_RE` 的文件段由它的 `.source` 现拼（不再抄第二遍），`deriveLatestYml` 与 `local-artifacts` 改为引用。⚠ 同时如实登记一条容易误读的点：**字符集从来挡不住 `..`**（点是合法字符），穿越防护靠的是显式 `..` 判断与 `isSafeVersionSegment`；`local-artifacts` 原先只靠字符集 + 「读目录会报错」间接失败，这里补上与其他三处同一口径的显式 `includes('..')`，让「在拼路径之前就结构化拒绝」成为可断言的行为。测试面：`local-artifacts.test.ts` 把夹具改成可按版本构造（`nameFor(version)` / `writePending(..., version)`），新增 4 例（`+build.7` 的包被认成可安装且原样保留、`verifyCompanion` + `clearPending` 同版本、五种字符集外名字各拒一次、名字写成 `..` 时按 `ARTIFACT_INVALID` 拒）；`update-version-parity.test.ts` 新增 3 例（`RELEASE_PATH_RE` 文件段与 `ARTIFACT_NAME_RE` 逐条一致、发布 CLI 真产出的 `+build` 树两侧同接受、字符集没被放宽成任意字符串） | `update/dirs.ts`（新增 `ARTIFACT_NAME_RE`）、`update/verifier.ts`（`RELEASE_PATH_RE` 现拼 + `deriveLatestYml` 改用引用）、`update/local-artifacts.ts`（引用 + 显式 `..` 判据）、`test/update/local-artifacts.test.ts`、`test/update-version-parity.test.ts`、审核记录 §3.2 | §6.5 / §7.9 / 第 10 条纪律 / I-49（同一模式的第二次发生） |
| I-57 | §6.3 第 4 条 / §7.9 审计（**R8 · Major-1**） | `checkForUpdate` 成功路径末尾的三连写（`recordSeen` → `seqMirror.write` → `markSuccess`）只有中间那段有 try/catch：另两段抛错会原样抛穿门面 ⇒ IPC 把 `EPERM: rename ...` 的操作系统原文显示给用户并泄漏路径，调度器还会把它误记成一次网络失败而计入 7 次降级；同时 phase 停在 `checking`，界面永远转圈。I-44/I-46/I-53 立的「写不回 = 结构化拒绝 + 审计 + 可见异常」标准当时只落到 5 个写入点中的 2 个——**这条是 R7 · N-2 的同一件事在成功支路上的剩余部分**。修法：三段各给护栏（下限与成功时间走 `refusalOnWriteFailure()` ⇒ `STATE_WRITE_FAILED` + 带方法名的 subreason；镜像写失败仍走 `tamperRefusal` ⇒ `STATE_TAMPERED/MIRROR_WRITE_FAILED`，两者含义不同故不合并）；失败支路的 `markCheck` 也补了 `markCheckLogged()`（写不回时留痕 + 抬闩锁，不抛穿）；`refusalOnWriteFailure` 里补 `setPhase('error', ...)`，并把嵌套 try 拆成三段平铺（原实现的缩进让人误读作用域）。测试面：`service.test.ts` 新增 2 例——成功支路（合法清单 + 状态文件被占成目录 ⇒ `STATE_WRITE_FAILED`、文案不含 IO 原文、phase=error、审计有 `STATE_WRITE_FAILED_CHECKFORUPDATE`（**I-66 之前的旧标签名**，现为 `_CHECK`）、第二次仍拒、镜像没被单独写成功）与失败支路（篡改指针签名 + 写不回 ⇒ 不抛穿、审计有 `STATE_WRITE_FAILED_MARKCHECK`、phase 可见异常） | `update/service.ts`（`markCheckLogged`、三段护栏、`refusalOnWriteFailure` 的 phase）、`test/update/service.test.ts`（+2 例）、`docs/operations/update-service.md` §3.1（`STATE_WRITE_FAILED_*` 由三种扩到五种现场） | §6.3 第 4 条 / §7.9 / §9 A⑤ / I-44 / I-47 / I-53 |
| I-58 | §7.9 审计现场 / §8.3 密钥管理 / §6 watchdog 结果文件（**R8 · Minor-1 / 2 / 3**） | ① **Minor-2**：MAC 校验失败（文件在、字节被改）在 `checkForUpdate` 与 `startupScan` 两个现场**一条审计都不写**，只把 UI 拨成 `STATE_TAMPERED`——运维手册 §3.1 教的「按 subreason 区分删档与改字节」因此少一种，库里两种现场长得一样（都看不见）。修法：新增 `logTamperSite()`，两处各写一条 `subreason: 'STATE_MAC_BROKEN'`，`startupScan` 那条保证「出网之前就已留痕」；顺带让 `checkForUpdate` 的这条分支走统一出口 `tamperRefusal()`（原先它自己置闩锁却没同步 `state.stateTampered`）。② **Minor-1**：`release-keys.mjs` 对同 `kid` 重跑**静默覆盖私钥**——销毁旧私钥等于让此前签发的清单永远无法重签（撤回、补公告都办不了），而触发它的只是「我以为在查看钥匙」；而 `docs/release-windows.md` 的发布检查第 1 条教人跑 `release-keys.mjs list`，**这个子命令根本不存在**（我当时写手册时编的）。修法：默认拒绝覆盖并报出路径与下一步，显式 `--rotate` 才换钥；手册改成「把构建时 `SPARKII_RELEASE_KEYS_FILE` 那份 `public-key.json` 原样交给 `verify-release.mjs --public-key`」——该文件同时带 `kid` 与 `publicKeyPem`，对应关系由构造成立。③ **Minor-3**：契约 §6 的 `install-result.json` 字段表漏了 `spawnedAt` 与 `reason`，退出码口径也写错（原写「0 成功 / 2 超时」，真实是 0 / 透传安装器非 0 / 五个提前退出现场 2），而 `reason` 恰是运维区分「装坏了」与「根本没启动」的唯一一格。修法：字段表按 `writeResultAtomic()` 重写并写清并发让位语义；⚠ 我第一版把它写成「`parentGoneAt` 有值而 `spawnedAt` 为 null ⇒ 死在拉起前」，实测这两个字段在真实代码里**成对出现**（只有 `SPAWN_FAILED` 与正常路径会写 `spawnedAt`），已按代码纠正——这正是本仓「自报事实也要复算」那条纪律的现场。测试面：`update-state-mirror.test.ts` 新增 2 例（改一个 base64 字符 ⇒ 形态合法、只有 MAC 不符 ⇒ 检查与启动扫描各留一条 `STATE_MAC_BROKEN`；限流枚举从四种现场改判为五种）、`update-config-keys.test.ts` 新增 2 例（真实 CLI 重跑：默认拒绝且私钥/`public-key.json` 逐字节不变，`--rotate` 才生效；`list` 当参数传 ⇒ 非 0 且报 usage，不留下半套产物） | `update/service.ts`、`scripts/release-keys.mjs`、`test/update-state-mirror.test.ts`、`test/update-config-keys.test.ts`、`docs/superpowers/specs/2026-11-06-update-interfaces.md` §6 字段表、`docs/operations/update-service.md` §3.1 / §4、`docs/release-windows.md` 发布检查第 1 条 | §7.9 / §6.3 第 4 条 / §8.3 / §7.7 步骤 9 / I-50 / I-52 |
| I-59 | §6.3 第 4 条 / §7.9 审计（**R11 · Major-A**：I-57 的三段护栏里第三段零覆盖） | R11 用 grep 证实 `STATE_WRITE_FAILED_MARKSUCCESS` **全仓零条测试引用**，并把 `markSuccess` 那圈 try/catch 删掉后现有用例仍全绿 ⇒ I-57 报"三段各有护栏"，实际只有两段的护栏被执行过。根因不是漏写用例，而是**夹具到不了那一格**：状态文件被占成目录时 `recordSeen` 先抛，控制流根本回不到第三段；而没有任何现成注入缝能"只让第三步失败"。修法不改产品代码、只用既有缝：`seqMirror.write` 恰好排在 `recordSeen` 与 `markSuccess` 之间，让它在成功后把状态文件位置换成目录（等价于另一个进程 / 杀软在两次写之间动了这个文件），于是只有第三段的 rename 会失败。新增 1 例断言四件事：`STATE_WRITE_FAILED` 且文案不含 IO 原文、phase=error、审计里有 `_MARKSUCCESS`、**同时不得**出现 `_CHECKFORUPDATE`（那条意味着下限那段也失败了，两段现场必须能区分） | `test/update/service.test.ts`（+1 例，16 例全绿） | §6.3 第 4 条 / §7.9 / I-57（本条是它的补课）/ 第 10 条纪律 |
| I-60 | §7.7 步骤 9 的让位分支（**R11 · Major-B**） | I-52 把 watchdog 的 rename 兜底改成"失败就删自己的 `.tmp` 并让位"，测试面当时的处置是把「单一写入」用例改成 **8 轮并发**。R11 实测这 8 轮里 rename **总是成功**（让位分支 0/80 未触发），因此把 `writeResultAtomic` 改回裸 `renameSync` 这 8 轮照样全绿——**"多轮重复"不等于"判据分支被执行"**，这是我自己在 I-52 里写下的教训，却在同一个条目上第二次犯。修法：加一条**确定性**现场——另起一个子进程持有 `install-result.json` 的读句柄（libuv 打开文件时不带 `FILE_SHARE_DELETE`，这正是 I-52 生产现场的成因），再跑一个 watchdog：①退出码仍按安装器透传（让位不改判）；②先赢方那份内容一字未动（`SHA-FIRST-WINS` 仍在）；③目录里零 `.tmp` 残留；④stderr 有可判读的让位说明。原 8 轮用例保留（它证的是"原子性/不留垃圾"，与本条正交） | `test/update-watchdog.test.ts`（+1 例，9 例全绿） | §7.7 步骤 9 / §6.5 结果文件 / I-52 / 第 10 条纪律 |
| I-61 | 判据同源的两处写法卫生（**R11 · Minor ×2**） | ① I-56 用 `ARTIFACT_NAME_RE.source.slice(1, -1)` 反推 `RELEASE_PATH_RE` 的文件段——当下正确（`update-version-parity` 逐条对拍钉住），但 R11 判为**新脆弱**：谁日后给那个正则加/去锚点或改首字符，slice 会**静默**改变路径正则的语义。改成共享字符类 `dirs.ts` 的 `ARTIFACT_NAME_CHARS`（字符类没有锚点可切），两条正则各自显式加锚。② 发布侧 `POINTER_PATH_RE` 的叶段原先是宽字符集 `[A-Za-z0-9._-]`（不含 `+`），而指针的两个路径按构造只能是 `release.json` / `release.json.sig` ⇒ 把"该不该含 `+`"这种第二个判据问题直接消灭：叶段写死。`test/publish-release.test.ts` 补三条反向断言（`spark+foo.exe` / `..%2f..` / `release.json.exe` 一律拒）与一条正向（`release.json.sig` 仍通过） | `update/dirs.ts`、`update/verifier.ts`、`scripts/publish-release.mjs`、`test/publish-release.test.ts` | §6.1.1 / §6.5 / I-49 / I-56 |
| I-62 | §7.10 调度用例的"名字与断言一致"（**R12 · Minor**） | `update-bootstrap.test.ts` 那条用例名字写着「固定推迟 15min（**不改变不可用计数**）」，正文却只断言"存在一个 15min 的窗口"（`toBeDefined`）——后半句判据从未被断言，属第四种绿勾假象（**用例名比断言多说了东西**）。修法：连喂 6 轮 `ACTIVE_WORK`，逐轮断言排到的窗口恒为 15min（若被误计入不可用，这里必然冒出 30s / 5min 阶梯档）、断言全部窗口同值，并断言 `calls` 恰好等于 fire 次数（首个窗口是启动时排的，还没调用过检查——这一点也是本次才核准的口径）。顺带在 R12 的对抗性核查里确认：`update-config-keys` 那条 `toBeDefined` 是承重的（find 缺项即 undefined ⇒ 会红），保留 | `test/update-bootstrap.test.ts`（重写 1 例） | §7.10 / 第 10 条纪律 / I-54（同一假象家族） |
| I-63 | §6.3 第 4 条 / §6.6（**R13 · Major-2**：状态不可信时的**写侧**把失败伪装成成功） | `state-store.ts` 的 `write()` / `mutate()` 在 `_tampered=true` 时是 `return`——**静默无操作**。后果不在磁盘上，在语义上：`deferUpdate` / `skipUpdate` 拿到"正常返回"，于是对用户报 `ok:true`、审计零条、盘上一个字节没动；而 `resetInstallId` 因为自己先查了 `isTampered()` 反而是对的——**同一课第八次：三个同类入口里只有一个装了闸**。R13 实测（MAC 改一个字符的状态文件）：`deferUpdate={ok:true}`、`skipUpdate={ok:true}`、`resetInstallId={ok:false, STATE_TAMPERED}`。修法：store 改为抛 `TamperedStateWriteError`（把"绝不静默成功"下沉到 choke point，任何调用方漏检都会立刻现形），service 侧 `refusalOnWriteFailure` / `markCheckLogged` 识别该错误类型并映射成 `STATE_TAMPERED` + 抬闩锁 + 审计 `subreason: 'STATE_TAMPERED_WRITE_REFUSED'`——**与 `STATE_WRITE_FAILED`（磁盘 / 权限）严格分开**，两者的运维处置动作不同。`enforceFloorFromMirror` 里那处早期 return 保留：它的调用方另有 fail closed 路径，性质不同 | `update/state-store.ts`（新增 `TamperedStateWriteError`、两处 throw）、`update/service.ts`（两处映射 + 新 subreason）、`test/update/service.test.ts`（+2 例：门面级"绝不报成功 + 盘上字节不变"、store 级"漏检也必抛"）、`docs/operations/update-service.md` §3.1 | §6.3 第 4 条 / §6.6 / §7.9 / I-47 / I-53 / I-57 |
| I-64 | §6.3 / §7.6 本地 IO 的失败语义（**R13 · Major-1**：还有三个入口把 IO 原文抛穿 IPC） | I-53 / I-57 之后仍然漏了三处，且这三次都是"同一个函数里前半段包了 try、后半段没包"：① `saveSettings` 末尾的 `await deps.saveSettings(...)` 是裸 await ⇒ `settings.json` 目录只读 / 被占时 `EPERM: operation not permitted, rename C:\Users\...\settings.json.tmp` **原文**经 `ipc.ts` 渲染到设置面板（含绝对路径），零审计、phase 不动；② `downloadUpdate` 的 `planDownload`（要 mkdir `pending/<version>`、要 statfs）排在下面那个大 try **之外** ⇒ R13 把 `updates/pending` 占成普通文件后实测 `ENOTDIR …\updates\pending` 抛穿；③ 清理类 `rm` 有三处裸调（`local-artifacts.scanPending` 删坏包、`clearPending`、`downloader.rejectBad` / `.part` 清理循环），异常会盖掉真正的失败原因，而 `scanPending` 原先还在没删成功的情况下把 `removed: true` 写进审计（**谎报已清理**）。修法：①②改为各自 try/catch ⇒ 新 reason `LOCAL_STORAGE_FAILED`（三种带方法名的现场 `_SETTINGS` / `_PLAN` / `_CLEAR`，与 `STATE_WRITE_FAILED` 分类）；③删除动作一律"尽力而为 + 成功才计数 / 才写 `removed:true`"，删不掉就镜像一条 warn 并保留现场；`clearPending` 返回 `boolean`，`clearDownloaded` 在 false 时报"没有清理成功"而不是 ok。⚠ 诚实登记两处手段局限：`rm` 失败在本机**构造不出来**（R13 承认"持读句柄 + `icacls /deny` 两种方式都让 rm 成功"，我复现了同一结果），所以"删不掉却报已清理"这一格靠新增的注入缝 `deps.removePackage` 钉住，生产路径不传 ⇒ 仍走真的 `clearPending`；`.part` 占用同理未做成用例 | `update/service.ts`（`refusalOnIoFailure`、`removePackage` 缝、`LOCAL_STORAGE_FAILED` 三类标签）、`update/local-artifacts.ts`（`scanPending` / `clearPending`）、`update/downloader.ts`（`rejectBad` / `.part` 循环）、`test/update/service.test.ts`（+3 例：saveSettings、planDownload、clearDownloaded 假成功）、`docs/operations/update-service.md` §3.1 | §6.3 / §6.6 / §7.6 / §7.9 / I-44 / I-53 / I-57 |
| I-65 | §7.9 审计限流的**留痕语义**（**R13 · Major-3**） | `logUpdateEvent` 原先把限流键 `seen.add(key)` 排在 `await audit.append(...)` **之前**，而 append 的异常被 `.catch` 吞掉（"审计写盘失败不阻断主流程"这句本身是对的）⇒ 一次瞬时失败（`SQLITE_BUSY` / 盘满）就让这条现场**当天永久静默**：R13 实测两次同现场只试过一次、库里零条、界面无感。修法：键的含义从"已经试过"改回"**已成功留痕**"——append 失败时不记键（同类事件下次仍会重试），并把这次失败镜像到 logger 一行，否则"重试"这件事本身也无从发现。限流能力没有削弱：成功后照样同键同天只一条。测试：`update-state-mirror.test.ts` 新增 1 例（先失败 ⇒ 第二次必须真的再试并落库；落库成功后重复 ⇒ 仍只一条；warn 里有"审计写入失败"字样） | `update/audit.ts`、`test/update-state-mirror.test.ts`（+1 例）、`docs/operations/update-service.md` §3.1 | §7.9 / I-50 |
| I-66 | §7.9 subreason 与限流键的**长度耦合**（**R14 · Major-2**） | 限流键里的标签只接受 `^[A-Z][A-Z0-9_]{0,31}$`（≤32 字符），而 subreason 是在 `service.ts` 里现拼的：`STATE_WRITE_FAILED_CHECKFORUPDATE` 与 `STATE_WRITE_FAILED_RESETINSTALLID` 都是 **33 字符** ⇒ 双双退化成空标签 ⇒ 共用 `update.failed\|天\|STATE_WRITE_FAILED\|` 这一把键，**同一次运行里先落的那条把后一条静默压掉**。后果不是崩溃而是"手册骗人"：`docs/operations/update-service.md` §3.1 写着"六种现场各留一条"，实际最多两条。修法：把标签从"方法名直接大写"改为**有限枚举表** `WRITE_FAILURE_LABELS`（`..._CHECK` / `..._RESET_ID` 等，全部 ≤32），拼不出来时退回不带标签的 reason（宁可少一个维度，也不要两条现场共用一键）；同时导出 `subreasonForMethod` / `WRITE_FAILURE_METHODS` 让测试能拿到同一张表。测试：`update-state-mirror.test.ts` 新增 2 例——每个入口现拼的标签都过得了键判据且不退化；九种现场（六种 `STATE_WRITE_FAILED` + 三种 `LOCAL_STORAGE_FAILED`）在同一天各落一条、重复同现场仍只一条 | `update/service.ts`（标签表 + 两个导出）、`test/update-state-mirror.test.ts`（+2 例）、`docs/operations/update-service.md` §3.1（把"为什么长度是被判据绑死的"写进手册） | §7.9 / I-50 / I-57 |
| I-67 | §7.9 / §7.10 / §9 B⑦ / M-11 M-12 的**断言与口径收尾**（**R13 · Minor 批 + R14 · Major-1 + 两条 Minor**） | 一批"看着有、其实不承重"与"文档说得比盘态好"：① **R14 · Major-1** I-62 那条 ACTIVE_WORK 用例只跑 6 轮，而 `MAX_CONSECUTIVE_UNAVAILABLE=7` ⇒ "窗仍排 15min 但 `unavailableStreak += 1`"这种实现要第 7 轮才暴露，6 轮断言全绿却什么都没防住；改成跑到 `阈值+2` 轮并显式断言"降级为仅手动"的告警从未出现（那才是误计入不可用的**可观察后果**）。② **R13 · Minor** `verifyAuditChain`（§7.9 B 关的哈希链）在生产代码里**零调用点** ⇒ "同用户进程抹痕迹可被检出"只是纸面能力；已在 `startupScan` 开头接上（零网络、在任何提前返回之前），断链写一条 `reason=AUDIT_CHAIN_BROKEN` 审计 + 一条日志，**但不改变更新判定**并在注释里写清理由：链只覆盖本机审计历史，防不住整段截断/替换（那需要服务端锚点，§8.3 / P2），本机没有第二个可比副本，把它升级成拒绝更新等于把一个可观测的取证信号换成一个无法自证的门。③ **R13 · Minor** `pruneRetainedDetailed` 三处 `.catch(() => undefined)` 之后照旧 `orphansRemoved.push(target)`、`verifyStartup` ①分支 rm 失败仍写"已清理事务记录"——与同函数自己那句"绝不谎报已清理"直接矛盾 ⇒ 改为成功才计数 / 才那么写，`INSTALL_OK` 的文案随"事务记录是否真清掉"分叉（无测试依赖旧文案）。④ **R13 · Minor** 我给 `..` 名字判据加的那条用例其实**不承重**（删掉显式判据后 `join(vdir,'..')` 落在 pending 根，读目录照样报同一个 `ARTIFACT_INVALID`）⇒ 换成真能区分的现场：名字写 `../outside.bin`、那个文件**真实存在且 sha512/bytes 全对**，没有显式判据时它会被判成合法可安装。⑤ **R14 · Minor** 206-无-Range 那条分支零覆盖 ⇒ 给测试服务器加 `fakePartial` 模式并钉住拒绝 + 不落地。⑥ **R14 · Minor** 锚点的四种路径写法（正斜杠 / 大小写+尾分隔 / `\\?\` 命名空间 / 8.3 短名）此前只有代码推演 ⇒ 补成单测，前两种判相等、后两种 fail closed（短名启动的真机命中率仍列 M-11）。⑦ **R14 · Minor** 字符集对拍语料把 `; % # $ ( ) = @ ! ~ \| < > { } "` ' 与控制字符全部练到，并加一条"把 `;` 加进类里必须与现判据产生可见分歧"的自证；同时把"发布侧叶段写死、客户端叶段仍宽"这处**刻意的不对称**用测试钉住并写明理由（客户端要容纳 artifact 文件名，发布侧只产两种固定叶子）。⑧ 文档口径：`docs/release-windows.md` 的 M-11 还在教「候选为祖先」（I-55 之后那是拒绝形态）、M-12 写着「8 轮并发把让位分支压成必然触发」（I-60 实测 0/80，是让位分支由新增确定性用例独占钉住）——两处都已就地更正并把"为什么先前那句是愿望不是取证"写进去 | `test/update-bootstrap.test.ts`、`update/service.ts`（`startupScan`）、`update/installer.ts`、`test/update/local-artifacts.test.ts`、`test/update-download-resume.test.ts`、`test/update/install-transaction.test.ts`、`test/update-version-parity.test.ts`、`docs/release-windows.md` | §7.9 / §7.10 / §9 B⑦ / M-11 / M-12 / 第 10 条纪律 |
| I-68 | §7.9 审计留痕 / §6.6（**R16 · Major-1 / Major-1b**） | `saveSettings` 与 `resetInstallId` 里的"留痕"是**裸调 `deps.audit.append`**，绕开了 `logUpdateEvent` 的 try/catch ⇒ `audit.db` 被占用 / 盘满 / `SQLITE_BUSY` 时 `EPERM: … rename 'C:\Users\…\data\audit.db.tmp'` 原文抛穿 IPC 渲染到设置面板，`phase` / `errorCode` 都不动、零结构化留痕；R16 实测两条路径都复现。`resetInstallId` 还多一格：`regenerateInstallId()` 已经落盘、审计失败不回滚 ⇒ **半效果**（id 真换了、只是没留痕）。修法：`update.settings-changed` 加进 `UPDATE_EVENTS` 白名单，两处统一走 `logUpdateEvent`（写失败 ⇒ 吞异常 + 不记限流键 + logger 镜像一行，见 I-65）；不做"假装原子"的两阶段写，而是在注释与返回文案里如实承认"设置已生效、留痕可能缺失，缺失由日志负责被发现"。测试：`test/update/service.test.ts` +1 例（注入会抛的 audit：两处都不 reject、文案不含 IO 原文与路径、warn 里有"审计写入失败"） | `update/audit.ts`（白名单）、`update/service.ts`（两处改道）、`test/update/service.test.ts` | §7.9 / §6.6 / I-50 / I-64 / I-65 |
| I-69 | §7.7 步骤 8-9 / §7.9（**R16 · Major-2**：测试断的是缝，生产走的是包装器） | `installer.ts` 的审计参数是**注入缝**（`InstallDeps.audit`、`StartupVerifyOptions.audit`），而生产两个调用点都没传：`service.installUpdate` 的 deps 里没有 `audit` 键 ⇒ `auditOf()` 恒 undefined；`service.startupScan` 调的是 arity-2 包装 `verifyStartup(...)`，它写死 `opts = {}` ⇒ §7.7 / §7.9 要求的 `update.completed` 与保留策略的 `update.cleanup` 在**生产里一条都不进 AuditStore**，`createUpdateAuditSink` 的 errors 镜像同时失效。而那条名字写着"写 update.completed 与 update.cleanup 审计"的用例用的是 `verifyStartupWith(..., {audit})` ⇒ 全仓看不出差别。这是本仓第四种绿勾假象的新变体（**判据在缝上成立、在生产入口不成立**）。修法：`startupScan` 改走 `verifyStartupWith(..., {audit, logger})`，事务 deps 补 `audit: auditLike`；顺带把 service 侧那条重复的 `update.install-start` 去掉（事务内部已带 `txnId` + `version` 发过，两条事件限流键相同 ⇒ 必然有一条被静默压掉，正是 I-66 那一课），改为在事务那条里补 `sequence`。测试：`test/update/service.test.ts` +1 例——**走门面**：装完重启的现场（哨兵 + watchdog 结果 + 运行版本已是目标版本）经 `svc.startupScan()` 后，注入的 audit 必须收到 `update.completed`，且哨兵被收口 | `update/service.ts`（两处装配 + 去重）、`update/installer.ts`（install-start 事件补 sequence）、`test/update/service.test.ts` | §7.7 / §7.9 / §6.6 / I-18 / I-64 / 第 10 条纪律 |
| I-70 | §6.3 第 4 条 / §7.5 重开扫描（**R16 · Major-3，本轮唯一的纯产品级数据丢失**） | `startupScan` 里那句"下限不可信时 scanPending 会把合法包判成坏包删掉，那是二次伤害"**只挡了一半现场**：跳过扫描的条件是 `destroyed`（文件被删 + 镜像还在），而 `st.isTampered()`（文件在、字节被改）没进条件。R16 实测：mac 改一个字符后启动 ⇒ `scanOpts` 把 `lastSeenSequence` 顶到 `MAX_SAFE_INTEGER` ⇒ 已下载并验签通过的合法包被判 `SEQUENCE_REGRESSION` ⇒ `rm` 整目录删掉，用户凭空丢包，`local` 也变 null；同一 fixture 的 `destroyed` 分支则正常保留（`pendingStillThere=true`），形成直接对照。修法：条件改为 `floorUntrusted = destroyed || st.isTampered()`，两种现场一律"不扫不删、只拒绝 + 留痕"。测试：`test/update/service.test.ts` +1 例——先用真链路 `checkForUpdate` + `downloadUpdate` 把包装进 `pending/`，再把 mac 改一个 base64 字符，新实例 `startupScan()` 后断言**包还在**、`stateTampered=true`、审计里**没有** `SEQUENCE_REGRESSION`（即没有"以破坏的方式处置"） | `update/service.ts`（`startupScan`）、`test/update/service.test.ts` | §6.3 第 4 条 / §7.5 / §7.9 / I-34 / I-36（同一函数的另一半） |
| I-71 | §6.3 第 4 条 / §6.5 界面可见性（**R16 · Major-4**：M-4 的第二个入口） | `clearDownloaded` 成功后无条件 `setPhase(state.remote ? 'available' : 'idle')`，而 `setPhase` 一律把 `errorCode` 置回 null ⇒ 锚点异常正在被拒绝的那次运行里，用户点"丢弃已下载的包"（**这个入口刻意不锁**）成功后，界面上的"本地状态异常"提示被洗掉，而 `tamperLatched` 还在拒检查 / 下载 / 安装 ⇒ 现场变成"点什么都没反应、也没有原因"。R7 · M-4 修的是 `cancelDownload`，同一函数的另一条出口漏了。修法：清理照做（不放开任何门禁），但闩锁立着时保持 `phase=error / errorCode=STATE_TAMPERED / stateTampered=true`。测试：`test/update/service.test.ts` +1 例（删档 + 镜像在场 ⇒ 检查被拒 → `clearDownloaded` 仍 `ok:true`，但 `errorCode` 保持 `STATE_TAMPERED`） | `update/service.ts`（`clearDownloaded`）、`test/update/service.test.ts` | §6.3 第 4 条 / §6.5 / I-46 / I-53（M-4 同源） |
| I-72 | §7.9 标签机制 / §6.3 第 4 条 / §7.5 二选一（**R16 · Minor-1 / 2 / 3**） | ① **Minor-1**：`subreasonWith` 对未登记方法统一给 `_OTHER`，而我写的注释声称"新增入口不加标签测试仍能发现"——测试遍历的正是那张表，**永远发现不了**；后果是 R16 实测"五个未登记入口共用同一把限流键（不同键数 = 1）"，即 I-66 那条坑留着一条现成的再入通道。修法：未登记时把方法名本身规范成标签（大写、去非 `[A-Z0-9_]`、按 `32 - prefix - 1` 预算截断），于是**每个未登记入口各占一把键**；规范化后为空才退回不带标签。表的作用退化为"给已知现场一个稳定可读的短名"。测试改写为"三个未登记方法给出三把不同的键、都不是 `_OTHER`、都 ≤32 且过得了键判据"。② **Minor-2**：检查失败支路上 `markCheck` 若因锚点不可信被拒，审计写的是 `STATE_TAMPERED` 而 `setPhase` / 返回的 reason 仍是本次验证的原因（如 NETWORK）⇒ 同一现场两种口径。修法：新增 `tamperOverride()`，闩锁因这次拒绝而立时，phase 与 reason 统一报 `STATE_TAMPERED`（验证原因不丢，留在审计里）。⚠ **诚实登记可达性**：`store()` 在门面内是**单例**、`isTampered()` 一次加载后不变，而 `checkForUpdate` 开头就会因 tampered 直接返回 ⇒ 这一格**当前生产不可达**，属于"若将来 store 改成可重读就会立刻现形"的防御性护栏，我没有为它写用例（也写不出真实用例），与 `enforceFloorFromMirror` 里那处同样不可达的早退同批登记。③ **Minor-3**：`service.ts` 另有一条 `compareSimple`（全仓第二处版本比较），既不剥前导 `v` 也不看预发布 ⇒ 违反"判据唯一性"；删掉它改用 `decision.ts` 的 `compareVersions`。但统一实现仍把 `0.3.0` 与 `0.3.0+build.2` **判等**，于是"显示哪一包"取决于 `readdir` 顺序——这是统一之后才暴露出来的第二层问题，故给 `pickBestLocal` 加**显式破平**：同版本时按已验签的 `sequence` 取胜者，再按 `artifactPath` 收尾，结果与目录枚举顺序无关 | `update/service.ts`（`subreasonWith` / `tamperOverride` / `pickBestLocal`、删 `compareSimple`）、`test/update/service.test.ts`（Minor-1 断言改写）、审核记录 §1.4 与 R16 表 | §7.9 / §6.3 第 4 条 / §7.5 / I-30 / I-56 / I-66 |
| I-73 | §7.9 审计限流键（**自纠，非代理上报**：为回答 R19 简报里"留痕是否真的落库"那一问而复扫时抓到） | I-68 把两处裸 `deps.audit.append` 改道 `logUpdateEvent` 之后，两条 `update.settings-changed` 事件的 fields 里**只有 `baseUrlChanged` / `installIdReset` 这类布尔，没有 `reason`、也没有 `subreason`** ⇒ 限流键退化为 `update.settings-changed|天||`，同一台机器同一天"改了更新源"与"重置了检查标识"**共用一把键、只留一条**。这正是 I-66（`_OTHER` 共用键）那一课的**第三次**发生，而且这次是我自己刚写下的代码带进来的——上一轮我还在契约里写"表的作用退化为给已知现场一个稳定短名"，转头就在别的函数里踩了同一格。修法：两条事件各给固定 `reason: 'SETTINGS_CHANGED'` + 有限枚举 `subreason: 'BASE_URL_CHANGED'` / `'INSTALL_ID_RESET'`（都是大写、≤32、枚举有限 ⇒ 不构成"每次换个键"的刷库通道）。⚠ 顺带把 §7.9 那条限流的**代价**写进运维手册：设计原文是"其余 `update.*` 按类型 + 天限流"，所以 `update.completed` / `update.install-start` / `update.cleanup` **同一天只落一条 AuditStore**——这不是漏洞而是明文门禁的直接后果，本期不放宽；逐次安装历史的权威载体是客户端哈希链（`update-audit-chain.jsonl`，每次安装追加一条、不受限流影响），取证以链为准。测试：`test/update/service.test.ts` 既有那条"合法 http 放行并写审计"仍承重；`update-state-mirror.test.ts` 的标签表用例覆盖"同 reason 不同 subreason 各留一条" | `update/service.ts`（两处 fields）、`docs/operations/update-service.md` §3.1（新增"限流的代价与链才是逐次历史"一段）、审核记录 R16 表下一行 | §7.9 / I-50 / I-66 / I-68 |
| I-74 | §6.3 第 4 条 / §7.9 分类（**R18 · Major-1 + R19 · Major-1 同一条：同一事件在两条支路上被给了两种安全定性**） | `markCheckLogged` 识别出错误类型之后**仍无条件** `tamperLatched = true; state.stateTampered = true`，于是「一次普通失败检查（NETWORK / 404）+ `update-state.json` 写不回（磁盘满 / 杀软占用 / 只读）」被门面报成 `STATE_TAMPERED`「本地状态不可信」，此后检查 / 下载 / 安装三入口全拒且**同实例不自愈**（只有重启才好）；而同一个 IO 失败在**成功支路**走 `refusalOnWriteFailure` 时不抬闩锁。R18/R19 两条独立复审都抓到这一格，并各自实测出同一现场（R19 的分类表里 `checkForUpdate（失败支路+源不可达）= STATE_TAMPERED` 与 `deferUpdate = STATE_WRITE_FAILED` 直接并列成对照）。⚠ 我原先给这条差异编的理由——"连失败计数都存不了就说明锚点不可信"——**站不住**：计数存不了只说明磁盘不可用，这正是"自报的局限也要复算"那一课。修法：`markCheckLogged` 只在 `err instanceof TamperedStateWriteError` 时抬闩锁并返回 true，失败支路三处改为 `if (await markCheckLogged(st)) return tamperRefusal(...)`；纯 IO 写不回 ⇒ 原样返回本次真正的验证原因 + `STATE_WRITE_FAILED_MARKCHECK` 审计、故障消失后同实例即恢复。同时 **R18 · Minor-4**：`refusalOnWriteFailure` 的非 tamper 分支与 `refusalOnIoFailure` 会把界面上的 `STATE_TAMPERED` 覆盖成 `STATE_WRITE_FAILED` / `LOCAL_STORAGE_FAILED`（闩锁仍立着、UI 改口），现改为「`tamperLatched` 在场时一律以 `STATE_TAMPERED` 说话」。测试连带面（**必须如实登记**）：改动让 4 条既有用例转红，根因是它们用「把状态文件位置占成目录」模拟写失败，而那手法自 I-75 之后落进第三态、根本走不到目标分支 ⇒ ① 新增助手 `holdStateUnwritable()`（先真写出合法状态文件，再起子进程持**读句柄** ⇒ libuv 不带 `FILE_SHARE_DELETE`，后来的 rename 覆盖必 EPERM，与 I-60 那条让位用例同一手段、本机实测真会失败），两条 R8 · Major-1 用例改走它并新增「IO 故障不该被升级成 STATE_TAMPERED」断言；② `Major-4`（清理不洗状态）改用 mac 翻转造真 `STATE_TAMPERED`；③ `R4 · Minor-3`（重建写失败）改用**延迟占位**：镜像读回来后、`persist` 的 rename 之前用 `setImmediate` 把这个名字占成**非空目录**（一开始就占 ⇒ 读侧先失败，测不到重建那一格），于是 `STATE_REBUILD_FAILED` 的现场重新承重，同一条用例的后半再断新实例落进第三态（`STATE_WRITE_FAILED` / 不抬闩锁 / 不抛错）。变异自查：删掉 `subreason` 两处各红 1 条用例（见 I-77） | `update/service.ts`（`markCheckLogged` / `refusalOnWriteFailure` / `refusalOnIoFailure`）、`test/update/service.test.ts`（+1 助手、3 条改写）、`test/update-state-mirror.test.ts`（`R4 · Minor-3` 重写为延迟占位）、`docs/operations/update-service.md` §3.1 | §6.3 第 4 条 / §7.9 / I-34 / I-44 / I-57 / I-63 |
| I-75 | §6.3 第 4 条 / §7.5 / §7.9（**R19 · 差异 (c)：状态文件其实有第四种读法**） | `state-store.ensureLoaded()` 原先把读失败**一律**当成"文件不存在"。但 `EISDIR`（位置被占成目录）/ `EPERM`（同用户改 ACL、杀软锁）/ `ENOTDIR`（上级变成文件）既不是"这台机器从没写过状态"，也不是"有人改了字节"：读成 absent 时，镜像也为空 ⇒ 整条更新链看着像全新装机、界面无痕、`phase=idle`，I-31 的删档判别当场失效；读成 tampered 时（R18 · Major-1 刚判过我这个方向是误报）会把磁盘故障立案成人为篡改。修法：新增**第三态**——`fileStatus()` 从三态扩到四态（`absent` / `tampered` / `unreadable` / `ok`），`readFailureCode` 记录原始错误码并由 `unreadableCode()` 暴露，写侧抛 `UnreadableStateError`（与 `TamperedStateWriteError` 分开），`_tampered` 在这一格**刻意不置位**。门面侧：`checkForUpdate` 在出网之前早退（不出网、不写、不删包，`reason=STATE_WRITE_FAILED` + `..._UNREADABLE` 审计），`startupScan` 把 `unreadableCode() != null` 并入 `floorUntrusted`（所以绝不 scanPending 删包）但**不抬闩锁**，并补上原先空着的那一格（R19 实测"镜像为空 + 位置不可写 ⇒ 无分类、零留痕"）。判据口径：这一类故障消失后同一次运行即恢复，运维按磁盘 / 权限处置。测试：`state-store.test.ts` 的 tamper 写侧用例改为断 `rejects` 两类不同错误；`update-state-mirror.test.ts` 的 `R4 · Minor-3` 用例后半显式钉住新实例落进第三态（`errorCode=STATE_WRITE_FAILED`、`stateTampered=false`、`startupScan` 不抛）；`service.test.ts` 两条用例断言「IO 故障不该被升级成 STATE_TAMPERED」 | `update/state-store.ts`（`UnreadableStateError` / `readFailureCode` / `unreadableCode` / 四态 `fileStatus`）、`update/service.ts`（两处早退 + `floorUntrusted`）、`test/update/state-store.test.ts`、`test/update-state-mirror.test.ts`、`test/update/service.test.ts`、`docs/operations/update-service.md` §3.1（新增"第三态"表） | §6.3 第 4 条 / §7.5 / §7.9 / I-31 / I-34 / I-70 / I-74 |
| I-76 | §7.9 逐次历史的**载体**（**R19 · Major-2**） | 限流键是 `action\|天\|reason\|subreason`，**不含 version / txnId**（设计原文"其余 `update.*` 按类型 + 天限流"，防 MITM 刷库，本期不放宽）。R19 实测把它的人数算了出来：7 个版本 × 7 类 = 49 条候选里库里只落 7 条（全为首个版本）、端到端两次真下载 / 两次真清理各只留 1 条、两个安装事务的 `install-start` 只留 1 条。⚠ 真正的缺口不是"库只有一条"（那是明文门禁的直接代价），而是**链那一侧同样没写**：`download-start` / `download-complete` / `clearDownloaded` 的 `cleanup` 既不进库也不进链＝彻底无痕，于是"这台机器今天下过两次、丢弃过一次"事后无从重建。修法：私有助手 `chainQuiet(event)`（吞掉链写失败，链不可写绝不改变任何判定），在三处生命周期点与 `INSTALL_FAILED` 那一格同时进库 + 进链；进链的都是**用户动作 + 已验签清单**才产得出的事件（服务端喂垃圾清单喂不出 `download-start`），不属于可被刷的路径。与 I-66 / I-72① / I-73 的区别要说清：那三次是"同 reason 的不同现场共用一把键"（判据漏洞，已修），这一次是"同键的同事件重复"（设计要的限流，不修，改为把逐次历史换到链上）。运维手册 §3.1 的"限流的代价、链才是逐次历史"一段据此改写，取证口径明确写成"以链为准" | `update/service.ts`（`chainQuiet` + 四处调用）、`docs/operations/update-service.md` §3.1 | §7.9 / §7.5 / I-50 / I-66 / I-72① / I-73 |
| I-77 | §7.9 留痕承重（**R18 · Major-2 + Minor-1 + 域1④ 的第三、四个包装器**） | ① **Major-2**（复合条件）：`createUpdateAuditSink` 的第二段写 `errors.append(...)` 是同步 `db.prepare().run`，**可以抛**；它抛在 audit 行已提交之后 ⇒ `written=false` ⇒ I-65 那条"只在成功留痕后才记限流键"的修法在这个复合条件下**反向失效**（同键当天重复落库，§7.9 防刷库被旁路），而 `update-bootstrap.test.ts` 的 errors mock 从不抛 ⇒ 零覆盖。修法：把 errors 镜像写包进 try/catch（缺镜像不改变审计结果，也不影响键的记账），并如实登记"这是错误吞掉而非真验过 errors.db 故障"。② **Minor-1**：I-73 补的两处 `reason` / `subreason` 只由**直调 `logUpdateEvent`** 的用例钉住（`update-state-mirror.test.ts`），门面侧只断"存在一条 settings-changed" ⇒ 把 `service.ts` 里那两格 fields 删回去，其余用例仍全绿。修法：`test/update/service.test.ts` 那条 URL 校验用例改走**门面**断两个 subreason 各占一把键（同一天 `changed.length ≥ 2`），并做变异自查：分别删掉 `BASE_URL_CHANGED` 与 `INSTALL_ID_RESET` ⇒ 各恰好红 1 条。③ **域1④**（I-69 家族的漏扫）：包装器 `recoverFromSnapshot` 写死 `opts = {}` ⇒ `update.rolledBack` 在生产里不落库，而 `verifyStartupWith` 的恢复文案**正是叫运维调这个名字**；修法是把 `opts` 透传下去（`recoverFromSnapshot(dataDir, txnId, opts)`）。④ `startupScan` 的 `INSTALL_FAILED` 那一格原先只改界面 phase、库里零条 ⇒ 补审计 + 进链（与 I-76 同一处） | `update-bootstrap.ts`（sink 吞异常）、`update/installer.ts`（`recoverFromSnapshot` 透传 opts、install-start 事件）、`update/service.ts`（`INSTALL_FAILED` 审计）、`test/update/update-bootstrap.test.ts`、`test/update/service.test.ts` | §7.9 / §7.7 / I-50 / I-65 / I-68 / I-69 / I-73 |
| I-78 | §6.5 留痕**顺序**（**R19 · Major-3**） | `saveSettings` 改更新源时原先在**落盘之前**就写 `BASE_URL_CHANGED`，随后 `deps.saveSettings` 抛（`EDQUOT` / 只读 / 占用）⇒ 库里声称"源已变更"而盘上源没变，是一条**过度留痕**（方向与 I-68 那条"半效果"相反：那里是效果已落、留痕可能缺；这里是留痕必到、效果可能没到）。修法：把留痕延后到写成功之后（`let pendingBaseUrlAudit` 记下待写的字段，成功支路再 `logUpdateEvent`），失败支路只写 `LOCAL_STORAGE_FAILED_SETTINGS`，注释里写清"设置没落盘就不许记源已变更"。`resetInstallId` 同理。测试：门面侧新增反向断言（注入会抛的 `saveSettings` ⇒ 审计里**不得**出现 `BASE_URL_CHANGED`），与 I-68 的"缺留痕由日志暴露"两条对照 | `update/service.ts`（`saveSettings` / `resetInstallId`）、`test/update/service.test.ts` | §6.5 / §7.9 / I-68 / I-73 |
| I-79 | §5.1 输入判据 / §7.6 保留策略（**R19 · Minor + R18 · 域1②的相邻格**） | ① **Windows 保留设备名**：`ARTIFACT_NAME_RE` 的字符类含 `.`，而 `CON.exe` / `NUL` / `COM1` / `LPT9.txt` 全部由合法字符组成 ⇒ 两侧都不挡。危害不是穿越而是**写盘落进设备**（`pending/0.3.0/CON.exe` 在 Windows 上是设备句柄不是文件，轻则 EPERM / ESPIPE，重则下载流写进控制台却"验签通过"）。发布脚本把名字钉死成 `^Sparkii-…-win-x64\.exe$`，正常链路产不出这类名字，所以这格防的是「私钥泄露后手工签出的合法清单」那一档——按 §5.1「输入不可信」的口径仍然要挡。修法：判据收敛成一处 `dirs.isSafeArtifactName()`（字符集 + 显式禁 `..` + 禁设备名 + 长度上限），`deriveLatestYml`（下载**落盘之前**，任何平台都成立）与 `verifyCompanion`（安装路径）都改走它。⚠ 承重位置经过挑选：`verifyCompanion` 那一格在 Windows 上不承重（真去读 `CON.exe` 会因为"写不出这个文件"而偶然失败），所以用例把断言压在这条判据本身与 `deriveLatestYml` 上，变异自查（把设备名正则改成永不匹配）⇒ 恰好红 1 条；对照用例钉住真实发布名仍放行，防止判据修成恒假（那会重演 R8 · Major-2 的"发布自检放行、客户端 100% 拒收"）。② **R18 · 域1②**：`verifyStartupWith` 的①分支在"下限不可信"时仍会跑保留策略（`pruneRetainedDetailed` 删旧版本目录）。复算后**判定不改**：这一格只在安装器真退出 0 且运行版本已等于目标版本时到达，删的是被自己更新取代的旧包，判据从不消费 `lastSeenSequence`；关掉它只会让 `pending/` 无限增长（违反 §7.6），与 I-70 那类"删掉仍可能被安装的合法包"不是一件事。理由写进代码注释，不再只靠对话记录 | `update/dirs.ts`（`isSafeArtifactName` + 设备名正则）、`update/verifier.ts`、`update/local-artifacts.ts`、`update/installer.ts`（保留策略的边界注释）、`test/update/local-artifacts.test.ts`（+1 例，20 条） | §5.1 / §6.5 / §7.6 / I-30 / I-45 / I-70 |
| I-80 | §6.3 第 4 条 / I-75 第三态的**存活性与平台 errno**（**R20 · Major-1/Major-2 + R21 · Major-1**，两条线各自独立实跑抓到同一格） | 两处都是「I-75 只修了分类、没修存活性」：① `ensureLoaded()` 首次读失败即 `loaded=true` + 写死 `readFailureCode`，而 `store()` 是门面内单例（`service.ts:272-280`）⇒ 物理故障消失后**同一进程**仍是 `unreadable`、不出网，只有重启（新实例）才恢复；`applyDecode()` 里清零 `readFailureCode` 的那一行第三态永远走不到。② `updates` 上级变成普通文件时，`readFileSync(<updates>/update-state.json)` 在 **Windows 报 `ENOENT` 而非 `ENOTDIR`**（R20 errno 探针 `-4058`、R21 独立 `node -e` 同结论）⇒ 只按 `code === 'ENOENT'` 判缺失会把这一格折成 `absent`，镜像有序号时误报 `STATE_TAMPERED`、为空时当首装且零留痕。修法：① `ensureLoaded()` 的早退条件改为 `loaded && readFailureCode == null`，第三态每次访问都重读，重新解码成功即清零；② 对 `ENOENT` 补一次 `statSync(dirname(file)).isDirectory()`，父目录不是目录 ⇒ 归一为 `ENOTDIR` 第三态，父目录不存在仍是正常首装。⚠ **平台差异如实登记**：本机造不出 `readFileSync` 的真实 `EPERM`（R21 §7.6 第 3 项），那一形态只按「非 ENOENT code 走同一分支」推演，不冒充真跑。测试：`test/update/state-store.test.ts` +2 例（上级是文件 ⇒ `unreadable` 且绝不折成 absent；占位目录消失后**同一实例** `fileStatus()==='ok'` 且 `write()` 成功），11→13 例 | `update/state-store.ts`（`statSync` / `dirname` 导入、`ensureLoaded()` 重写）、`test/update/state-store.test.ts`、`docs/operations/update-service.md` §3.1（第三态表补 `ok` 态与平台差异段） | §6.3 第 4 条 / §7.5 / I-31 / I-48 / I-75 / 第 10 条纪律 |
| I-81 | §6.3 第 4 条 / I-75 的**出口枚举**（**R20 · Major-3**） | I-75 的第三态早退只落在 `checkForUpdate` 与 `startupScan` 两条路：`downloadUpdate` 开头只判 `tamperLatched`（第三态刻意不抬锁）⇒ 仍走 `fetchAndVerify` **出网**、仍写库写链、仍 `planDownload`；`installUpdate` 同样无早退，且第三态 `poisonState()` 把 `lastSeenSequence` 顶到 `MAX_SAFE_INTEGER` 导致误拒。修法：抽出统一出口 `refuseUnreadableState(method, code)`（`setPhase('error','STATE_WRITE_FAILED')` + `logUpdateEvent(... subreason: writeFailureSubreason('unreadable'))` + 固定文案），`checkForUpdate` / `downloadUpdate` / `installUpdate` / `startupScan` 四处统一早退 ⇒ 第三态下不出网、不进安装事务、不写状态、不删包、不抬闩锁。原有两处内联早退收编到同一出口，不再各写一套。测试：`test/update/service.test.ts` +1 例（真现场把状态文件位置占成目录 ⇒ `downloadUpdate` 的 `fetchFn` 零调用、`installUpdate` 不进事务、`stateTampered=false`） | `update/service.ts`（`refuseUnreadableState` 与四处调用）、`test/update/service.test.ts` | §6.3 第 4 条 / §7.5 / I-75 / I-80 / R18「枚举全部出口」判据 |
| I-82 | §6.3 第 4 条 / I-71 / I-74 的**同一函数另一出口**（**R20 · Major-4 + R21 · Minor-2**） | `clearDownloaded` 成功支路有 `if (tamperLatched)` 保持 `STATE_TAMPERED`，但 `removePackage ?? clearPending` 返回 false 的 early-return 分支只 `setPhase('error','LOCAL_STORAGE_FAILED')` 并 `bad('LOCAL_STORAGE_FAILED')`，**不查闩锁** ⇒ 闩锁立着时清理删不动（占用/权限，或 `deps.removePackage` 注入缝返回 false）会把界面上的定性洗掉，与 I-74 定的「闩锁在场一律以 `STATE_TAMPERED` 说话」矛盾。修法：失败出口改为 `setPhase('error', tamperLatched ? 'STATE_TAMPERED' : 'LOCAL_STORAGE_FAILED')` 并在闩锁在场时保持 `state.stateTampered = true`；本地 IO 原因仍留在 `detail` / `bad()` 文案里，不丢诊断信息。`refusalOnWriteFailure` / `refusalOnIoFailure` 两个守卫的逻辑不变。测试：`test/update/service.test.ts` +1 例（mac 翻转造真 `STATE_TAMPERED` + 注入 `removePackage` 返回 false ⇒ `errorCode` 仍是 `STATE_TAMPERED` 且 `stateTampered=true`） | `update/service.ts`（`clearDownloaded` 失败出口）、`test/update/service.test.ts`、`docs/operations/update-service.md` §3.1 | §6.3 第 4 条 / §6.5 / I-46 / I-53 / I-64 / I-71 / I-74 |
| I-83 | §7.7 / §7.9 `INSTALL_FAILED` 的**三出口留痕**（**R20 · Major-5**） | 契约 I-77④ 只补了 `startupScan` 读哨兵那一格（库 + 链），另外两条出口没跟上：`installer.ts` 的 `blocked()` 只 `await chain({action:'update.failed'})` 进链、不进库；`service.installUpdate` 事务返回 `!ok` 时只 `setPhase`，**库与链都不写** ⇒ 用户当面点「安装」失败的本次运行里 AuditStore 查不到 `INSTALL_FAILED`，要等下次启动读哨兵才可能补。修法：`installer.ts` 的 `blocked()` 在进链之外补 `logUpdateEvent('update.failed', { reason:'INSTALL_FAILED', subreason:'INSTALL_TRANSACTION', txnId, targetVersion, detail })`；`service.installUpdate` 失败支路同时写库（`INSTALL_QUIT_REQUESTED` / `INSTALL_NOT_READY`）与进链（`chainQuiet`）。`startupScan` 原格保持。⚠ 链写失败仍被 `chainQuiet` 吞掉、不改变判定（I-76 口径不变）。测试：`test/update/service.test.ts` +1 例（走门面 `installUpdate` 失败 ⇒ 注入 audit 收到 `INSTALL_FAILED` 且链文件含之）、`test/update/install-transaction.test.ts` +1 例（事务中止 ⇒ AuditStore 也有 `INSTALL_FAILED`），52→53 例 | `update/service.ts`、`update/installer.ts`、`test/update/service.test.ts`、`test/update/install-transaction.test.ts`、`docs/operations/update-service.md` §3.1 | §7.7 / §7.9 / I-65 / I-69 / I-76 / I-77④ |
| I-84 | §7.10 调度的**分类语义**（**R20 · Major-6**；推翻 R18 · Minor-3 原先「刻意不改」的登记） | `afterOutcome()` 未把 `STATE_WRITE_FAILED` / `LOCAL_STORAGE_FAILED` 列入 `GATE_SUPPRESSED` ⇒ 这两类被计入 `unavailableStreak`，按 30s→5min→30min→2h→12h→24h 退避、第 7 轮 `falling back to manual-only until restart` 后**整个进程不再排期**。可观察后果：I-74/I-75 承诺「故障消失后同实例即恢复」的可自愈现场，在自动检查链路上要等最多 24h、第 7 轮后必须重启或手动点检查 ⇒ 与修复方向相反，不只是 warn 文案归因不准。修法：`GATE_SUPPRESSED` 增 `STATE_WRITE_FAILED`（它经 `afterOutcome()` 可达；`LOCAL_STORAGE_FAILED` 仅由 IPC 用户动作回报、不经调度链路，R22 · Maj-5 认定其为冗余抑制项已从集合中移除）⇒ 复位 streak、排 15min 闸门心跳。**`STATE_TAMPERED` 仍计入不可用**（by-design 拒绝、需重启），R18 · Minor-3 的登记维持不改：只排除可自愈那一类，不把「拒绝」与「不可用」混起来。测试：`test/update-bootstrap.test.ts` +1 例（连喂 `MAX_CONSECUTIVE_UNAVAILABLE+2` 轮 `STATE_WRITE_FAILED` ⇒ 每轮仍 15min、无 manual-only/不可用告警；对照 `STATE_TAMPERED` 在首个启动窗口之后仍排出 30s 第一档），40→42 例 | `electron/main/update-bootstrap.ts`（`GATE_SUPPRESSED` + 注释）、`test/update-bootstrap.test.ts`、`docs/operations/update-service.md` §3.1 | §7.10 / §6.3 第 4 条 / I-62 / I-67① / I-74 / I-75 |
| I-85 | §7.5 二选一 / 判据唯一性（**R20 域 3 §4.2**；推翻契约 I-72③ 与 H20 §6 里「口径空白、未实现改动」的登记） | `pickBestLocal()` 用 `l.version !== currentVersion`（**字符串相等**）排除当前运行版本，破平却用 `compareVersions()`（只比三段数字、忽略 build metadata）。`dirs.ts` 的 `VERSION_SHAPE_RE` 与 I-56 明确允许 `0.3.0+build.2` 为合法版本且可与 `0.3.0` 共存于 `pending/` ⇒ 两处口径分叉：`currentVersion='0.3.0'` 时该包没被排除，`compareVersions` 判等、按 `sequence` 破平后 `state.local='0.3.0+build.2'`，UI 显示「可以安装」并可能发起一次同版本不同构建的安装，与 `service.ts` 自己注释里「排除版本 == 当前运行版本」的意图冲突。独立复算判为**缺陷**而非「设计没规定」。修法：过滤条件改用 `compareVersions(l.version, currentVersion) !== 0`，与破平同源；导出 `pickBestLocal` 供纯函数用例直测。测试：`test/update/service.test.ts` +1 例（`0.3.0` 运行时 `0.3.0+build.2` ⇒ `null`；对照 `0.2.9` 运行时同一包仍可安装 ⇒ 排除条件不是恒真），25→29 例 | `update/service.ts`（`pickBestLocal` 导出 + 过滤条件）、`test/update/service.test.ts` | §7.5 / §6.5 / I-30 / I-56 / I-72③ / 第 10 条纪律 |
| I-86 | §7.9 `createUpdateAuditSink` 的**测试落点**（**R20 表 4 · Minor**） | I-77① 把 `errors.append` 包进 try/catch，但 `test/update-bootstrap.test.ts` 的四个 errors mock 全是 `{ append: vi.fn() }`、**从不抛** ⇒ 把 try/catch 删掉也没有任何用例会红（第 4 种绿勾假象）。修法：补一条注入会抛的 `append: () => { throw ... }` 用例，断言①不抛穿 ②审计主链路仍按「已成功留痕」记账（复合条件：若异常外抛，`logUpdateEvent` 会当成没留痕而不记限流键，I-65 的修法在此反向失效）③同键当天不重复落库。⚠ 仍如实登记为**注入缝**：这是会抛的替身，不是真 `errors.db` 故障（契约 I-77① 原口径不变）。测试：`test/update-bootstrap.test.ts` +1 例 | `test/update-bootstrap.test.ts` | §7.9 / §9 B⑤ / I-65 / I-68 / I-77① |
| I-87 | 第 10 条纪律 / 第五种绿勾假象与叙述性过时（**R15b 域 3**） | ① `test/update/power-cut.test.ts:686` 用例名写「成功回灌写 `update.rolledBack` **且链自证完好**」，正文只断 `Object.keys(shape)` / `report.ok` / `append≥1` 且 action 正确，**无任何链断言** ⇒ 补 `readFileSync(auditChainPath(dir))` 含 `update.rolledBack` + `(await verifyAuditChain(dir)).ok === true`。② `test/update/install-transaction.test.ts:377` 用例名写「watchdog 已 detached，安装继续进行」，正文只有 `result.ok===true` ⇒ 补 `spawnCalls` 恰好 1 次且 `opts.detached===true`。③ I-72① 之后未登记入口不再退化成 `_OTHER`，但 `service.ts:249` 与 `test/update-state-mirror.test.ts:344` 仍用现在时写「落到 OTHER 并被测试发现」⇒ 改成「这张表只是已知现场的短名来源，不是漏登记守卫」。④ `test/update-state-mirror.test.ts` 的 R14 注释补「I-66 之前」时态；`update-interfaces.md` I-57 行的旧标签名补注。均属**改判据/改口径**，不是加用例，报数时分开写 | `test/update/power-cut.test.ts`、`test/update/install-transaction.test.ts`、`test/update-state-mirror.test.ts`、`update/service.ts`、`docs/superpowers/specs/2026-11-06-update-interfaces.md` I-57 行 | 第 10 条纪律 / §9 A⑦ B④ / I-62 / I-72① / I-77② |
| I-88 | §1.1 / §3.1 / §3.2 / §3.3 / §3.5 与盘态**逐格对齐**（**R20 · Major-7 + R21 · Minor-3 + R15b 域 1/5**） | 三条线各自独立抓到同一批过期数字与一处「说回写了但盘上没有」：① `implementation-review.md:427` 声称「本轮已按实测回写（现值 533）」，但 `:460` 至今写「26 文件 **492** 用例」⇒ **冒充类 1 条 Major**；② `:456` 仍写「当前权威取数 = I-68…I-72」（2127/2130），与 `:47`（2128/2131）冲突；③ `:451` local-artifacts 13、`:454` 19、`:465` install-transaction 51 均滞后；④ `:529`「`BEGIN PRIVATE KEY` 只命中本节这一行自己」与实跑 5 处不符；⑤ 运维手册 `:87`「五种」/`:127`「五条、六条」与代码 6 / 7 自相矛盾，第三态表缺 `ok` 态；⑥ I-77② 声称做过三次变异自查却无可核输出留档。修法：全部按本轮**实跑**回写（逐文件数字取自 `test/update` 子集日志，不抄旧表），历史组就地保留并标「已被取代」；变异自查三次真做并留原始输出（见审核记录 §3.6）；§3.3 补时效声明与作废列表。⚠ 报数纪律：**改判据**与**加用例**分开写，不把语义变更报成增量 | `docs/superpowers/specs/2026-11-06-implementation-review.md`、`docs/operations/update-service.md`、本契约 §10 | §9 A⑦ / 第 10 条纪律 / I-77② / I-79 |

**新增主 Agent 独占文件**（不属任何 sub agent 白名单）：
`electron/main/update-bootstrap.ts`、`test/update-bootstrap.test.ts`、`test/update-config-keys.test.ts`、`test/update-download-resume.test.ts`、`test/update-status-ui.test.tsx`、`test/update-state-mirror.test.ts`、`test/update-version-traversal.test.ts`、`test/update-version-parity.test.ts`、`test/update-signature-parity.test.ts`。

**未变的硬约束**（复核时逐条对过）：IPC 层验签门禁、`autoDownload === false`、`disableDifferentialDownload === true`、§5.2 的 `httpExecutor` origin/重定向/字节上限约束、`lastSeenSequence` HMAC 与损坏即拒绝、伴生清单校验、fail closed。以上任何一条在集成中**只被加强，未被放宽**。

