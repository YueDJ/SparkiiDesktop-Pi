// §5.2 定案 A 的实现处：本地 file:// 派生 feed + 自定义 httpExecutor。
// 关键实测事实（任务 0 T0-2/3/4/7）：
//  - setFeedURL 接受 file://，provider 派生 file:///…/feed/latest.yml?noCache=…；
//  - 默认 ElectronHttpExecutor 只走 electron.net.request（仅 http/https），file: 必失败 → 必须注入自定义 executor；
//  - httpExecutor 必须在 setFeedURL() 之前赋值（setFeedURL 把 executor 捕获进 createProviderRuntimeOptions）；
//  - downloadUpdate() 走 httpExecutor.download()，自定义 executor 必须同时实现 request() 与 download()。
// 本模块刻意不在顶层静态 import electron-updater（生产由 createRequire 懒加载），
// 以便单测在 jsdom 下零 electron 依赖地加载。

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { feedDir, latestYmlPath } from './dirs.js';
import { PART_SUFFIX, ProgressAccumulator, verifyArtifactBytes } from './downloader.js';
import { logUpdateEvent } from './audit.js';
import type {
  AuditLike, LoggerLike, ReleaseJson, UpdateProgress,
} from './types.js';

// ---- 契约 §5 形态 ----

export interface RequestOptions {
  protocol?: string;
  hostname?: string;
  port?: string | number;
  path?: string;
  url?: URL | string;
  headers?: Record<string, string>;
}

/**
 * electron-updater 的 ProgressInfo 形态（`download-progress` 事件载荷）。
 * 我们的 executor 同时带 UpdateProgress 与 ProgressInfo 两套字段，
 * 因此既能被 updater 原样转发，也能被 service 直接消费。
 */
