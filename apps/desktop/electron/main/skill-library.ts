import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { loadSkillsFromDir } from '@sparkii/config';
import { isPathInside } from '@sparkii/agent-host';

export type UserSkillRow = {
  name: string;
  description: string;
  hasScripts: boolean;
  warnings: string[];
};

export type PreviewUserSkillResult =
  | { ok: true; skill: UserSkillRow }
  | { ok: false; reason: 'not-skill-root' | 'invalid-skill' | 'unavailable' | 'bad-name'; diagnostics?: string[] };

export type ImportUserSkillResult =
  | { ok: true; name: string }
  | { ok: false; reason: 'not-skill-root' | 'invalid-skill' | 'exists' | 'overlap' | 'unavailable' | 'bad-name'; name?: string };

export type UninstallUserSkillResult =
  | { ok: true }
  | { ok: false; reason: 'not-found' | 'bad-name' };

const DEST_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isDestName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && DEST_NAME_RE.test(name);
}

function sanitizeFolderName(folder: string): string {
  return folder
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function destNameFor(
  frontmatterName: string | undefined,
  sourceDir: string,
): string | { reason: 'bad-name' } {
  if (frontmatterName && isDestName(frontmatterName)) return frontmatterName;
  const cleaned = sanitizeFolderName(basename(sourceDir));
  if (isDestName(cleaned)) return cleaned;
  return { reason: 'bad-name' };
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function hasScriptsDir(dir: string): Promise<boolean> {
  return isDir(join(dir, 'scripts'));
}

function destInsideLibrary(skillsDir: string, dest: string): boolean {
  const root = resolve(skillsDir);
  const target = resolve(dest);
  return isPathInside(root, target) && relative(root, target) !== '';
}

function pathsOverlap(sourceDir: string, dest: string): boolean {
  const source = resolve(sourceDir);
  const target = resolve(dest);
  return source === target || isPathInside(source, target) || isPathInside(target, source);
}

async function inspectSource(sourceDir: string): Promise<
  | { ok: true; destName: string; skill: UserSkillRow }
  | PreviewUserSkillResult
> {
  if (!(await isDir(sourceDir))) {
    return { ok: false, reason: 'unavailable' };
  }
  if (!(await isFile(join(sourceDir, 'SKILL.md')))) {
    return { ok: false, reason: 'not-skill-root' };
  }
  let loaded;
  try {
    loaded = await loadSkillsFromDir(sourceDir);
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  const diagnostics = loaded.diagnostics.map((d) => d.message);
  if (loaded.skills.length === 0) {
    return { ok: false, reason: 'invalid-skill', diagnostics };
  }
  const dest = destNameFor(loaded.skills[0]?.name, sourceDir);
  if (typeof dest !== 'string') return dest;
  return {
    ok: true,
    destName: dest,
    skill: {
      name: dest,
      description: loaded.skills[0]!.description,
      hasScripts: await hasScriptsDir(sourceDir),
      warnings: diagnostics,
    },
  };
}

export async function previewUserSkill(sourceDir: string): Promise<PreviewUserSkillResult> {
  const inspected = await inspectSource(sourceDir);
  if (!inspected.ok) return inspected;
  return { ok: true, skill: inspected.skill };
}

export async function listUserSkills(skillsDir: string): Promise<UserSkillRow[]> {
  if (!(await isDir(skillsDir))) return [];
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows: UserSkillRow[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const child = join(skillsDir, entry.name);
    if (!(entry.isDirectory() || (entry.isSymbolicLink() && await isDir(child)))) continue;
    if (!(await isDir(child))) continue;
    const loaded = await loadSkillsFromDir(child);
    rows.push({
      name: entry.name,
      description: loaded.skills[0]?.description ?? '',
      hasScripts: await hasScriptsDir(child),
      warnings: loaded.diagnostics.map((d) => d.message),
    });
  }
  return rows;
}

export async function importUserSkill(
  skillsDir: string,
  sourceDir: string,
  opts?: { overwrite?: boolean },
): Promise<ImportUserSkillResult> {
  const inspected = await inspectSource(sourceDir);
  if (!inspected.ok) return inspected;
  const destName = inspected.destName;
  const dest = join(skillsDir, destName);
  if (!destInsideLibrary(skillsDir, dest)) {
    return { ok: false, reason: 'bad-name' };
  }
  if (pathsOverlap(sourceDir, dest)) {
    return { ok: false, reason: 'overlap' };
  }
  if (existsSync(dest) && !opts?.overwrite) {
    return { ok: false, reason: 'exists', name: destName };
  }
  try {
    await mkdir(skillsDir, { recursive: true });
    if (opts?.overwrite && existsSync(dest)) {
      await rm(dest, { recursive: true, force: true });
    }
    await cp(sourceDir, dest, { recursive: true });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  return { ok: true, name: destName };
}

export async function uninstallUserSkill(
  skillsDir: string,
  name: string,
): Promise<UninstallUserSkillResult> {
  if (!isDestName(name)) return { ok: false, reason: 'bad-name' };
  const dest = resolve(skillsDir, name);
  if (!destInsideLibrary(skillsDir, dest)) return { ok: false, reason: 'bad-name' };
  if (!(await isDir(dest)) && !existsSync(dest)) return { ok: false, reason: 'not-found' };
  if (!existsSync(dest)) return { ok: false, reason: 'not-found' };
  await rm(dest, { recursive: true, force: true });
  return { ok: true };
}
