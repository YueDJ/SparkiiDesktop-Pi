// 统一的 <dataDir>/updates/ 路径构造（契约 §1.9 目录布局）。
// 所有模块共用，避免 feed / pending / state 路径拼写漂移。

import { join } from 'node:path';
import { UPDATE_FEED_DIRNAME, UPDATE_PENDING_DIRNAME } from './types.js';

export const UPDATES_DIRNAME = 'updates';
export const UPDATE_STATE_FILENAME = 'update-state.json';
export const LATEST_YML_FILENAME = 'latest.yml';

/**
 * `version` 作为**路径段**使用时的唯一合法形态：完整 `MAJOR.MINOR.PATCH` 加可选预发布 / 构建元数据。
 *
 * 为什么不用宽字符集 `^[0-9A-Za-z.+-]+$`：那条正则**允许 `..`**，
 * 于是 `pendingVersionDir(dataDir, '..')` 会折叠成 `<dataDir>/updates`，
 * 使 `clearDownloaded({version:'..'})` 变成「递归删除整棵 updates 树」（含 update-state.json 的
 * 防降级下限、feed、全部已下载包），而 `installUpdate({version:'..'})` 又能把
 * 「直接坐在 updates/ 根下的一套清单」当成合法的 `pending/<version>/` —— 一条 IPC 调用
 * 同时摧毁不变量 3 与不变量 4。收紧到 semver 并要求至少含数字段，`..` / `.` / 空段无从通过。
 */
const VERSION_SHAPE_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isSafeVersionSegment(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && VERSION_SHAPE_RE.test(value);
}

/**
 * 安装包**文件名**字符集的唯一权威（R8 · Major-2 之后收敛成一处）。
 * 含 `+`：合法 semver 的构建元数据会直接进名字（`Sparkii-1.2.3+build.7-win-x64.exe`），
 * 此前 verifier / local-artifacts / deriveLatestYml 三处各写了一份字符集且都不含 `+`，
 * 于是发布自检放行、客户端 100% 拒收。穿越不靠字符集挡，由显式 `..` 判断与
 * `isSafeVersionSegment` 负责（见本文件上一条与 verifier 的指针校验）。
 */
// 字符类本体单独导出：R11 指出「用 ARTIFACT_NAME_RE.source.slice(1, -1) 反推」虽然当下正确，
// 但一旦有人给这个正则加/去锚点就会**静默**改变 verifier 那条路径正则的语义。共享字符类没有锚点可切。
export const ARTIFACT_NAME_CHARS = 'A-Za-z0-9._+-';
export const ARTIFACT_NAME_RE = new RegExp(`^[${ARTIFACT_NAME_CHARS}]+$`);

/**
 * Windows 保留设备名——**带扩展名也算**（`CON.exe` 同样是设备，不是文件）。
 * 字符集正则放行它们，于是 `pending/0.3.0/CON.exe` 这一格会在写盘时把字节流向控制台设备
 * 而不是文件（轻则 EPERM / ESPIPE，重则下载写进了设备还"验签通过"）。
 * 发布脚本把名字钉死成 `^Sparkii-…-win-x64\.exe$`，正常链路产不出这类名字；
 * 这道判据防的是「私钥泄露后手工签出的合法清单」那一档（§5.1 的输入不可信口径）。
 */
const WINDOWS_DEVICE_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.[A-Za-z0-9._+-]*)?$/i;

/** 安装包文件名的完整判据：字符集 + 显式禁 `..` + 禁 Windows 设备名。三处调用点同一口径。 */
export function isSafeArtifactName(name: unknown): name is string {
  return typeof name === 'string'
    && name.length > 0 && name.length <= 255
    && ARTIFACT_NAME_RE.test(name)
    && !name.includes('..')
    && !WINDOWS_DEVICE_NAME_RE.test(name);
}

export function updatesDir(dataDir: string): string {
  return join(dataDir, UPDATES_DIRNAME);
}
export function feedDir(dataDir: string): string {
  return join(updatesDir(dataDir), UPDATE_FEED_DIRNAME);
}
export function latestYmlPath(dataDir: string): string {
  return join(feedDir(dataDir), LATEST_YML_FILENAME);
}
export function pendingRoot(dataDir: string): string {
  return join(updatesDir(dataDir), UPDATE_PENDING_DIRNAME);
}
export function pendingVersionDir(dataDir: string, version: string): string {
  // 统一 choke point：所有 pending 路径都过这里，非法形态直接抛错而不是拼出越界路径。
  if (!isSafeVersionSegment(version)) {
    throw new Error(`pendingVersionDir: unsafe version segment ${JSON.stringify(version)}`);
  }
  return join(pendingRoot(dataDir), version);
}
export function stateFilePath(dataDir: string): string {
  return join(updatesDir(dataDir), UPDATE_STATE_FILENAME);
}