export interface ProgressInfoLike {
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface DownloadExecutorOptions {
  expectedBytes?: number;
  expectedSha512?: string;
  sha512?: string | null;       // 兼容 electron-updater DownloadOptions 形态
  cancellationToken?: { cancelled?: boolean; onCancelled?: (cb: () => void) => void };
  onProgress?: (p: UpdateProgress & ProgressInfoLike) => void;
  timeoutMs?: number;
}

export interface CustomHttpExecutor {
  maxRedirects: 0;
  request(options: RequestOptions): Promise<Buffer>;
  download(url: URL, destination: string, options: DownloadExecutorOptions): Promise<string>;
}

/**
 * 响应体阶段的停滞看门狗：连续无新字节即中止。取 30s，明显大于 8s 连接超时，
 * 又足以识破「连上但不发数据」的死连接；不约束总时长（401MB 大包允许慢链路）。
 */
export const STALL_TIMEOUT_MS = 30_000;

export interface NsisUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  disableDifferentialDownload: boolean;
  httpExecutor: unknown;
  setFeedURL(config: { provider: string; url: string }): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(...args: unknown[]): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

// ---- 本地派生 feed ----

/** 原子写 <dataDir>/updates/feed/latest.yml，返回 pathToFileURL(feedDir + sep).href。 */
export async function writeDerivedFeed(dataDir: string, yml: string): Promise<string> {
  const dir = feedDir(dataDir);
  await mkdir(dir, { recursive: true });
  const target = latestYmlPath(dataDir);
  const tmp = `${target}.tmp-${randomUUID()}`;
  await writeFile(tmp, yml, 'utf8');
  await rename(tmp, target);
  return pathToFileURL(dir + sep).href;
}

/** 从 configureRequestUrl 写入的 options 还原 href（options.url 优先，其次拼 protocol/host/path）。 */
function reconstructHref(options: RequestOptions): string {
  if (options.url) {
    const u = options.url instanceof URL ? options.url : new URL(String(options.url));
    return u.href;
  }
  const protocol = options.protocol ?? '';
  const host = options.hostname
    ? `//${options.hostname}${options.port ? `:${options.port}` : ''}`
    : '';
  return `${protocol}${host}${options.path ?? ''}`;
}

export interface LocalFeedExecutorOptions {
  dataDir: string;
  baseUrl: string;                 // 归一化后的远程 baseUrl（download 校验 host/port/scheme 用）
  release: ReleaseJson;            // 提供 download 的 expectedBytes / expectedSha512 默认值
  fetchFn?: typeof fetch;
  now?(): number;
  audit?: AuditLike;
  logger?: LoggerLike;
  requestTimeoutMs?: number;
}

/**
 * 构造 §5.2 定案 A 的自定义 executor：
 *  - request()：识别 file: 且仅允许 <dataDir>/updates/feed/latest.yml，本地 readFileSync（零网络）；其它一律抛错。
 *  - download()：校验 url 与 baseUrl 同 scheme/host/port、禁重定向、拒 https→http 降级、
 *    8s 超时、字节上限、流式 sha512/bytes 复核、onProgress、响应 cancellationToken。
 */
export function createLocalFeedExecutor(opts: LocalFeedExecutorOptions): CustomHttpExecutor {
  const dataDir = opts.dataDir;
  const base = new URL(opts.baseUrl);
  const allowedFeedPath = resolve(latestYmlPath(dataDir));
  const fetchFn = opts.fetchFn ?? fetch;
  const release = opts.release;
  const timeoutMs = opts.requestTimeoutMs ?? 8000;

  const executor: CustomHttpExecutor = {
    maxRedirects: 0,

    async request(options: RequestOptions): Promise<Buffer> {
      let href: string;
      try {
        href = reconstructHref(options);
      } catch (err) {
        throw new Error(`local feed executor: cannot reconstruct url: ${String(err)}`);
      }
      let u: URL;
      try {
        u = new URL(href);
      } catch (err) {
        throw new Error(`local feed executor: bad url: ${String(err)}`);
      }
      if (u.protocol !== 'file:') {
        throw new Error(`local feed executor: only file: is allowed, got ${u.protocol}`);
      }
      // fileURLToPath 对带 ?noCache= 的 URL 需先去掉 query / hash。
      const clean = href.split('?')[0].split('#')[0];
      let filePath: string;
      try {
        filePath = fileURLToPath(clean);
      } catch (err) {
        throw new Error(`local feed executor: fileURLToPath failed: ${String(err)}`);
      }
      if (resolve(filePath) !== allowedFeedPath) {
        throw new Error('local feed executor: path outside derived feed (fail closed)');
      }
      return readFileSync(filePath);
    },

    async download(url: URL, destination: string, options: DownloadExecutorOptions): Promise<string> {
      // ① 校验 scheme/host/port 与 baseUrl 完全一致。
      if (url.protocol !== base.protocol || url.hostname !== base.hostname || url.port !== base.port) {
        throw new Error('download executor: url origin mismatch with baseUrl');
      }
      // ② 拒 https → http 降级（scheme 相等时天然成立，这里显式兜底）。
      if (base.protocol === 'https:' && url.protocol !== 'https:') {
        throw new Error('download executor: https->http downgrade rejected');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('download executor: unsupported scheme');
      }

      const expectedBytes = options.expectedBytes ?? release.artifact.bytes;
      const expectedSha512 = options.expectedSha512 ?? options.sha512 ?? release.artifact.sha512;
      const headerTimeoutMs = options.timeoutMs ?? timeoutMs;
      const partPath = `${destination}${PART_SUFFIX}`;

      const controller = new AbortController();
      let cancelledByToken = false;
      const onCancel = () => {
        cancelledByToken = true;
        controller.abort(new Error('download cancelled'));
      };
      if (options.cancellationToken?.cancelled) onCancel();
      options.cancellationToken?.onCancelled?.(onCancel);

      // 断点续传（§7.6 / C1）：已有 .part 前缀则带 Range 继续；0 字节或已 ≥ 包体一律重下。
      let resumed = 0;
      try {
        const st = await stat(partPath);
        if (st.size > 0 && st.size < expectedBytes) resumed = st.size;
        else await rm(partPath, { force: true });
      } catch {
        /* 无 .part：全量下载 */
      }

      let hash = createHash('sha512');
      let acc = new ProgressAccumulator(expectedBytes);
      if (resumed > 0) {
        // 前缀字节预热 sha512；若服务端不认 Range（回 200）则整体作废重来。
        for await (const chunk of createReadStream(partPath)) hash.update(chunk as Buffer);
        acc = new ProgressAccumulator(expectedBytes);
        acc.add(resumed);
      }
      // 进度载荷同时给出 UpdateProgress 与 ProgressInfo 两套字段（见类型注释）。
      const transferStartedAt = Date.now();
      const reportProgress = (): void => {
        const snap = acc.snapshot(partPath);
        const elapsedSec = Math.max(0.001, (Date.now() - transferStartedAt) / 1000);
        options.onProgress?.({
          ...snap,
          transferred: snap.bytesDownloaded,
          total: snap.bytesTotal,
          bytesPerSecond: Math.round(snap.bytesDownloaded / elapsedSec),
        });
      };
      reportProgress();

      // 超时口径（§5.2「单次连接 8s 超时」）：8s 只约束「连上并拿到响应头」；
      // 响应体阶段改用停滞看门狗，否则 401MB 大包必被整体超时误杀。
      let bytes = resumed;
      let overflow = false;
      let corrupt = false;
      let headerTimer: ReturnType<typeof setTimeout> | null =
        setTimeout(() => controller.abort(new Error('download header timeout')), headerTimeoutMs);
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      const clearTimers = () => {
        if (headerTimer) clearTimeout(headerTimer);
        if (stallTimer) clearTimeout(stallTimer);
        headerTimer = null;
        stallTimer = null;
      };
      const armStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => controller.abort(new Error('download stalled')), STALL_TIMEOUT_MS);
      };

      try {
        await mkdir(dirname(destination), { recursive: true });
        armStall();
        const res = await fetchFn(url.href, {
          redirect: 'manual',
          signal: controller.signal,
          headers: resumed > 0 ? { Range: `bytes=${resumed}-` } : undefined,
        });
        if (headerTimer) { clearTimeout(headerTimer); headerTimer = null; }
        // ③ 200 / （带 Range 且）206 之外一律失败；3xx 因 redirect:'manual' 也落到这里。
        if (res.status !== 200 && res.status !== 206) {
          throw new Error(`download executor: unexpected status ${res.status}`);
        }
        const appendMode = res.status === 206 && resumed > 0;
        if (res.status === 206 && resumed === 0) {
          corrupt = true;
          throw new Error('download executor: 206 without a Range request');
        }
        if (!appendMode && resumed > 0) {
          // 服务端忽略 Range → 整包重写，作废预热哈希与计数。
          resumed = 0;
          bytes = 0;
          hash = createHash('sha512');
          acc = new ProgressAccumulator(expectedBytes);
        }
        // 防服务端偷偷重定向到别的 host（redirect:'manual' 下仍校验最终 URL）。
        if (res.url) {
          const finalUrl = new URL(res.url);
          if (finalUrl.protocol !== base.protocol || finalUrl.hostname !== base.hostname ||
              finalUrl.port !== base.port) {
            throw new Error('download executor: redirected to different origin');
          }
        }
        const body = res.body
          ? (Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]))
          : null;
        if (!body) throw new Error('download executor: empty response body');

