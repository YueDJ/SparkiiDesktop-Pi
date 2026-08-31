import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { needsProvision, resolveRuntimePaths } from './runtime-layout.js';

export interface EnsureRuntimeOptions {
  archivePath?: string | null;
  env?: NodeJS.ProcessEnv;
}

export function runtimeArchivePath(
  env: NodeJS.ProcessEnv = process.env,
  resourcesPath?: string,
): string | null {
  const candidates = [
    env.SPARKII_RUNTIME_ARCHIVE,
    resourcesPath ? join(resourcesPath, 'runtime', 'portable-git.7z.exe') : undefined,
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

export async function ensureRuntime(opts: EnsureRuntimeOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  if (!needsProvision(env)) return;
  const archivePath = opts.archivePath ?? runtimeArchivePath(env);
  if (!archivePath || !existsSync(archivePath)) return;
  const paths = resolveRuntimePaths(env);
  await extract(archivePath, paths.portableGitDir);
}

function extract(archivePath: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(archivePath, [`-o${dest}`, '-y'], { windowsHide: true });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Portable Git extraction failed with exit code ${code}`));
    });
  });
}
