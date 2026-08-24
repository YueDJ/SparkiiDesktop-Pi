import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadProfile } from '../src/loader.js';

function writeProfile(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'profile-'));
  for (const [p, c] of Object.entries(files)) {
    const full = join(dir, p);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, c);
  }
  return dir;
}

describe('loadProfile', () => {
  it('loads a valid profile', async () => {
    const dir = writeProfile({
      'manifest.yaml': 'name: contract-review\nversion: 1.0.0\nmodelRouting:\n  tasks:\n    default:\n      - { provider: local, modelId: qwen2.5:7b }\n',
      'agent/tools.yaml': 'tools: [document.read, report.export]\n',
      'agent/skills/clause_extract/SKILL.md': '---\nname: clause_extract\ndescription: Extract clauses.\n---\n# extract clauses\n',
      'agent/skills/report/SKILL.md': '---\nname: report\ndescription: Generate report.\n---\n# generate report\n',
      'agent/knowledge/corpus.json': '[]',
      'agent/workflow.yaml': 'version: 1\nengine: linear\nsteps: []\n',
      'ui/pages/home.json': '{}',
      'ui/theme.yaml': 'file: theme/tokens.json\n',
      'ui/theme/tokens.json': '{}',
      'security/roles.yaml': 'roles: []\n',
      'security/approval.yaml': 'requireApproval: [report.export]\ntimeoutMs: 60000\nhighRiskDoubleConfirm: true\n',
    });
    const p = await loadProfile(dir, { allowUnsigned: true });
    expect(p.manifest.name).toBe('contract-review');
    expect(p.agent.tools).toEqual(['document.read', 'report.export']);
    expect(p.agent.skills.map((s) => s.name).sort()).toEqual(['clause_extract', 'report']);
    expect(p.agent.skills[0]?.description).toBeTruthy();
    expect(p.agent.prompts).toMatchObject({ report: '# generate report\n', clause_extract: '# extract clauses\n' });
  });

  it('fails closed on invalid manifest', async () => {
    const dir = writeProfile({ 'manifest.yaml': 'name: x\n' });
    await expect(loadProfile(dir)).rejects.toMatchObject({ code: 'PROFILE_INVALID' });
  });
});
