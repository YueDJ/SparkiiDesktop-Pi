import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface SkillPackage {
  name: string;
  description: string;
  raw: string;
  content: string;
  relPath: string;
  relBaseDir: string;
  disableModelInvocation?: boolean;
  metadata?: Record<string, unknown>;
}

export type SkillDiagnostic =
  | { type: 'warning'; message: string; path: string }
  | { type: 'collision'; message: string; path: string };

export interface LoadSkillsResult {
  skills: SkillPackage[];
  diagnostics: SkillDiagnostic[];
}

export function parseSkillFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { frontmatter: {}, body: raw };
  const parsed = parseYaml(match[1]);
  const frontmatter = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  return { frontmatter, body: raw.slice(match[0].length) };
}

function validateName(name: string): string[] {
  const errors: string[] = [];
  if (name.length > 64) errors.push(`name exceeds 64 characters (${name.length})`);
  if (!/^[a-z0-9-]+$/.test(name)) errors.push('name must be lowercase a-z, 0-9, hyphens only');
  if (name.startsWith('-') || name.endsWith('-')) errors.push('name must not start or end with a hyphen');
  if (name.includes('--')) errors.push('name must not contain consecutive hyphens');
  return errors;
}

interface LoadState {
  skills: SkillPackage[];
  diagnostics: SkillDiagnostic[];
  seen: Map<string, string>;
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function loadSkillFile(filePath: string, root: string, state: LoadState): Promise<void> {
  const raw = await readFile(filePath, 'utf8');
  const { frontmatter, body } = parseSkillFrontmatter(raw);
  const relPath = relative(root, filePath).split(sep).join('/');
  const relBaseDir = relative(root, dirname(filePath)).split(sep).join('/');
  const fallbackName = basename(filePath) === 'SKILL.md' ? basename(dirname(filePath)) : basename(filePath, '.md');
  const name = typeof frontmatter.name === 'string' && frontmatter.name ? frontmatter.name : fallbackName;
  const description = typeof frontmatter.description === 'string' ? frontmatter.description : '';
  for (const message of validateName(name)) {
    state.diagnostics.push({ type: 'warning', message, path: relPath });
  }
  if (!description.trim()) {
    state.diagnostics.push({ type: 'warning', message: 'description is required', path: relPath });
    return;
  }
  if (description.length > 1024) {
    state.diagnostics.push({ type: 'warning', message: `description exceeds 1024 characters (${description.length})`, path: relPath });
  }
  if (state.seen.has(name)) {
    state.diagnostics.push({ type: 'collision', message: `name "${name}" collision`, path: relPath });
    return;
  }
  state.seen.set(name, relPath);
  state.skills.push({
    name,
    description,
    raw,
    content: body,
    relPath,
    relBaseDir,
    disableModelInvocation: frontmatter['disable-model-invocation'] === true,
    metadata: typeof frontmatter.metadata === 'object' && frontmatter.metadata !== null
      ? (frontmatter.metadata as Record<string, unknown>)
      : undefined,
  });
}

async function loadDir(dir: string, root: string, includeRootFiles: boolean, state: LoadState): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  if (entries.some((e) => e.name === 'SKILL.md')) {
    await loadSkillFile(join(dir, 'SKILL.md'), root, state);
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory() || (entry.isSymbolicLink() && await isDirectory(full))) {
      await loadDir(full, root, false, state);
      continue;
    }
    if (!includeRootFiles || !entry.name.endsWith('.md')) continue;
    await loadSkillFile(full, root, state);
  }
}

export async function loadSkillsFromDir(dir: string): Promise<LoadSkillsResult> {
  const state: LoadState = { skills: [], diagnostics: [], seen: new Map() };
  if (await isDirectory(dir)) await loadDir(dir, dir, true, state);
  return { skills: state.skills, diagnostics: state.diagnostics };
}

export async function collectSkillDirFiles(root: string): Promise<Record<string, Buffer>> {
  const out: Record<string, Buffer> = {};
  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      const rel = relative(root, full).split(sep).join('/');
      out[rel] = await readFile(full);
    }
  }
  await walk(root);
  return out;
}
