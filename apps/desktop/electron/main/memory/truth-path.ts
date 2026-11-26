import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join, parse } from 'node:path';
import { Worker } from 'node:worker_threads';

const FILE_ATTRIBUTE_REPARSE_POINT = 16;
const PROBE_SHARED_BYTES = 8 * 1024 * 1024;
const PROBE_WAIT_MS = 5_000;

export interface PathProbeContext {
  attributePaths: Set<string>;
  probeAttributes: (paths: string[]) => number[];
}

export class TruthPathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TruthPathSafetyError';
  }
}

export function pathProbeContext(probeAttributes: (paths: string[]) => number[] = reparseAttributes): PathProbeContext {
  return { attributePaths: new Set(), probeAttributes };
}

const PROBE_DAEMON_SOURCE = `
const { workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');

const control = new Int32Array(workerData.shared, 0, 4);
const payload = new Uint8Array(workerData.shared, 16);
const capacity = payload.length;
let child;
let waiting = false;
let expected = 0;
let output = Buffer.alloc(0);
let startupFailure = '';

function fail(message) {
  if (!waiting) {
    startupFailure = String(message);
    return;
  }
  const bytes = Buffer.from(String(message), 'utf8');
  const length = Math.min(bytes.length, capacity);
  payload.set(bytes.subarray(0, length), 0);
  Atomics.store(control, 2, length);
  Atomics.store(control, 0, 4);
  Atomics.notify(control, 0);
  waiting = false;
}

try {
  child = spawn(workerData.helper, ['reparse-daemon'], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => undefined);
  child.on('error', (error) => fail(error && error.message ? error.message : 'probe daemon failed'));
  child.on('exit', (code) => fail('probe daemon exited: ' + String(code)));
  child.stdout.on('data', (chunk) => {
    if (!waiting) return;
    output = Buffer.concat([output, chunk]);
    if (output.length < 4) return;
    const count = output.readUInt32LE(0);
    if (count !== expected) return fail('probe daemon response count mismatch');
    if (output.length < 4 + count) return;
    if (output.length !== 4 + count) return fail('probe daemon response length mismatch');
    const values = output.subarray(4);
    for (const value of values) {
      if (value !== 0 && value !== 1) return fail('probe daemon returned an invalid attribute');
    }
    payload.set(values, 0);
    Atomics.store(control, 1, count);
    Atomics.store(control, 0, 3);
    Atomics.notify(control, 0);
    waiting = false;
    output = Buffer.alloc(0);
    waitForRequest();
  });
} catch (error) {
  fail(error && error.message ? error.message : 'probe daemon failed');
}

process.on('exit', () => {
  try { if (child) child.kill(); } catch { /* parent is exiting */ }
});

function waitForRequest() {
  const status = Atomics.load(control, 0);
  if (status !== 1) {
    const waiter = Atomics.waitAsync(control, 0, status);
    if (waiter.async) waiter.value.then(waitForRequest);
    else setImmediate(waitForRequest);
    return;
  }
  Atomics.store(control, 0, 2);
  if (startupFailure) {
    waiting = true;
    fail(startupFailure);
    return;
  }
  const count = Atomics.load(control, 1);
  const parts = [];
  let offset = 4;
  let valid = true;
  const total = Atomics.load(control, 3);
  if (total < 4 || total > capacity) {
    waiting = true;
    fail('probe daemon request length is invalid');
    return;
  }
  for (let index = 0; index < count; index += 1) {
    if (offset + 4 > total) { valid = false; break; }
    const length = Buffer.from(payload.buffer, payload.byteOffset + offset, 4).readUInt32LE(0);
    offset += 4;
    if (offset + length > total || offset + length > capacity) { valid = false; break; }
    parts.push(Buffer.from(payload.buffer, payload.byteOffset + offset, length));
    offset += length;
  }
  if (!valid || offset !== total) {
    waiting = true;
    fail('probe daemon request is invalid');
    return;
  }
  const request = Buffer.concat([Buffer.alloc(4), ...parts.map((part) => {
    const size = Buffer.alloc(4);
    size.writeUInt32LE(part.length, 0);
    return Buffer.concat([size, part]);
  })]);
  request.writeUInt32LE(count, 0);
  expected = count;
  output = Buffer.alloc(0);
  waiting = true;
  child.stdin.write(request, (error) => {
    if (error) fail(error.message);
  });
}

waitForRequest();
`;

