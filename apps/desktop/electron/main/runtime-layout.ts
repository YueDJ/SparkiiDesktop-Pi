import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const APP_DIR_NAME = 'SparkiiDesktop';
export const RUNTIME_DIR_NAME = 'runtime';
export const PORTABLE_GIT_DIR_NAME = 'portable-git';

export interface RuntimePaths {
  root: string;
  portableGitDir: string;
  bashPath: string;
  gitCmdDir: string;
  gitPath: string;
}

function fallbackBase(env: NodeJS.ProcessEnv): string {
  return env.TEMP ?? env.TMP ?? process.cwd();
}

export function resolveRuntimeRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SPARKII_RUNTIME_ROOT) return env.SPARKII_RUNTIME_ROOT;
  const local = env.LOCALAPPDATA ?? fallbackBase(env);
  return join(local, APP_DIR_NAME, RUNTIME_DIR_NAME);
}

export function resolveRuntimePaths(env: NodeJS.ProcessEnv = process.env): RuntimePaths {
  const root = resolveRuntimeRoot(env);
  const portableGitDir = join(root, PORTABLE_GIT_DIR_NAME);
  return {
    root,
    portableGitDir,
    bashPath: join(portableGitDir, 'bin', 'bash.exe'),
    gitCmdDir: join(portableGitDir, 'cmd'),
    gitPath: join(portableGitDir, 'cmd', 'git.exe'),
  };
}

export function needsProvision(env: NodeJS.ProcessEnv = process.env): boolean {
  const paths = resolveRuntimePaths(env);
  return !(existsSync(paths.bashPath) && existsSync(paths.gitPath));
}