        const counting = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            bytes += chunk.length;
            if (bytes > expectedBytes) {
              overflow = true;
              corrupt = true;
              controller.abort(new Error('download exceeded expected bytes'));
              cb(new Error('ARTIFACT_INVALID: size overflow'));
              return;
            }
            hash.update(chunk);
            acc.add(chunk.length);
            armStall();
            reportProgress();
            cb(null, chunk);
          },
        });

        await pipeline(body, counting, createWriteStream(partPath, { flags: appendMode ? 'a' : 'w' }));
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = null;

        // ④ 完成后复核 sha512 与 bytes（与已验签清单一致），通过后原子改名到 destination。
        if (overflow || bytes !== expectedBytes) {
          corrupt = true;
          throw new Error('ARTIFACT_INVALID: size mismatch');
        }
        if (hash.digest('base64') !== expectedSha512) {
          corrupt = true;
          throw new Error('ARTIFACT_INVALID: sha512 mismatch');
        }
        await rename(partPath, destination);
        // 二次保险：落盘文件再流式复核一遍。
        const recheck = await verifyArtifactBytes(destination, expectedSha512, expectedBytes);
        if (!recheck.ok) {
          corrupt = true;
          throw new Error('ARTIFACT_INVALID: file recheck failed');
        }
      } catch (err) {
        // 用户取消或包体损坏 → 删 .part；传输类错误（断网/超时/停滞）→ 保留 .part 供续传。
        if (cancelledByToken || corrupt) await rm(partPath, { force: true });
        await rm(destination, { force: true });
        // R1 · Major-3：审计口径必须分开。
        //   corrupt（sha512/bytes 不符、超字节、异源跳转、https→http、无 Range 的 206）
        //     ⇒ update.verify-failed：这是投毒/篡改信号，会被镜像进 errors 只读展示。
        //   其它（404/5xx、连接与停滞超时、用户取消、空响应体）
        //     ⇒ update.failed：只是没下载成，把它写成「验签失败」会制造误告警并稀释真信号。
        const securitySignal = corrupt
          || /different origin|https->http|206 without a Range/i.test(String(err));
        if (!cancelledByToken) {
          await logUpdateEvent(opts.audit, securitySignal ? 'update.verify-failed' : 'update.failed', {
            reason: securitySignal ? 'DOWNLOAD_ARTIFACT_INVALID' : 'DOWNLOAD_FAILED', detail: String(err),
          }, opts.logger);
        }
        throw err;
      } finally {
        clearTimers();
      }
      return destination;
    },
  };

  return executor;
}