interface ProbeDaemon {
  helper: string;
  worker: Worker;
  control: Int32Array;
  payload: Uint8Array;
}

let probeDaemon: ProbeDaemon | undefined;

function disposeProbeDaemon(): void {
  const daemon = probeDaemon;
  probeDaemon = undefined;
  if (daemon) void daemon.worker.terminate();
}

function encodeProbePaths(paths: string[]): Buffer {
  const encoded = paths.map((path) => Buffer.from(path, 'utf8'));
  const length = 4 + encoded.reduce((total, path) => total + 4 + path.length, 0);
  if (length > PROBE_SHARED_BYTES - 16) throw new Error('原生探针请求过大');
  const request = Buffer.allocUnsafe(length);
  request.writeUInt32LE(paths.length, 0);
  let offset = 4;
  for (const path of encoded) {
    request.writeUInt32LE(path.length, offset);
    offset += 4;
    path.copy(request, offset);
    offset += path.length;
  }
  return request;
}

function daemonAttributes(helper: string, paths: string[]): number[] {
  if (!paths.length) return [];
  if (probeDaemon?.helper !== helper) {
    disposeProbeDaemon();
    const shared = new SharedArrayBuffer(PROBE_SHARED_BYTES);
    const worker = new Worker(PROBE_DAEMON_SOURCE, {
      eval: true,
      workerData: { helper, shared },
    });
    worker.unref();
    probeDaemon = {
      helper,
      worker,
      control: new Int32Array(shared, 0, 4),
      payload: new Uint8Array(shared, 16),
    };
  }
  const daemon = probeDaemon!;
  const request = encodeProbePaths(paths);
  if (request.length > daemon.payload.length) throw new Error('原生探针请求过大');
  daemon.payload.set(request, 0);
  Atomics.store(daemon.control, 1, paths.length);
  Atomics.store(daemon.control, 3, request.length);
  Atomics.store(daemon.control, 0, 1);
  Atomics.notify(daemon.control, 0);
  const waited = Atomics.wait(daemon.control, 0, 1, PROBE_WAIT_MS);
  const status = Atomics.load(daemon.control, 0);
  if (waited === 'timed-out') {
    disposeProbeDaemon();
    throw new Error('原生探针常驻进程超时');
  }
  if (status === 4) {
    const errorLength = Atomics.load(daemon.control, 2);
    const message = Buffer.from(daemon.payload.subarray(0, errorLength)).toString('utf8');
    disposeProbeDaemon();
    throw new Error(message || '原生探针常驻进程失败');
  }
  if (status !== 3) {
    disposeProbeDaemon();
    throw new Error('原生探针常驻进程返回意外状态');
  }
  const count = Atomics.load(daemon.control, 1);
  if (count !== paths.length) {
    disposeProbeDaemon();
    throw new Error('原生探针常驻进程返回数量不一致');
  }
  const values = Array.from(daemon.payload.subarray(0, count));
  Atomics.store(daemon.control, 0, 0);
  return values;
}

