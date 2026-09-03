import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (buffer: Buffer) => buffer.toString(),
  },
}));

import { assemble, type Runtime } from '../electron/main/runtime.js';

const dirs: string[] = [];
const runtimes: Runtime[] = [];

afterEach(() => {
  for (const rt of runtimes) {
    rt.audit.close();
    rt.chatSessions.close();
    rt.errors.close();
  }
  runtimes.length = 0;
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* sqlite handles on Windows can outlive close() by a tick */
    }
  }
  dirs.length = 0;
});

function writeProfile(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-profile-'));
  dirs.push(dir);
  for (const [p, c] of Object.entries(files)) {
    const full = join(dir, p);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, c);
  }
  return dir;
}

const PROFILE_FILES = {
  'agent/tools.yaml': 'tools: [search.web]\n',
  'agent/workflow.yaml': 'version: 1\nengine: linear\nsteps: []\n',
  'agent/knowledge/corpus.json': '[]',
  'ui/pages/home.json': '{}',
  'ui/theme.yaml': 'file: theme/tokens.json\n',
  'ui/theme/tokens.json': '{}',
  'security/roles.yaml': 'roles: []\n',
  'security/approval.yaml': 'requireApproval: []\ntimeoutMs: 60000\nhighRiskDoubleConfirm: true\n',
};

describe('assemble', () => {
  it('takes surface and tools from a non-general profile manifest', async () => {
    const dir = writeProfile({
      ...PROFILE_FILES,
      'manifest.yaml': [
        'name: research-bot',
        'version: 1.0.0',
        'displayName: 研究助手',
        'surface:',
        '  type: workflow',
        '  entry: surface.tsx',
        'capabilities:',
        '  tools: [search.web]',
        'modelRouting:',
        '  tasks:',
        '    default:',
        '      - { provider: local, modelId: qwen2.5:7b }',
        '',
      ].join('\n'),
    });
    const dataDir = mkdtempSync(join(tmpdir(), 'runtime-data-'));
    dirs.push(dataDir);

    const rt = await assemble({ profiles: [{ id: 'research-bot', dir }], dataDir, allowUnsigned: true });
    runtimes.push(rt);
    const agent = rt.agents.get('research-bot');

    expect(agent?.manifest.surface).toEqual({ type: 'workflow', entry: 'surface.tsx' });
    expect(agent?.manifest.capabilities.tools).toEqual(['search.web']);
  });

  it('defaults omitted surface to chat by type rather than by profile id', async () => {
    const dir = writeProfile({
      ...PROFILE_FILES,
      'manifest.yaml': [
        'name: contract-review',
        'version: 1.0.0',
        'modelRouting:',
        '  tasks:',
        '    default:',
        '      - { provider: local, modelId: qwen2.5:7b }',
        '',
      ].join('\n'),
    });
    const dataDir = mkdtempSync(join(tmpdir(), 'runtime-data-'));
    dirs.push(dataDir);

    const rt = await assemble({ profiles: [{ id: 'contract-review', dir }], dataDir, allowUnsigned: true });
    runtimes.push(rt);
    const agent = rt.agents.get('contract-review');

    expect(agent?.manifest.surface).toEqual({ type: 'chat' });
    expect(agent?.manifest.capabilities.tools).toEqual([]);
  });
});
