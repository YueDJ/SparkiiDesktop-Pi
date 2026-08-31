import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureRuntime, verifyRuntime } from '../electron/main/runtime-provision.js';

const childProcessMock = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', () => ({
  default: { spawn: childProcessMock.spawn },
  spawn: childProcessMock.spawn,
}));

function provision(root: string): void {
  const portableGit = join(root, 'portable-git');
  mkdirSync(join(portableGit, 'bin'), { recursive: true });
  mkdirSync(join(portableGit, 'cmd'), { recursive: true });
  writeFileSync(join(portableGit, 'bin', 'bash.exe'), 'x');
  writeFileSync(join(portableGit, 'cmd', 'git.exe'), 'x');
}

function stubSpawnExit(code: number): void {
  childProcessMock.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    setImmediate(() => child.emit('close', code));
    return child;
  });
}

describe('ensureRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts the archive when the runtime is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sparkii-rt-'));
    const archive = join(root, 'PortableGit.7z.exe');
    writeFileSync(archive, 'sfx');
    stubSpawnExit(0);

    await ensureRuntime({ archivePath: archive, env: { SPARKII_RUNTIME_ROOT: root } });

    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      archive,
      [`-o${join(root, 'portable-git')}`, '-y'],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it('skips extraction when the runtime is already provisioned', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sparkii-rt-'));
    provision(root);

    await ensureRuntime({ archivePath: join(root, 'PortableGit.7z.exe'), env: { SPARKII_RUNTIME_ROOT: root } });

    expect(childProcessMock.spawn).not.toHaveBeenCalled();
  });
});

describe('verifyRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports not ready when the runtime is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sparkii-rt-'));
    const result = await verifyRuntime({ SPARKII_RUNTIME_ROOT: root });
    expect(result.ready).toBe(false);
    expect(result.error).toBe('runtime not provisioned');
  });

  it('probes bash and git versions through the bundled bash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sparkii-rt-'));
    provision(root);
    childProcessMock.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('git version 2.47.1.windows.2'));
        child.emit('close', 0);
      });
      return child;
    });

    const result = await verifyRuntime({ SPARKII_RUNTIME_ROOT: root });

    expect(result.ready).toBe(true);
    expect(result.bashVersion).toBe('git version 2.47.1.windows.2');
    expect(result.gitVersion).toBe('git version 2.47.1.windows.2');
  });
});
