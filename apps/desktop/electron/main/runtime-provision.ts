import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  needsProvision,
  needsSearchTools,
  resolveRuntimeToolsDir,
  resolveRuntimePaths,
  resolveSearchToolPaths,
  SEARCH_TOOL_FILENAMES,
} from './runtime-layout.js';

export interface EnsureRuntimeOptions {
  archivePath?: string | null;
  env?: NodeJS.ProcessEnv;
  toolsDir?: string | null;
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

export function runtimeToolsPath(
  env: NodeJS.ProcessEnv = process.env,
  resourcesPath?: string,
): string | null {
  const candidates = [
    env.SPARKII_RUNTIME_TOOLS_DIR,
    resourcesPath ? join(resourcesPath, 'runtime', 'tools') : undefined,
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

export async function ensureRuntime(opts: EnsureRuntimeOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  if (needsProvision(env)) {
    const archivePath = opts.archivePath ?? runtimeArchivePath(env);
    if (archivePath && existsSync(archivePath)) {
      await extract(archivePath, resolveRuntimePaths(env).portableGitDir);
    }
  }
  ensureSearchTools(env, opts.toolsDir);
}

function ensureSearchTools(
  env: NodeJS.ProcessEnv,
  toolsDir: string | null | undefined,
): void {
  if (!needsSearchTools(env)) return;
  if (!toolsDir || !existsSync(toolsDir)) return;
  const runtimeToolsDir = resolveRuntimeToolsDir(env);
  const missing = SEARCH_TOOL_FILENAMES.filter((filename) => !existsSync(join(toolsDir, filename)));
  if (missing.length > 0) {
    throw new Error(`search tools missing from ${toolsDir}: ${missing.join(', ')}`);
  }
  mkdirSync(runtimeToolsDir, { recursive: true });
  for (const filename of SEARCH_TOOL_FILENAMES) {
    copyFileSync(join(toolsDir, filename), join(runtimeToolsDir, filename));
  }
}

export interface RuntimeVerification {
  root: string;
  bashPath: string;
  gitPath: string;
  fdPath: string;
  rgPath: string;
  ready: boolean;
  bashVersion: string | null;
  gitVersion: string | null;
  fdReady: boolean;
  rgReady: boolean;
  fdVersion: string | null;
  rgVersion: string | null;
  error: string | null;
}

export async function verifyRuntime(env: NodeJS.ProcessEnv = process.env): Promise<RuntimeVerification> {
  const paths = resolveRuntimePaths(env);
  const searchPaths = resolveSearchToolPaths(env);
  const fdReady = existsSync(searchPaths.fdPath);
  const rgReady = existsSync(searchPaths.rgPath);
  const ready = existsSync(paths.bashPath) && existsSync(paths.gitPath);
  if (!ready) {
    return {
      root: paths.root,
      bashPath: paths.bashPath,
      gitPath: paths.gitPath,
      fdPath: searchPaths.fdPath,
      rgPath: searchPaths.rgPath,
      ready: false,
      bashVersion: null,
      gitVersion: null,
      fdReady,
      rgReady,
      fdVersion: null,
      rgVersion: null,
      error: 'runtime not provisioned',
    };
  }
  const [bashVersion, gitVersion, fdVersion, rgVersion] = await Promise.all([
    capture(paths.bashPath, ['--version']),
    capture(paths.bashPath, ['-c', 'git --version']),
    fdReady ? capture(searchPaths.fdPath, ['--version']) : Promise.resolve(null),
    rgReady ? capture(searchPaths.rgPath, ['--version']) : Promise.resolve(null),
  ]);
  return {
    root: paths.root,
    bashPath: paths.bashPath,
    gitPath: paths.gitPath,
    fdPath: searchPaths.fdPath,
    rgPath: searchPaths.rgPath,
    ready: true,
    bashVersion,
    gitVersion,
    fdReady,
    rgReady,
    fdVersion,
    rgVersion,
    error: null,
  };
}

function capture(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let output = '';
    child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(output.trim() || null));
  });
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
