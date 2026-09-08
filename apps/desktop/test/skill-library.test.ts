import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  destNameFor,
  importUserSkill,
  listUserSkills,
  previewUserSkill,
  uninstallUserSkill,
} from '../electron/main/skill-library.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeSkill(dir: string, frontmatter: string, extra?: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), frontmatter, 'utf8');
  for (const [rel, content] of Object.entries(extra ?? {})) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
}

describe('destNameFor', () => {
  it('uses a valid frontmatter name', () => {
    expect(destNameFor('summarize', '/tmp/Anything')).toBe('summarize');
  });

  it('sanitizes the folder name when frontmatter name is illegal', () => {
    expect(destNameFor('My Skill', '/tmp/My Skill')).toBe('my-skill');
  });

  it('returns bad-name when nothing legal remains', () => {
    expect(destNameFor('!!!', '/tmp/!!!')).toEqual({ reason: 'bad-name' });
  });
});

describe('preview / import / list / uninstall', () => {
  it('previews and imports a valid skill root, listing destName and references', async () => {
    const source = join(tmp('skill-src-'), 'summarize');
    writeSkill(
      source,
      '---\nname: summarize\ndescription: Summarize a document.\n---\n# summarize\n',
      { 'references/notes.md': 'notes' },
    );
    const preview = await previewUserSkill(source);
    expect(preview).toMatchObject({
      ok: true,
      skill: { name: 'summarize', description: 'Summarize a document.', hasScripts: false },
    });
    if (preview.ok) expect(preview.skill.name).toBe('summarize');

    const skillsDir = join(tmp('skill-lib-'), 'skills');
    const imported = await importUserSkill(skillsDir, source);
    expect(imported).toEqual({ ok: true, name: 'summarize' });
    const listed = await listUserSkills(skillsDir);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe('summarize');
    expect(listed[0]?.description).toBe('Summarize a document.');
    expect(readFileSync(join(skillsDir, 'summarize', 'references', 'notes.md'), 'utf8')).toBe('notes');
  });

  it('installs an illegal frontmatter name under the sanitized destName', async () => {
    const source = join(tmp('skill-src-'), 'My Skill');
    writeSkill(source, '---\nname: My Skill\ndescription: Works anyway.\n---\n# body\n');
    const preview = await previewUserSkill(source);
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.skill.name).toBe('my-skill');
      expect(preview.skill.warnings.length).toBeGreaterThan(0);
    }
    const skillsDir = join(tmp('skill-lib-'), 'skills');
    const imported = await importUserSkill(skillsDir, source);
    expect(imported).toEqual({ ok: true, name: 'my-skill' });
    const listed = await listUserSkills(skillsDir);
    expect(listed.map((s) => s.name)).toEqual(['my-skill']);
    const removed = await uninstallUserSkill(skillsDir, 'my-skill');
    expect(removed).toEqual({ ok: true });
    expect(await listUserSkills(skillsDir)).toEqual([]);
    expect(existsSync(skillsDir)).toBe(true);
  });

  it('rejects a repo that only has SKILL.md in a child folder', async () => {
    const source = tmp('skill-repo-');
    writeSkill(join(source, 'nested'), '---\nname: nested\ndescription: Hidden.\n---\n# nested\n');
    const skillsDir = join(tmp('skill-lib-'), 'skills');
    expect(await previewUserSkill(source)).toEqual({ ok: false, reason: 'not-skill-root' });
    expect(await importUserSkill(skillsDir, source)).toEqual({ ok: false, reason: 'not-skill-root' });
    expect(existsSync(skillsDir)).toBe(false);
  });

  it('rejects a skill without description', async () => {
    const source = join(tmp('skill-src-'), 'empty');
    writeSkill(source, '---\nname: empty\n---\n# no desc\n');
    const skillsDir = join(tmp('skill-lib-'), 'skills');
    const preview = await previewUserSkill(source);
    expect(preview.ok).toBe(false);
    if (!preview.ok) {
      expect(preview.reason).toBe('invalid-skill');
      expect(preview.diagnostics?.some((d) => d.includes('description'))).toBe(true);
    }
    expect(await importUserSkill(skillsDir, source)).toMatchObject({ ok: false, reason: 'invalid-skill' });
  });

  it('refuses a second import without overwrite and replaces when overwrite is set', async () => {
    const source = join(tmp('skill-src-'), 'summarize');
    writeSkill(source, '---\nname: summarize\ndescription: First.\n---\n# first\n');
    const skillsDir = join(tmp('skill-lib-'), 'skills');
    expect(await importUserSkill(skillsDir, source)).toEqual({ ok: true, name: 'summarize' });
    writeFileSync(join(source, 'SKILL.md'), '---\nname: summarize\ndescription: Second.\n---\n# second\n', 'utf8');
    expect(await importUserSkill(skillsDir, source)).toEqual({ ok: false, reason: 'exists', name: 'summarize' });
    expect(readFileSync(join(skillsDir, 'summarize', 'SKILL.md'), 'utf8')).toContain('First.');
    expect(await importUserSkill(skillsDir, source, { overwrite: true })).toEqual({ ok: true, name: 'summarize' });
    expect(readFileSync(join(skillsDir, 'summarize', 'SKILL.md'), 'utf8')).toContain('Second.');
  });

  it('rejects uninstall names that could leave the library root', async () => {
    const skillsDir = join(tmp('skill-lib-'), 'skills');
    mkdirSync(join(skillsDir, 'keep'), { recursive: true });
    writeSkill(join(skillsDir, 'keep'), '---\nname: keep\ndescription: Stay.\n---\n# keep\n');
    for (const name of ['../x', 'a/b', '.', '', '..']) {
      expect(await uninstallUserSkill(skillsDir, name), name).toEqual({ ok: false, reason: 'bad-name' });
    }
    expect(existsSync(skillsDir)).toBe(true);
    expect(existsSync(join(skillsDir, 'keep', 'SKILL.md'))).toBe(true);
  });

  it('returns not-found for a missing destName', async () => {
    const skillsDir = join(tmp('skill-lib-'), 'skills');
    mkdirSync(skillsDir, { recursive: true });
    expect(await uninstallUserSkill(skillsDir, 'missing')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('treats missing library as an empty list', async () => {
    expect(await listUserSkills(join(tmp('skill-lib-'), 'no-such-skills'))).toEqual([]);
  });

  it('rejects overlap when source is the library, dest is inside source, or source is inside dest', async () => {
    const root = tmp('skill-overlap-');
    const skillsDir = join(root, 'skills');
    const child = join(skillsDir, 'summarize');
    writeSkill(child, '---\nname: summarize\ndescription: Installed.\n---\n# installed\n');

    writeSkill(skillsDir, '---\nname: summarize\ndescription: Library root.\n---\n# root\n');
    expect(await importUserSkill(skillsDir, skillsDir)).toEqual({ ok: false, reason: 'overlap' });
    expect(readFileSync(join(child, 'SKILL.md'), 'utf8')).toContain('Installed.');

    const nested = join(child, 'inner');
    writeSkill(nested, '---\nname: summarize\ndescription: Nested inside dest.\n---\n# nested\n');
    expect(await importUserSkill(skillsDir, nested, { overwrite: true })).toEqual({ ok: false, reason: 'overlap' });
    expect(readFileSync(join(child, 'SKILL.md'), 'utf8')).toContain('Installed.');

    const parent = root;
    writeFileSync(join(parent, 'SKILL.md'), '---\nname: summarize\ndescription: Parent of dest.\n---\n# parent\n', 'utf8');
    expect(await importUserSkill(skillsDir, parent, { overwrite: true })).toEqual({ ok: false, reason: 'overlap' });
    expect(readFileSync(join(child, 'SKILL.md'), 'utf8')).toContain('Installed.');
  });

  it('marks hasScripts when scripts/ exists', async () => {
    const source = join(tmp('skill-src-'), 'with-scripts');
    writeSkill(
      source,
      '---\nname: with-scripts\ndescription: Has scripts.\n---\n# body\n',
      { 'scripts/run.sh': 'echo hi' },
    );
    const preview = await previewUserSkill(source);
    expect(preview.ok).toBe(true);
    if (preview.ok) expect(preview.skill.hasScripts).toBe(true);
  });
});
