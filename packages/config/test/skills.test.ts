import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadSkillsFromDir, parseSkillFrontmatter } from '../src/skills.js';
import { collectSkillDirFiles } from '../src/skills.js';

function write(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'));
  for (const [p, c] of Object.entries(files)) {
    const full = join(dir, p);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, c);
  }
  return dir;
}

describe('parseSkillFrontmatter', () => {
  it('parses frontmatter and returns the body', () => {
    const raw = '---\nname: foo\ndescription: Does foo.\n---\n# Foo\n\nDo it.\n';
    const { frontmatter, body } = parseSkillFrontmatter(raw);
    expect(frontmatter).toMatchObject({ name: 'foo', description: 'Does foo.' });
    expect(body).toBe('# Foo\n\nDo it.\n');
  });

  it('treats text without frontmatter as body', () => {
    const { frontmatter, body } = parseSkillFrontmatter('# Foo\n');
    expect(frontmatter).toEqual({});
    expect(body).toBe('# Foo\n');
  });
});

describe('loadSkillsFromDir', () => {
  it('discovers SKILL.md directories and root-level md files', async () => {
    const dir = write({
      'clause_extract/SKILL.md': '---\nname: clause_extract\ndescription: Extract clauses.\n---\n抽取条款。\n',
      'report.md': '---\nname: report\ndescription: Generate report.\n---\n生成报告。\n',
      'nested/a/SKILL.md': '---\nname: a\ndescription: Skill a.\n---\nA.\n',
      'not-a-skill/notes.txt': 'x',
    });
    const { skills } = await loadSkillsFromDir(dir);
    expect(skills.map((s) => s.name).sort()).toEqual(['a', 'clause_extract', 'report']);
    expect(skills.find((s) => s.name === 'report')?.content).toBe('生成报告。\n');
  });

  it('does not load a skill whose description is missing', async () => {
    const dir = write({ 'bad/SKILL.md': '---\nname: bad\n---\nNo description.\n' });
    const { skills, diagnostics } = await loadSkillsFromDir(dir);
    expect(skills).toHaveLength(0);
    expect(diagnostics.some((d) => d.message.includes('description'))).toBe(true);
  });

  it('keeps only the first skill on name collision and reports it', async () => {
    const dir = write({
      'aa/SKILL.md': '---\nname: dup\ndescription: First.\n---\nfirst\n',
      'bb/SKILL.md': '---\nname: dup\ndescription: Second.\n---\nsecond\n',
    });
    const { skills, diagnostics } = await loadSkillsFromDir(dir);
    expect(skills).toHaveLength(1);
    expect(diagnostics.some((d) => d.type === 'collision')).toBe(true);
  });
});

describe('collectSkillDirFiles', () => {
  it('recursively collects skill files and skips ignored paths', async () => {
    const dir = write({
      'clause_extract/SKILL.md': '---\nname: clause_extract\ndescription: Extract.\n---\n正文\n',
      'clause_extract/references/law.md': '法规条文',
      'clause_extract/assets/logo.png': 'PNG',
      'clause_extract/node_modules/x.js': 'skip',
      'clause_extract/.hidden': 'skip',
    });
    const files = await collectSkillDirFiles(join(dir, 'clause_extract'));
    expect(Object.keys(files).sort()).toEqual(['SKILL.md', 'assets/logo.png', 'references/law.md']);
    expect(files['references/law.md'].toString()).toBe('法规条文');
  });
});
