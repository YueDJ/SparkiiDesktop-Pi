import { afterAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertTruthPathSafe } from '../electron/main/memory/truth-path.js';

const helper = join(
  import.meta.dirname,
  '..',
  'native',
  'windows-sandbox',
  'bin',
  'SandboxProbe.exe',
);

const root = mkdtempSync(join(tmpdir(), 'sparkii-probe-daemon-'));
const regularFile = join(root, 'regular.txt');
const missingFile = join(root, 'missing.txt');
writeFileSync(regularFile, 'probe');

const children: ChildProcessWithoutNullStreams[] = [];

afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  rmSync(root, { recursive: true, force: true });
});

function countProbeProcesses(): number {
  const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq SandboxProbe.exe', '/NH'], { encoding: 'utf8' });
  const output = typeof result.stdout === 'string' ? result.stdout : '';
  return output.split(/\r?\n/).filter((line) => line.includes('SandboxProbe.exe')).length;
}

function encodeRequest(paths: string[]): Buffer {
  const encoded = paths.map((path) => Buffer.from(path, 'utf8'));
  const request = Buffer.allocUnsafe(4 + encoded.reduce((total, path) => total + 4 + path.length, 0));
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

function createBinaryReader(stream: NodeJS.ReadableStream) {
  let buffered = Buffer.alloc(0);
  let closed = false;
  stream.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
  });
  stream.on('close', () => { closed = true; });
  return async function readExact(length: number): Promise<Buffer> {
    while (buffered.length < length) {
      if (closed) throw new Error('probe daemon closed before the response completed');
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const result = buffered.subarray(0, length);
    buffered = buffered.subarray(length);
    return result;
  };
}

describe.runIf(process.platform === 'win32')('resident truth path probe daemon', () => {
  it('serves multiple batches from one process and reports missing paths as invalid', async () => {
    const child = spawn(helper, ['reparse-daemon'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    const readExact = createBinaryReader(child.stdout);

    child.stdin.write(encodeRequest([root, regularFile]));
    let countHeader = await readExact(4);
    expect(countHeader.readUInt32LE(0)).toBe(2);
    expect([...await readExact(2)]).toEqual([0, 0]);

    child.stdin.write(encodeRequest([missingFile]));
    countHeader = await readExact(4);
    expect(countHeader.readUInt32LE(0)).toBe(1);
    expect([...await readExact(1)]).toEqual([2]);

    child.stdin.end();
    const [code] = await once(child, 'exit');
    expect(code).toBe(0);
  });

  it('rejects an oversized request count and exits', async () => {
    const child = spawn(helper, ['reparse-daemon'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    const request = Buffer.alloc(4);
    request.writeUInt32LE(1_000_001, 0);
    child.stdin.write(request);
    const [code] = await once(child, 'exit');
    expect(code).toBe(64);
  });

  it('still uses the one-shot native probe when the resident bridge is disabled', async () => {
    process.env.SPARKII_TRUTH_PROBE_DAEMON_DISABLED = '1';
    try {
      expect(() => assertTruthPathSafe(regularFile)).not.toThrow();
    } finally {
      delete process.env.SPARKII_TRUTH_PROBE_DAEMON_DISABLED;
    }
  });

  it('serves production probes from one resident child instead of stalling on a dead bridge', () => {
    // 先强制一次性回退，回收任何既有 bridge，使基线进程数确定。
    process.env.SPARKII_TRUTH_PROBE_DAEMON_DISABLED = '1';
    try { assertTruthPathSafe(regularFile); } finally {
      delete process.env.SPARKII_TRUTH_PROBE_DAEMON_DISABLED;
    }
    const junction = join(root, 'resident-junction');
    let junctionCreated = false;
    try {
      symlinkSync(root, junction, 'junction');
      junctionCreated = true;
    } catch {
      junctionCreated = false;
    }
    const before = countProbeProcesses();
    const started = Date.now();
    try {
      for (let index = 0; index < 5; index += 1) assertTruthPathSafe(regularFile);
      const elapsed = Date.now() - started;
      // bridge 失效时每次探测都要等满 5s 主线程阻塞超时再回退；一次性回退本身只需几十毫秒。
      expect(elapsed).toBeLessThan(2_000);
      expect(countProbeProcesses()).toBeGreaterThan(before);
      if (junctionCreated) expect(() => assertTruthPathSafe(junction)).toThrow();
    } finally {
      process.env.SPARKII_TRUTH_PROBE_DAEMON_DISABLED = '1';
      try { assertTruthPathSafe(regularFile); } finally {
        delete process.env.SPARKII_TRUTH_PROBE_DAEMON_DISABLED;
      }
      if (junctionCreated) rmSync(junction, { force: true });
    }
  });
});