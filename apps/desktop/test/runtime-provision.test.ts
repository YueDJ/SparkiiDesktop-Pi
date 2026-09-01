import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

  it('copies search tools from toolsDir when they are missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sparkii-rt-'));
    const sourceToolsDir = join(root, 'source-tools');
    mkdirSync(sourceToolsDir, { recursive: true });
    writeFileSync(join(sourceToolsDir, 'fd.exe'), 'fd');
    writeFileSync(join(sourceToolsDir, 'rg.exe'), 'rg');

    await ensureRuntime({
      env: { SPARKII_RUNTIME_ROOT: root },
      toolsDir: sourceToolsDir,
    });

    expect(existsSync(join(root, 'tools', 'fd.exe'))).toBe(true);
    expect(existsSync(join(root, 'tools', 'rg.exe'))).toBe(true);
  });

  it('throws when toolsDir is present but missing a search tool', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sparkii-rt-'));
    const sourceToolsDir = join(root, 'source-tools');
    mkdirSync(sourceToolsDir, { recursive: true });
    writeFileSync(join(sourceToolsDir, 'fd.exe'), 'fd');

    await expect(ensureRuntime({
      env: { SPARKII_RUNTIME_ROOT: root },
      toolsDir: sourceToolsDir,
    })).rejects.toThrow('search tools missing');
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

  it('probes fd and rg versions when search tools exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sparkii-rt-'));
    const toolsDir = join(root, 'tools');
    mkdirSync(toolsDir, { recursive: true });
    writeFileSync(join(toolsDir, 'fd.exe'), 'fd');
    writeFileSync(join(toolsDir, 'rg.exe'), 'rg');
    provision(root);
    childProcessMock.spawn.mockImplementation((command: string) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(command.includes('fd.exe') ? 'fd 10.5.0' : 'rg 15.2.0'));
        child.emit('close', 0);
      });
      return child;
    });

    const result = await verifyRuntime({ SPARKII_RUNTIME_ROOT: root });

    expect(result.ready).toBe(true);
    expect(result.fdReady).toBe(true);
    expect(result.rgReady).toBe(true);
    expect(result.fdVersion).toBe('fd 10.5.0');
    expect(result.rgVersion).toBe('rg 15.2.0');
  });
});
