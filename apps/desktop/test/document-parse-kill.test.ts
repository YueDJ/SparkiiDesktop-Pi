import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { killProcessTree } from '../electron/main/document-parse-kill.js';

describe('killProcessTree', () => {
  it('is a no-op when the child has no pid', async () => {
    const spawn = vi.fn();
    const kill = vi.fn();
    await killProcessTree({ kill }, { platform: 'win32', spawn: spawn as never });
    expect(spawn).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it('uses taskkill /T /F on win32 and waits for that process to exit', async () => {
    const taskkill = new EventEmitter();
    const spawn = vi.fn(() => taskkill);
    let settled = false;
    const pending = killProcessTree(
      { pid: 4321 },
      { platform: 'win32', spawn: spawn as never },
    ).then(() => {
      settled = true;
    });

    expect(spawn).toHaveBeenCalledWith('taskkill', ['/pid', '4321', '/T', '/F']);
    await Promise.resolve();
    expect(settled).toBe(false);

    taskkill.emit('exit', 0);
    await pending;
    expect(settled).toBe(true);
  });

  it('does not call child.kill on win32', async () => {
    const taskkill = new EventEmitter();
    queueMicrotask(() => taskkill.emit('exit', 1));
    const spawn = vi.fn(() => taskkill);
    const kill = vi.fn();
    await killProcessTree({ pid: 9, kill }, { platform: 'win32', spawn: spawn as never });
    expect(kill).not.toHaveBeenCalled();
  });

  it('sends a signal to the process group on posix', async () => {
    const killProcess = vi.fn();
    const kill = vi.fn();
    await killProcessTree(
      { pid: 77, kill },
      { platform: 'linux', killProcess: killProcess as never },
    );
    expect(killProcess).toHaveBeenCalledWith(-77);
    expect(kill).not.toHaveBeenCalled();
  });

  it('falls back to child.kill SIGKILL when group kill fails', async () => {
    const killProcess = vi.fn(() => {
      throw new Error('ESRCH');
    });
    const kill = vi.fn();
    await killProcessTree(
      { pid: 88, kill },
      { platform: 'darwin', killProcess: killProcess as never },
    );
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });
});
