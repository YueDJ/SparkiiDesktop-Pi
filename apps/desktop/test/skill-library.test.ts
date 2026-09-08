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
      destName: 'summarize',
      skill: { name: 'summarize', description: 'Summarize a document.', hasScripts: false },
    });
    if (preview.ok) expect(preview.skill.name).toBe(preview.destName);

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
      expect(preview.destName).toBe('my-skill');
      expect(preview.skill.name).toBe(preview.destName);
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

  it('skips dotfiles when importing a single skill root', async () => {
    const source = join(tmp('skill-src-'), 'summarize');
    writeSkill(source, '---\nname: summarize\ndescription: Clean copy.\n---\n# body\n');
    mkdirSync(join(source, '.git'), { recursive: true });
    writeFileSync(join(source, '.git', 'HEAD'), 'ref', 'utf8');
    mkdirSync(join(source, '.cloud'), { recursive: true });
    writeFileSync(join(source, '.cloud', 'meta.json'), '{}', 'utf8');
    const skillsDir = join(tmp('skill-lib-'), 'skills');
    expect(await importUserSkill(skillsDir, source)).toEqual({ ok: true, name: 'summarize' });
    expect(existsSync(join(skillsDir, 'summarize', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'summarize', '.git'))).toBe(false);
    expect(existsSync(join(skillsDir, 'summarize', '.cloud'))).toBe(false);
  });

  it('imports a Pi skill pack as one destName and copies only useful files', async () => {
    const source = join(tmp('skill-pack-'), 'superpowers');
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({
        name: 'superpowers',
        description: 'Superpowers skills and runtime bootstrap for coding agents',
        keywords: ['pi-package'],
        pi: { skills: ['./skills'], extensions: ['./.pi/extensions/superpowers.ts'] },
      }),
      'utf8',
    );
    writeFileSync(join(source, 'README.md'), 'not a skill', 'utf8');
    mkdirSync(join(source, '.cloud'), { recursive: true });
    writeFileSync(join(source, '.cloud', 'config.json'), '{}', 'utf8');
    mkdirSync(join(source, '.git'), { recursive: true });
    writeFileSync(join(source, '.git', 'HEAD'), 'ref', 'utf8');
    mkdirSync(join(source, '.pi', 'extensions'), { recursive: true });
    writeFileSync(join(source, '.pi', 'extensions', 'superpowers.ts'), 'export {}', 'utf8');
    writeSkill(
      join(source, 'skills', 'brainstorming'),
      '---\nname: brainstorming\ndescription: Brainstorm before coding.\n---\n# brainstorm\n',
      { 'references/notes.md': 'notes' },
    );
    writeSkill(
      join(source, 'skills', 'writing-plans'),
      '---\nname: writing-plans\ndescription: Write an implementation plan.\n---\n# plan\n',
      { 'scripts/run.sh': 'echo hi' },
    );

    const preview = await previewUserSkill(source);
    expect(preview).toMatchObject({
      ok: true,
      destName: 'superpowers',
      skill: {
        name: 'superpowers',
        description: 'Superpowers skills and runtime bootstrap for coding agents',
        kind: 'pack',
        skillCount: 2,
        hasScripts: true,
      },
    });
    if (preview.ok) expect(preview.skill.name).toBe(preview.destName);

    const skillsDir = join(tmp('skill-lib-'), 'skills');
    expect(await importUserSkill(skillsDir, source)).toEqual({ ok: true, name: 'superpowers' });
    expect(await listUserSkills(skillsDir)).toMatchObject([
      {
        name: 'superpowers',
        description: 'Superpowers skills and runtime bootstrap for coding agents',
        kind: 'pack',
        skillCount: 2,
        hasScripts: true,
      },
    ]);
    expect(existsSync(join(skillsDir, 'superpowers', 'package.json'))).toBe(true);
    expect(existsSync(join(skillsDir, 'brainstorming'))).toBe(false);
    expect(existsSync(join(skillsDir, 'writing-plans'))).toBe(false);
    expect(readFileSync(join(skillsDir, 'superpowers', 'brainstorming', 'references', 'notes.md'), 'utf8')).toBe('notes');
    expect(existsSync(join(skillsDir, 'superpowers', 'writing-plans', 'scripts', 'run.sh'))).toBe(true);
    expect(existsSync(join(skillsDir, 'superpowers', 'skills'))).toBe(false);
    expect(existsSync(join(skillsDir, 'superpowers', 'README.md'))).toBe(false);
    expect(existsSync(join(skillsDir, 'superpowers', '.cloud'))).toBe(false);
    expect(existsSync(join(skillsDir, 'superpowers', '.git'))).toBe(false);
    expect(existsSync(join(skillsDir, 'superpowers', '.pi'))).toBe(false);
  });

  it('imports a conventional skills/ folder using the parent destName', async () => {
    const pack = join(tmp('skill-pack-'), 'My Pack');
    writeSkill(
      join(pack, 'skills', 'outline'),
      '---\nname: outline\ndescription: Make an outline.\n---\n# outline\n',
    );
    const skillsDir = join(tmp('skill-lib-'), 'skills');
    expect(await importUserSkill(skillsDir, join(pack, 'skills'))).toEqual({ ok: true, name: 'my-pack' });
    expect(existsSync(join(skillsDir, 'my-pack', 'outline', 'SKILL.md'))).toBe(true);
  });

  it('fails closed when pack child destNames collide', async () => {
    const source = join(tmp('skill-pack-'), 'collide-pack');
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({ name: 'collide-pack', keywords: ['pi-package'], pi: { skills: ['./skills'] } }),
      'utf8',
    );
    writeSkill(
      join(source, 'skills', 'My Skill'),
      '---\nname: My Skill\ndescription: First.\n---\n# a\n',
    );
    writeSkill(
      join(source, 'skills', 'my-skill'),
      '---\nname: my-skill\ndescription: Second.\n---\n# b\n',
    );
    const skillsDir = join(tmp('skill-lib-'), 'skills');
    const preview = await previewUserSkill(source);
    expect(preview.ok).toBe(false);
    if (!preview.ok) {
      expect(preview.reason).toBe('bad-name');
      expect(preview.diagnostics?.some((d) => d.includes('冲突'))).toBe(true);
    }
    expect(await importUserSkill(skillsDir, source)).toMatchObject({ ok: false, reason: 'bad-name' });
    expect(existsSync(skillsDir)).toBe(false);
  });

  it('fails closed when a pack child cannot form a destName', async () => {
    const source = join(tmp('skill-pack-'), 'illegal-child');
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({ name: 'illegal-child', keywords: ['pi-package'], pi: { skills: ['./skills'] } }),
      'utf8',
    );
    writeSkill(
      join(source, 'skills', '你好'),
      '---\nname: 你好\ndescription: Cannot sanitize.\n---\n# body\n',
    );
    const skillsDir = join(tmp('skill-lib-'), 'skills');
    const preview = await previewUserSkill(source);
    expect(preview.ok).toBe(false);
    if (!preview.ok) {
      expect(preview.reason).toBe('bad-name');
      expect(preview.diagnostics?.some((d) => d.includes('合法安装名'))).toBe(true);
    }
    expect(await importUserSkill(skillsDir, source)).toMatchObject({ ok: false, reason: 'bad-name' });
    expect(existsSync(skillsDir)).toBe(false);
  });

  it('uses a legal frontmatter name when the pack child folder is illegal', async () => {
    const source = join(tmp('skill-pack-'), 'named-pack');
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({ name: 'named-pack', keywords: ['pi-package'], pi: { skills: ['./skills'] } }),
      'utf8',
    );
    writeSkill(
      join(source, 'skills', '!!!'),
      '---\nname: legal-name\ndescription: Saved by frontmatter.\n---\n# body\n',
    );
    const skillsDir = join(tmp('skill-lib-'), 'skills');
    expect(await importUserSkill(skillsDir, source)).toEqual({ ok: true, name: 'named-pack' });
    expect(existsSync(join(skillsDir, 'named-pack', 'legal-name', 'SKILL.md'))).toBe(true);
  });

  it('rejects an empty skills/ folder that is not a Pi package', async () => {
    const source = tmp('skill-empty-skills-');
    mkdirSync(join(source, 'skills'), { recursive: true });
    const skillsDir = join(tmp('skill-lib-'), 'skills');
    expect(await previewUserSkill(source)).toEqual({ ok: false, reason: 'not-skill-root' });
    expect(await importUserSkill(skillsDir, source)).toEqual({ ok: false, reason: 'not-skill-root' });
    expect(existsSync(skillsDir)).toBe(false);
  });

  it('rejects an empty Pi package as invalid-skill', async () => {
    const source = tmp('skill-empty-pi-');
    mkdirSync(join(source, 'skills'), { recursive: true });
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({ name: 'empty-pack', keywords: ['pi-package'], pi: { skills: ['./skills'] } }),
      'utf8',
    );
    const skillsDir = join(tmp('skill-lib-'), 'skills');
    expect(await previewUserSkill(source)).toMatchObject({ ok: false, reason: 'invalid-skill' });
    expect(await importUserSkill(skillsDir, source)).toMatchObject({ ok: false, reason: 'invalid-skill' });
    expect(existsSync(skillsDir)).toBe(false);
  });

  it('still rejects a repo that only hides SKILL.md outside skills/', async () => {
    const source = tmp('skill-repo-junk-');
    writeSkill(join(source, 'docs', 'hidden'), '---\nname: hidden\ndescription: Hidden.\n---\n# hidden\n');
    mkdirSync(join(source, '.cloud'), { recursive: true });
    const skillsDir = join(tmp('skill-lib-'), 'skills');
    expect(await previewUserSkill(source)).toEqual({ ok: false, reason: 'not-skill-root' });
    expect(await importUserSkill(skillsDir, source)).toEqual({ ok: false, reason: 'not-skill-root' });
    expect(existsSync(skillsDir)).toBe(false);
  });
});