export interface CreateUpdaterOptions extends LocalFeedExecutorOptions {
  feedUrl: string;                 // writeDerivedFeed 返回的 file:// URL
  updater?: NsisUpdaterLike;       // 单测注入；缺省由 createRequire 懒加载真实 NsisUpdater
}

/**
 * updater 组件本身不可用（打包缺 node_modules/electron-updater、app-update.yml 缺失等）。
 * 与「元数据逐字段比对不符」严格区分：前者是环境缺件（NOT_READY，可修复），
 * 后者才是可能的投毒信号（ARTIFACT_INVALID，必须写验签失败审计）。两者都 fail closed，但语义不同。
 */
export class UpdaterUnavailableError extends Error {
  readonly updaterUnavailable = true;
  constructor(message: string) {
    super(`updater unavailable: ${message}`);
    this.name = 'UpdaterUnavailableError';
  }
}

export function isUpdaterUnavailable(err: unknown): boolean {
  return err instanceof UpdaterUnavailableError
    || (typeof err === 'object' && err !== null && (err as { updaterUnavailable?: unknown }).updaterUnavailable === true);
}

/** 生产默认：懒加载真实 NsisUpdater（不传 options，那是 publish config）。 */
function createDefaultUpdater(): NsisUpdaterLike {
  try {
    const require = createRequire(import.meta.url);
    const mod = require('electron-updater') as { NsisUpdater: new () => NsisUpdaterLike };
    return new mod.NsisUpdater();
  } catch (err) {
    throw new UpdaterUnavailableError(String(err));
  }
}

/**
 * new NsisUpdater() → 三个开关 → 先注入 httpExecutor → setFeedURL({provider:'generic', url:feedUrl})。
 * 严禁调用安装器自带的「退出即安装」方法（本期安装执行自管，禁止走该快捷路径）。
 */
export function createUpdater(
  opts: CreateUpdaterOptions,
): { updater: NsisUpdaterLike; executor: CustomHttpExecutor } {
  const executor = createLocalFeedExecutor(opts);
  const updater = opts.updater ?? createDefaultUpdater();
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.disableDifferentialDownload = true;
  updater.httpExecutor = executor;                 // 必须在 setFeedURL 之前
  updater.setFeedURL({ provider: 'generic', url: opts.feedUrl });
  return { updater, executor };
}

/** 在 update-available 回调里逐字段比对 version/path/sha512/size（§6.5 二次保险）。 */
export function crossCheckUpdateInfo(
  info: unknown,
  release: ReleaseJson,
): { ok: true } | { ok: false; reason: string } {
  const i = info as {
    version?: string;
    path?: string;
    sha512?: string;
    size?: number;
    files?: Array<{ url?: string; sha512?: string; size?: number }>;
  } | null;
  if (!i || typeof i !== 'object') return { ok: false, reason: 'ARTIFACT_INVALID' };
  const version = i.version;
  const path = i.path ?? i.files?.[0]?.url;
  const sha512 = i.sha512 ?? i.files?.[0]?.sha512;
  const size = i.size ?? i.files?.[0]?.size;
  const basename = (p: string): string => p.split(/[\\/]/).pop() ?? p;
  if (version !== release.version) return { ok: false, reason: 'ARTIFACT_INVALID' };
  if (path == null || basename(String(path)) !== release.artifact.name) {
    return { ok: false, reason: 'ARTIFACT_INVALID' };
  }
  if (sha512 !== release.artifact.sha512) return { ok: false, reason: 'ARTIFACT_INVALID' };
  if (size !== release.artifact.bytes) return { ok: false, reason: 'ARTIFACT_INVALID' };
  return { ok: true };
}
