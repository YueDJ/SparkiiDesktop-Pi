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

const BASE = {
  'manifest.yaml': 'name: general\nversion: 1.0.0\nmodelRouting:\n  tasks:\n    default:\n      - { provider: local, modelId: qwen2.5:7b }\n',
  'agent/tools.yaml': 'tools: [read, bash]\n',
  'agent/workflow.yaml': 'version: 1\nengine: linear\nsteps: []\n',
  'ui/pages/home.json': '{}',
  'ui/theme.yaml': 'file: theme/tokens.json\n',
  'ui/theme/tokens.json': '{}',
  'security/roles.yaml': 'roles: []\n',
  'security/approval.yaml': 'requireApproval: []\ntimeoutMs: 60000\nhighRiskDoubleConfirm: true\n',
  'agent/knowledge/corpus.json': '[]',
};

describe('agent/prompts/system.md', () => {
  it('loads system.md into prompts.system and integrity files', async () => {
    const dir = writeProfile({ ...BASE, 'agent/prompts/system.md': '你是通用智能体。' });
    const p = await loadProfile(dir, { allowUnsigned: true });
    expect(p.agent.prompts.system).toBe('你是通用智能体。');
  });
  it('tolerates missing system.md', async () => {
    const dir = writeProfile({ ...BASE });
    const p = await loadProfile(dir, { allowUnsigned: true });
    expect(p.agent.prompts.system).toBeUndefined();
  });
});
