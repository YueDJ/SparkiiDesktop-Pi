import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { loadSkillsFromDir } from '@sparkii/config';
import { isPathInside } from '@sparkii/agent-host';

export type UserSkillRow = {
  name: string;
  description: string;
  hasScripts: boolean;
  warnings: string[];
  kind?: 'skill' | 'pack';
  skillCount?: number;
};

export type PreviewUserSkillResult =
  | { ok: true; skill: UserSkillRow; destName: string }
  | { ok: false; reason: 'not-skill-root' | 'invalid-skill' | 'unavailable' | 'bad-name'; diagnostics?: string[] };

export type ImportUserSkillResult =
  | { ok: true; name: string }
  | { ok: false; reason: 'not-skill-root' | 'invalid-skill' | 'exists' | 'overlap' | 'unavailable' | 'bad-name'; name?: string; diagnostics?: string[] };

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

function destNameFromPackageName(packageName: string): string | undefined {
  const unscoped = packageName.includes('/')
    ? packageName.slice(packageName.lastIndexOf('/') + 1)
    : packageName.replace(/^@/, '');
  const cleaned = sanitizeFolderName(unscoped);
  return isDestName(cleaned) ? cleaned : undefined;
}

export function destNameForPack(
  sourceDir: string,
  packageName?: string,
): string | { reason: 'bad-name' } {
  const fromPackage = packageName ? destNameFromPackageName(packageName) : undefined;
  if (fromPackage) return fromPackage;
  const folder = sanitizeFolderName(basename(sourceDir));
  if (folder === 'skills') {
    const parent = sanitizeFolderName(basename(dirname(sourceDir)));
    if (isDestName(parent)) return parent;
  }
  if (isDestName(folder)) return folder;
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

async function hasScriptsAnywhere(dir: string, skillRoots?: string[]): Promise<boolean> {
  if (await hasScriptsDir(dir)) return true;
  const roots = skillRoots ?? (await skillRootChildren(dir));
  for (const root of roots) {
    if (await hasScriptsDir(root)) return true;
  }
  return false;
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

function insideSource(sourceDir: string, target: string): boolean {
  const root = resolve(sourceDir);
  const resolved = resolve(target);
  return resolved === root || isPathInside(root, resolved);
}

type PackManifest = {
  name?: string;
  description?: string;
  isPiPackage: boolean;
  skillPaths: string[];
};

async function readPackManifest(dir: string): Promise<PackManifest | null> {
  const file = join(dir, 'package.json');
  if (!(await isFile(file))) return null;
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object') return null;
    const keywords = Array.isArray(raw.keywords) ? raw.keywords : [];
    const pi = raw.pi && typeof raw.pi === 'object' ? raw.pi as Record<string, unknown> : {};
    const skillPaths = Array.isArray(pi.skills)
      ? pi.skills.filter((item): item is string => typeof item === 'string')
      : [];
    return {
      name: typeof raw.name === 'string' ? raw.name : undefined,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      isPiPackage: skillPaths.length > 0 || keywords.includes('pi-package'),
      skillPaths,
    };
  } catch {
    return null;
  }
}

async function isSkillRoot(dir: string): Promise<boolean> {
  return isFile(join(dir, 'SKILL.md'));
}

async function skillRootChildren(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if ((entry.isDirectory() || entry.isSymbolicLink()) && await isSkillRoot(full)) {
      roots.push(full);
    }
  }
  return roots;
}

async function collectPackSkillRoots(sourceDir: string, manifest: PackManifest | null): Promise<string[]> {
  const seen = new Set<string>();
  const roots: string[] = [];
  const add = (dir: string) => {
    const resolved = resolve(dir);
    if (seen.has(resolved)) return;
    if (!insideSource(sourceDir, resolved) || resolved === resolve(sourceDir)) return;
    seen.add(resolved);
    roots.push(resolved);
  };

  if (manifest?.skillPaths.length) {
    for (const rel of manifest.skillPaths) {
      const target = resolve(sourceDir, rel);
      if (!insideSource(sourceDir, target)) continue;
      if (await isSkillRoot(target)) add(target);
      else if (await isDir(target)) {
        for (const child of await skillRootChildren(target)) add(child);
      }
    }
  }
  if (roots.length === 0) {
    const conventional = join(sourceDir, 'skills');
    if (await isDir(conventional)) {
      for (const child of await skillRootChildren(conventional)) add(child);
    }
  }
  if (roots.length === 0 && basename(sourceDir) === 'skills') {
    for (const child of await skillRootChildren(sourceDir)) add(child);
  }
  return roots;
}

function copyFilter(from: string) {
  return (src: string) => {
    const rel = relative(from, src);
    if (rel === '') return true;
    return rel.split(/[\\/]/).every((part) => part !== 'node_modules' && !part.startsWith('.'));
  };
}

async function copySkillRoot(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true, filter: copyFilter(from) });
}

type PackCopy = { root: string; destName: string };

