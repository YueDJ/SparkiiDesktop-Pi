import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

export type KillableChild = {
  pid?: number;
  kill?: (sig?: NodeJS.Signals) => boolean;
};

export type KillProcessTreeOpts = {
  platform?: NodeJS.Platform;
  spawn?: typeof nodeSpawn;
  killProcess?: typeof process.kill;
};

function waitForChildExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      child.off('exit', done);
      child.off('close', done);
      child.off('error', done);
      resolve();
    };
    child.once('exit', done);
    child.once('close', done);
    child.once('error', done);
  });
}

export async function killProcessTree(
  child: KillableChild,
  opts?: KillProcessTreeOpts,
): Promise<void> {
  const pid = child.pid;
  if (pid == null) return;

  const platform = opts?.platform ?? process.platform;
  const doSpawn = opts?.spawn ?? nodeSpawn;
  const killProcess = opts?.killProcess ?? process.kill;

  if (platform === 'win32') {
    const taskkill = doSpawn('taskkill', ['/pid', String(pid), '/T', '/F']);
    await waitForChildExit(taskkill);
    return;
  }

  try {
    killProcess(-pid);
  } catch {
    child.kill?.('SIGKILL');
  }
}