function reparseAttributes(pathsToInspect: string[]): number[] {
  if (!pathsToInspect.length || process.platform !== 'win32') return pathsToInspect.map(() => 0);
  const candidates = [
    ...(process.resourcesPath ? [join(process.resourcesPath, 'windows-sandbox', 'SandboxProbe.exe')] : []),
    join(process.cwd(), 'apps', 'desktop', 'native', 'windows-sandbox', 'bin', 'SandboxProbe.exe'),
  ];
  const helper = candidates.find((candidate) => existsSync(candidate));
  if (!helper) throw new Error('Windows reparse-point attribute probe is unavailable');
  let values: number[];
  try {
    values = daemonAttributes(helper, pathsToInspect);
  } catch {
    disposeProbeDaemon();
    const output = execFileSync(helper, ['reparse-attributes', ...pathsToInspect], {
      windowsHide: true,
      timeout: 10_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    values = output ? output.split(/\s+/).map(Number) : [];
  }
  if (values.length !== pathsToInspect.length || values.some((value) => value !== 0 && value !== 1)) {
    throw new Error('Windows reparse-point attribute probe returned an invalid result');
  }
  return values.map((value) => value * FILE_ATTRIBUTE_REPARSE_POINT);
}

export function queuePathInspection(path: string, context: PathProbeContext): void {
  if (!isAbsolute(path)) throw new Error('记忆真相路径必须是绝对路径');
  const root = parse(path).root;
  const segments = path.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const info = lstatSync(current, { bigint: true });
      if (info.isSymbolicLink()) throw new Error(`记忆真相路径包含链接：${current}`);
      if (!info.isDirectory() && info.nlink > 1n) throw new Error(`记忆真相路径包含硬链接：${current}`);
      context.attributePaths.add(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw error;
    }
  }
}

export function flushPathInspection(context: PathProbeContext): void {
  const inspected = [...context.attributePaths];
  const attributes = context.probeAttributes(inspected);
  if (attributes.length !== inspected.length || attributes.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error('记忆真相路径属性探测返回了无效结果');
  }
  if (attributes.some((value) => value === FILE_ATTRIBUTE_REPARSE_POINT)) {
    throw new Error('记忆真相路径包含重解析点');
  }
  context.attributePaths.clear();
}

export function assertNoReparseOrHardlinks(
  paths: string[],
  probeAttributes: (paths: string[]) => number[] = reparseAttributes,
): void {
  if (!paths.length) return;
  try {
    const context = pathProbeContext(probeAttributes);
    for (const path of paths) queuePathInspection(path, context);
    flushPathInspection(context);
  } catch (error) {
    throw new TruthPathSafetyError(error instanceof Error ? error.message : String(error));
  }
}

export function assertNoReparseOrHardlink(
  path: string,
  probeAttributes: (paths: string[]) => number[] = reparseAttributes,
): void {
  assertNoReparseOrHardlinks([path], probeAttributes);
}

export function assertTruthPathSafe(
  path: string,
  probeAttributes: (paths: string[]) => number[] = reparseAttributes,
): void {
  try {
    assertNoReparseOrHardlink(path, probeAttributes);
  } catch (error) {
    throw new TruthPathSafetyError(error instanceof Error ? error.message : String(error));
  }
}

export interface TruthFileIdentity {
  identity: string;
  stats: BigIntStats;
}

export type TruthAttributeProbe = (paths: string[]) => number[];

export function truthFileIdentity(stats: BigIntStats): string {
  return [
    stats.dev,
    stats.ino,
    stats.mode,
    stats.nlink,
    stats.size,
    stats.mtimeMs,
    stats.ctimeMs,
  ].join(':');
}


function readTruthFileStats(
  path: string,
  options: { allowMissing?: boolean; regularFile?: boolean },
): BigIntStats | undefined {
  let stats: BigIntStats;
  try {
    stats = lstatSync(path, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (options.allowMissing && (code === 'ENOENT' || code === 'ENOTDIR')) return undefined;
    throw error;
  }
  if (stats.isSymbolicLink()) throw new TruthPathSafetyError(`记忆真相路径包含链接：${path}`);
  if (options.regularFile && !stats.isFile()) {
    throw new TruthPathSafetyError(`记忆真相路径不是普通文件：${path}`);
  }
  if (!stats.isDirectory() && !stats.isFile()) {
    throw new TruthPathSafetyError(`记忆真相路径不是普通文件：${path}`);
  }
  if (!stats.isDirectory() && stats.nlink !== 1n) {
    throw new TruthPathSafetyError(`记忆真相文件必须只有一个硬链接：${path}`);
  }
  return stats;
}

export function inspectTruthFile(
  path: string,
  probeAttributes: TruthAttributeProbe = reparseAttributes,
  options: { allowMissing?: boolean; regularFile?: boolean } = {},
): TruthFileIdentity | undefined {
  assertTruthPathSafe(path, probeAttributes);
  const stats = readTruthFileStats(path, options);
  return stats ? { identity: truthFileIdentity(stats), stats } : undefined;
}

export interface TruthFileInspection {
  path: string;
  options?: { allowMissing?: boolean; regularFile?: boolean; expectedIdentity?: string };
}

export function inspectTruthFiles(
  inspections: TruthFileInspection[],
  probeAttributes: TruthAttributeProbe = reparseAttributes,
): Array<TruthFileIdentity | undefined> {
  if (!inspections.length) return [];
  try {
    const context = pathProbeContext(probeAttributes);
    for (const inspection of inspections) queuePathInspection(inspection.path, context);
    flushPathInspection(context);
    return inspections.map((inspection) => {
      const stats = readTruthFileStats(inspection.path, inspection.options ?? {});
      return stats ? { identity: truthFileIdentity(stats), stats } : undefined;
    });
  } catch (error) {
    if (error instanceof TruthPathSafetyError) throw error;
    throw new TruthPathSafetyError(error instanceof Error ? error.message : String(error));
  }
}

export function inspectTruthFilesTwice(
  inspections: TruthFileInspection[],
  probeAttributes: TruthAttributeProbe = reparseAttributes,
): Array<TruthFileIdentity | undefined> {
  if (!inspections.length) return [];
  try {
    const context = pathProbeContext(probeAttributes);
    for (const inspection of inspections) queuePathInspection(inspection.path, context);
    flushPathInspection(context);
    const first = inspections.map((inspection) => {
      const stats = readTruthFileStats(inspection.path, inspection.options ?? {});
      return stats ? { identity: truthFileIdentity(stats), stats } : undefined;
    });
    const second = inspections.map((inspection, index) => {
      const stats = readTruthFileStats(inspection.path, inspection.options ?? {});
      const current = stats ? { identity: truthFileIdentity(stats), stats } : undefined;
      if (first[index]?.identity !== current?.identity) {
        throw new TruthPathSafetyError(`记忆真相路径在连续探测之间发生变化：${inspection.path}`);
      }
      const expectedIdentity = inspection.options?.expectedIdentity;
      if (expectedIdentity && current?.identity !== expectedIdentity) {
        throw new TruthPathSafetyError(`记忆真相文件身份已变化：${inspection.path}`);
      }
      return current;
    });
    return second;
  } catch (error) {
    if (error instanceof TruthPathSafetyError) throw error;
    throw new TruthPathSafetyError(error instanceof Error ? error.message : String(error));
  }
}

export function inspectTruthFileTwice(
  path: string,
  probeAttributes: TruthAttributeProbe = reparseAttributes,
  options: { allowMissing?: boolean; expectedIdentity?: string; regularFile?: boolean } = {},
): TruthFileIdentity | undefined {
  const first = inspectTruthFile(path, probeAttributes, options);
  const secondStats = readTruthFileStats(path, options);
  const second = secondStats ? { identity: truthFileIdentity(secondStats), stats: secondStats } : undefined;
  if (first?.identity !== second?.identity) {
    throw new TruthPathSafetyError(`记忆真相路径在连续探测之间发生变化：${path}`);
  }
  if (options.regularFile && second && !second.stats.isFile()) {
    throw new TruthPathSafetyError(`记忆真相路径不是普通文件：${path}`);
  }
  if (options.expectedIdentity && second?.identity !== options.expectedIdentity) {
    throw new TruthPathSafetyError(`记忆真相文件身份已变化：${path}`);
  }
  return second;
}

export function assertTruthFileIdentity(
  path: string,
  expectedIdentity: string,
  probeAttributes: TruthAttributeProbe = reparseAttributes,
  options: { regularFile?: boolean } = {},
): TruthFileIdentity {
  const current = inspectTruthFile(path, probeAttributes, options);
  if (!current || current.identity !== expectedIdentity) {
    throw new TruthPathSafetyError(`记忆真相文件身份已变化：${path}`);
  }
  return current;
}

export interface VerifiedTruthReadOptions {
  probeAttributes?: TruthAttributeProbe;
  expectedIdentity?: string;
  allowMissing?: boolean;
  read?: (path: string) => Buffer;
}

export function readTruthDirectoryVerified(path: string, probeAttributes: TruthAttributeProbe = reparseAttributes): string[] {
  const before = inspectTruthFileTwice(path, probeAttributes);
  if (!before?.stats.isDirectory()) throw new TruthPathSafetyError(`记忆真相路径不是目录：${path}`);
  const entries = readdirSync(path);
  assertTruthFileIdentity(path, before.identity, probeAttributes);
  return entries;
}

export interface VerifiedTruthReadResult {
  content: Buffer;
  identity: string;
  stats: BigIntStats;
}

export function readTruthFileVerifiedResult(path: string, options: VerifiedTruthReadOptions = {}): VerifiedTruthReadResult | undefined {
  const probeAttributes = options.probeAttributes ?? reparseAttributes;
  const before = inspectTruthFileTwice(path, probeAttributes, {
    allowMissing: options.allowMissing,
    regularFile: true,
    expectedIdentity: options.expectedIdentity,
  });
  if (!before) return undefined;
  const content = (options.read ?? readFileSync)(path);
  try {
    assertTruthFileIdentity(path, before.identity, probeAttributes, { regularFile: true });
  } catch (error) {
    if (error instanceof TruthPathSafetyError) throw error;
    throw new TruthPathSafetyError(`记忆真相文件在读取后变化：${path}`);
  }
  return { content, identity: before.identity, stats: before.stats };
}

export function readTruthFileVerified(path: string, options: VerifiedTruthReadOptions = {}): Buffer {
  const result = readTruthFileVerifiedResult(path, options);
  if (!result) throw new TruthPathSafetyError(`记忆真相文件不存在：${path}`);
  return result.content;
}

export function readTruthDirectoriesVerified(
  pathsToRead: string[],
  probeAttributes: TruthAttributeProbe = reparseAttributes,
): string[][] {
  if (!pathsToRead.length) return [];
  try {
    const before = inspectTruthFilesTwice(pathsToRead.map((path) => ({ path })), probeAttributes);
    const entries = pathsToRead.map((path, index) => {
      if (!before[index]?.stats.isDirectory()) {
        throw new TruthPathSafetyError(`记忆真相路径不是目录：${path}`);
      }
      return readdirSync(path);
    });
    const after = inspectTruthFiles(pathsToRead.map((path) => ({ path })), probeAttributes);
    for (let index = 0; index < pathsToRead.length; index += 1) {
      if (!after[index] || after[index]!.identity !== before[index]!.identity) {
        throw new TruthPathSafetyError(`记忆真相目录在读取后变化：${pathsToRead[index]}`);
      }
    }
    return entries;
  } catch (error) {
    if (error instanceof TruthPathSafetyError) throw error;
    throw new TruthPathSafetyError(error instanceof Error ? error.message : String(error));
  }
}

export interface VerifiedTruthReadRequest extends VerifiedTruthReadOptions {
  path: string;
}

/**
 * Verify a group of files at one logical read boundary. Every path still gets
 * a fresh native ancestry probe, two pre-read lstat identities, a content read,
 * and a fresh post-read native probe plus lstat identity comparison. A caller
 * may supply the immediately preceding double-lstat inspection to fold an
 * identity-cache lookup into this same boundary.
 */
export function readTruthFilesVerified(
  requests: VerifiedTruthReadRequest[],
  probeAttributes: TruthAttributeProbe = reparseAttributes,
  precedingInspection?: Array<TruthFileIdentity | undefined>,
): Array<VerifiedTruthReadResult | undefined> {
  if (!requests.length) return [];
  try {
    const before = precedingInspection ?? inspectTruthFilesTwice(requests.map((request) => ({
      path: request.path,
      options: {
        allowMissing: request.allowMissing,
        regularFile: true,
        expectedIdentity: request.expectedIdentity,
      },
    })), probeAttributes);
    if (before.length !== requests.length) throw new TruthPathSafetyError('记忆真相读取预探测数量不一致');
    for (let index = 0; index < requests.length; index += 1) {
      const current = before[index];
      if (current && !current.stats.isFile()) throw new TruthPathSafetyError(`记忆真相路径不是普通文件：${requests[index].path}`);
      const expected = requests[index].expectedIdentity;
      if (expected && current?.identity !== expected) {
        throw new TruthPathSafetyError(`记忆真相文件身份已变化：${requests[index].path}`);
      }
    }
    const results: Array<VerifiedTruthReadResult | undefined> = requests.map(() => undefined);
    const existing = requests.flatMap((request, index) => before[index] ? [{ request, index, inspection: before[index]! }] : []);
    for (const { request, index, inspection } of existing) {
      results[index] = {
        content: (request.read ?? readFileSync)(request.path),
        identity: inspection.identity,
        stats: inspection.stats,
      };
    }
    const after = inspectTruthFiles(existing.map(({ request }) => ({
      path: request.path,
      options: { regularFile: true },
    })), probeAttributes);
    for (let index = 0; index < existing.length; index += 1) {
      if (!after[index] || after[index]!.identity !== existing[index].inspection.identity) {
        throw new TruthPathSafetyError(`记忆真相文件在读取后变化：${existing[index].request.path}`);
      }
    }
    return results;
  } catch (error) {
    if (error instanceof TruthPathSafetyError) throw error;
    throw new TruthPathSafetyError(error instanceof Error ? error.message : String(error));
  }
}

export interface VerifiedTruthCopyOptions {
  probeAttributes?: TruthAttributeProbe;
  expectedSourceIdentity?: string;
  expectedDestinationIdentity?: string;
  expectedSourceContent?: Buffer;
}

export function copyTruthFileVerified(source: string, destination: string, options: VerifiedTruthCopyOptions = {}): void {
  const probeAttributes = options.probeAttributes ?? reparseAttributes;
  let expectedContent = options.expectedSourceContent;
  let expectedSourceIdentity = options.expectedSourceIdentity;
  if (!expectedContent || !expectedSourceIdentity) {
    const sourceRead = readTruthFileVerifiedResult(source, {
      probeAttributes,
      expectedIdentity: expectedSourceIdentity,
    });
    if (!sourceRead) throw new TruthPathSafetyError(`记忆真相文件不存在：${source}`);
    expectedContent ??= sourceRead.content;
    expectedSourceIdentity ??= sourceRead.identity;
  }
  const [sourceImmediatelyBefore, destinationImmediatelyBefore] = inspectTruthFilesTwice([
    { path: source, options: { regularFile: true, expectedIdentity: expectedSourceIdentity } },
    { path: destination, options: { allowMissing: true, regularFile: true, expectedIdentity: options.expectedDestinationIdentity } },
  ], probeAttributes);
  if (!sourceImmediatelyBefore) throw new TruthPathSafetyError(`记忆真相文件不存在：${source}`);
  copyFileSync(source, destination);
  // The verified read's double-lstat precheck is the post-copy identity fence;
  // its independent post-read probe remains the content security boundary.
  const [copiedRead] = readTruthFilesVerified([{ path: destination }], probeAttributes);
  const copiedInfo = copiedRead ? { identity: copiedRead.identity, stats: copiedRead.stats } : undefined;
  if (destinationImmediatelyBefore && (!copiedInfo
    || copiedInfo.stats.dev !== destinationImmediatelyBefore.stats.dev
    || copiedInfo.stats.ino !== destinationImmediatelyBefore.stats.ino
    || copiedInfo.stats.mode !== destinationImmediatelyBefore.stats.mode
    || copiedInfo.stats.nlink !== destinationImmediatelyBefore.stats.nlink)) {
    throw new TruthPathSafetyError(`记忆真相文件复制后身份不一致：${destination}`);
  }
  if (!copiedRead || !copiedRead.content.equals(expectedContent)) throw new TruthPathSafetyError(`记忆真相文件复制内容不一致：${destination}`);
  assertTruthFileIdentity(source, sourceImmediatelyBefore.identity, probeAttributes, { regularFile: true });
}

export interface VerifiedTruthRenameOptions {
  probeAttributes?: TruthAttributeProbe;
  expectedSourceIdentity?: string;
}

export function renameTruthPathVerified(source: string, destination: string, options: VerifiedTruthRenameOptions = {}): void {
  const probeAttributes = options.probeAttributes ?? reparseAttributes;
  const [sourceBefore, destinationBefore] = inspectTruthFilesTwice([
    { path: source, options: { expectedIdentity: options.expectedSourceIdentity } },
    { path: destination, options: { allowMissing: true } },
  ], probeAttributes);
  if (!sourceBefore) throw new TruthPathSafetyError(`记忆真相路径不存在：${source}`);
  if (destinationBefore) throw new TruthPathSafetyError(`记忆真相重命名目标已存在：${destination}`);
  const [immediatelyBefore] = inspectTruthFilesTwice([{
    path: source,
    options: { expectedIdentity: sourceBefore.identity },
  }], probeAttributes);
  if (!immediatelyBefore) throw new TruthPathSafetyError(`记忆真相路径不存在：${source}`);
  renameSync(source, destination);
  const [sourceAfter, destinationAfter] = inspectTruthFiles([
    { path: source, options: { allowMissing: true } },
    { path: destination },
  ], probeAttributes);
  if (sourceAfter) throw new TruthPathSafetyError(`记忆真相路径重命名后仍然存在：${source}`);
  if (!destinationAfter || destinationAfter.stats.dev !== sourceBefore.stats.dev
    || destinationAfter.stats.ino !== sourceBefore.stats.ino
    || destinationAfter.stats.mode !== sourceBefore.stats.mode
    || destinationAfter.stats.nlink !== sourceBefore.stats.nlink
    || destinationAfter.stats.size !== sourceBefore.stats.size) {
    throw new TruthPathSafetyError(`记忆真相路径重命名后身份不一致：${destination}`);
  }
}

export interface VerifiedTruthRemoveOptions {
  probeAttributes?: TruthAttributeProbe;
  expectedIdentity?: string;
  recursive?: boolean;
  removePath?: (path: string, options?: { recursive?: boolean; force?: boolean }) => void;
}

export function removeTruthPathsVerified(
  paths: string[],
  options: Omit<VerifiedTruthRemoveOptions, 'expectedIdentity'> & { expectedIdentities?: string[] } = {},
): boolean[] {
  if (!paths.length) return [];
  const probeAttributes = options.probeAttributes ?? reparseAttributes;
  if (options.expectedIdentities && options.expectedIdentities.length !== paths.length) {
    throw new TruthPathSafetyError('记忆真相删除预期身份数量不一致');
  }
  const before = inspectTruthFilesTwice(paths.map((path, index) => ({
    path,
    options: { allowMissing: true, expectedIdentity: options.expectedIdentities?.[index] },
  })), probeAttributes);
  const immediatelyBefore = inspectTruthFilesTwice(paths.map((path, index) => ({
    path,
    options: { allowMissing: true, expectedIdentity: before[index]?.identity ?? options.expectedIdentities?.[index] },
  })), probeAttributes);
  for (let index = 0; index < paths.length; index += 1) {
    if (Boolean(before[index]) !== Boolean(immediatelyBefore[index])) {
      throw new TruthPathSafetyError(`记忆真相路径在删除前变化：${paths[index]}`);
    }
  }
  const existing = paths.flatMap((path, index) => immediatelyBefore[index] ? [{ path, index }] : []);
  for (const { path } of existing) {
    (options.removePath ?? rmSync)(path, { recursive: options.recursive ?? false, force: false });
  }
  const after = inspectTruthFiles(paths.map((path) => ({ path, options: { allowMissing: true } })), probeAttributes);
  for (let index = 0; index < paths.length; index += 1) {
    if (after[index]) throw new TruthPathSafetyError(`记忆真相路径删除后仍然存在：${paths[index]}`);
  }
  return before.map((info) => info !== undefined);
}

export function removeTruthPathVerified(path: string, options: VerifiedTruthRemoveOptions = {}): boolean {
  const probeAttributes = options.probeAttributes ?? reparseAttributes;
  const before = inspectTruthFileTwice(path, probeAttributes, {
    allowMissing: true,
    expectedIdentity: options.expectedIdentity,
  });
  if (!before) return false;
  const immediatelyBefore = inspectTruthFileTwice(path, probeAttributes, {
    allowMissing: true,
    expectedIdentity: before.identity,
  });
  if (!immediatelyBefore) return false;
  (options.removePath ?? rmSync)(path, { recursive: options.recursive ?? false, force: false });
  const after = inspectTruthFile(path, probeAttributes, { allowMissing: true });
  if (after) throw new TruthPathSafetyError(`记忆真相路径删除后仍然存在：${path}`);
  return true;
}

