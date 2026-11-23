import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isTrustAnchorPath } from "@sparkii/approval";

export function isPathInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && rel !== ".");
}

export type GuardedReadPath =
  | { ok: true; canonicalPath: string }
  | {
      ok: false;
      code: 'WORKSPACE_NOT_CREATED' | 'OUTSIDE_WORKSPACE' | 'TRUST_ANCHOR' | 'HARDLINK' | 'PLATFORM_RESERVED';
      message: string;
    };

/**
 * 平台保留目录：`.sparkii/` 是记忆模块的工作区侧真相源，agent 工具一律读写拒绝。
 * 按路径段判断，避免把 `foo.sparkii.md` 之类的普通文件误伤。
 */
export function isPlatformReservedPath(target: string): boolean {
  const segments = resolve(target).replace(/\\/g, '/').split('/');
  return segments.some((segment) => segment.toLowerCase() === '.sparkii');
}

async function canonicalOrMissing(target: string): Promise<{
  canonicalPath: string;
  exists: boolean;
}> {
  try {
    return { canonicalPath: await realpath(target), exists: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    const parent = dirname(target);
    if (parent === target) return { canonicalPath: target, exists: false };
    const nearest = await canonicalOrMissing(parent);
    return {
      canonicalPath: resolve(nearest.canonicalPath, basename(target)),
      exists: false,
    };
  }
}

/**
 * Local defense-in-depth for Pi-native read tools. Main still authorizes the
 * same target first in production; this guard prevents symlink escapes, trust
 * anchor disclosure and hard-link alias reads if that wrapper is bypassed.
 */
export async function resolveGuardedReadPath(
  root: string,
  target: string,
  skillsDir?: string,
): Promise<GuardedReadPath> {
  let canonicalRoot: string | undefined;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    canonicalRoot = undefined;
  }
  const candidate = await canonicalOrMissing(resolve(target));
  if (isPlatformReservedPath(candidate.canonicalPath)) {
    return { ok: false, code: 'PLATFORM_RESERVED', message: '.sparkii 是平台保留目录' };
  }
  let canonicalSkills: string | undefined;
  if (skillsDir) {
    try { canonicalSkills = await realpath(skillsDir); } catch { canonicalSkills = undefined; }
  }
  if (!canonicalRoot && !canonicalSkills) {
    return {
      ok: false,
      code: 'WORKSPACE_NOT_CREATED',
      message: 'workspace not created',
    };
  }
  const allowed = Boolean(canonicalRoot && isPathInside(canonicalRoot, candidate.canonicalPath))
    || Boolean(canonicalSkills && isPathInside(canonicalSkills, candidate.canonicalPath));
  if (!allowed) {
    return { ok: false, code: 'OUTSIDE_WORKSPACE', message: 'outside workspace' };
  }
  if (isTrustAnchorPath(candidate.canonicalPath)) {
    return { ok: false, code: 'TRUST_ANCHOR', message: 'trust anchor is protected' };
  }
  if (candidate.exists) {
    const info = await lstat(candidate.canonicalPath, { bigint: true });
    if (!info.isDirectory() && info.nlink > 1n) {
      return { ok: false, code: 'HARDLINK', message: 'hard-linked file is protected' };
    }
  }
  return { ok: true, canonicalPath: candidate.canonicalPath };
}