type InspectedSource = {
  destName: string;
  skill: UserSkillRow;
  kind: 'skill' | 'pack';
  copies: PackCopy[];
  packageJson?: string;
};

function failedDestName(diagnostics?: string[]): PreviewUserSkillResult {
  return diagnostics?.length
    ? { ok: false, reason: 'bad-name', diagnostics }
    : { ok: false, reason: 'bad-name' };
}

async function inspectSource(sourceDir: string): Promise<
  | { ok: true } & InspectedSource
  | PreviewUserSkillResult
> {
  if (!(await isDir(sourceDir))) {
    return { ok: false, reason: 'unavailable' };
  }

  if (await isSkillRoot(sourceDir)) {
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
    if (typeof dest !== 'string') return failedDestName();
    return {
      ok: true,
      destName: dest,
      kind: 'skill',
      copies: [{ root: sourceDir, destName: dest }],
      skill: {
        name: dest,
        description: loaded.skills[0]!.description,
        hasScripts: await hasScriptsDir(sourceDir),
        warnings: diagnostics,
        kind: 'skill',
        skillCount: 1,
      },
    };
  }

  const manifest = await readPackManifest(sourceDir);
  const hasPackMarker = Boolean(manifest?.isPiPackage)
    || await isDir(join(sourceDir, 'skills'))
    || basename(sourceDir) === 'skills';
  if (!hasPackMarker) {
    return { ok: false, reason: 'not-skill-root' };
  }

  const discovered = await collectPackSkillRoots(sourceDir, manifest);
  if (discovered.length === 0 && !manifest?.isPiPackage) {
    return { ok: false, reason: 'not-skill-root' };
  }

  const warnings: string[] = [];
  const copies: PackCopy[] = [];
  const used = new Set<string>();
  let firstDescription = '';
  for (const root of discovered) {
    let loaded;
    try {
      loaded = await loadSkillsFromDir(root);
    } catch {
      return { ok: false, reason: 'unavailable', diagnostics: [`无法读取子技能「${basename(root)}」`] };
    }
    warnings.push(...loaded.diagnostics.map((d) => d.message));
    if (loaded.skills.length === 0) continue;
    const childDest = destNameFor(loaded.skills[0]?.name, root);
    if (typeof childDest !== 'string') {
      return failedDestName([`无法为子技能「${basename(root)}」生成合法安装名`]);
    }
    if (used.has(childDest)) {
      return failedDestName([`子技能安装名冲突：${childDest}`]);
    }
    used.add(childDest);
    copies.push({ root, destName: childDest });
    if (!firstDescription) firstDescription = loaded.skills[0]!.description;
  }
  if (copies.length === 0) {
    return { ok: false, reason: 'invalid-skill', diagnostics: warnings };
  }
  const dest = destNameForPack(sourceDir, manifest?.name);
  if (typeof dest !== 'string') return failedDestName();
  const skillCount = copies.length;
  const description = manifest?.description?.trim()
    || (skillCount > 1 ? `${skillCount} 个技能` : firstDescription)
    || '';
  return {
    ok: true,
    destName: dest,
    kind: 'pack',
    copies,
    packageJson: await isFile(join(sourceDir, 'package.json')) ? join(sourceDir, 'package.json') : undefined,
    skill: {
      name: dest,
      description,
      hasScripts: await hasScriptsAnywhere(sourceDir, copies.map((copy) => copy.root)),
      warnings,
      kind: 'pack',
      skillCount,
    },
  };
}

export async function previewUserSkill(sourceDir: string): Promise<PreviewUserSkillResult> {
  const inspected = await inspectSource(sourceDir);
  if (!inspected.ok) return inspected;
  return { ok: true, skill: inspected.skill, destName: inspected.destName };
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
    const manifest = await readPackManifest(child);
    const isPack = !(await isSkillRoot(child)) && loaded.skills.length > 0;
    const description = isPack
      ? (manifest?.description?.trim() || (loaded.skills.length > 1 ? `${loaded.skills.length} 个技能` : loaded.skills[0]?.description ?? ''))
      : (loaded.skills[0]?.description ?? '');
    rows.push({
      name: entry.name,
      description,
      hasScripts: await hasScriptsAnywhere(child),
      warnings: loaded.diagnostics.map((d) => d.message),
      kind: isPack ? 'pack' : 'skill',
      skillCount: loaded.skills.length || undefined,
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
    if (inspected.kind === 'skill') {
      await copySkillRoot(sourceDir, dest);
    } else {
      await mkdir(dest, { recursive: true });
      if (inspected.packageJson) {
        await cp(inspected.packageJson, join(dest, 'package.json'));
      }
      for (const copy of inspected.copies) {
        await copySkillRoot(copy.root, join(dest, copy.destName));
      }
    }
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
  if (!existsSync(dest)) return { ok: false, reason: 'not-found' };
  await rm(dest, { recursive: true, force: true });
  return { ok: true };
}
