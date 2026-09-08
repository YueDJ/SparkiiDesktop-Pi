import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (buffer: Buffer) => buffer.toString(),
  },
}));

import { loadProfile } from '@sparkii/config';
import { assemble, type Runtime } from '../electron/main/runtime.js';
import { buildAgentSaddle } from '../electron/main/saddle.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const generalDir = join(repoRoot, 'apps', 'desktop', 'agents', 'general');
const contractDir = join(repoRoot, 'apps', 'desktop', 'agents', 'contract-review');

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

  it('resolves user-library skillsDir under dataDir and keeps package skills on the package path', async () => {
    const userDir = writeProfile({
      ...PROFILE_FILES,
      'manifest.yaml': [
        'name: writer',
        'version: 1.0.0',
        'displayName: 写作助手',
        'skillLibrary: user',
        'surface:',
        '  type: chat',
        'capabilities:',
        '  tools: [read]',
        'modelRouting:',
        '  tasks:',
        '    default:',
        '      - { provider: local, modelId: qwen2.5:7b }',
        '',
      ].join('\n'),
    });
    const packDir = writeProfile({
      ...PROFILE_FILES,
      'manifest.yaml': [
        'name: finance',
        'version: 1.0.0',
        'displayName: 财务助手',
        'surface:',
        '  type: chat',
        'capabilities:',
        '  tools: [read]',
        'modelRouting:',
        '  tasks:',
        '    default:',
        '      - { provider: local, modelId: qwen2.5:7b }',
        '',
      ].join('\n'),
    });
    const dataDir = mkdtempSync(join(tmpdir(), 'runtime-data-'));
    dirs.push(dataDir);

    const rt = await assemble({
      profiles: [
        { id: 'writer', dir: userDir },
        { id: 'finance', dir: packDir },
      ],
      dataDir,
      allowUnsigned: true,
    });
    runtimes.push(rt);

    expect(rt.agentOf('writer').skillsDir).toBe(join(dataDir, 'agents', 'writer', 'skills'));
    expect(rt.agentOf('writer').manifest.skillLibrary).toBe('user');
    expect(rt.agentOf('finance').skillsDir).toBe(join(packDir, 'agent', 'skills'));
    expect(rt.agentOf('finance').manifest.skillLibrary).toBeUndefined();
  });

  it('assembles shipped agents with isolated skillsDir values', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'runtime-data-'));
    dirs.push(dataDir);
    const rt = await assemble({
      profiles: [
        { id: 'general', dir: generalDir },
        { id: 'contract-review', dir: contractDir },
      ],
      dataDir,
      allowUnsigned: true,
    });
    runtimes.push(rt);

    const general = rt.agentOf('general');
    const contract = rt.agentOf('contract-review');
    expect(general.skillsDir).toBe(join(dataDir, 'agents', 'general', 'skills'));
    expect(contract.skillsDir).toBe(join(contractDir, 'agent', 'skills'));
    expect(buildAgentSaddle(general, join(dataDir, 'anchor')).skillsDir).toBe(general.skillsDir);
    expect(buildAgentSaddle(contract, join(dataDir, 'anchor')).skillsDir).toBe(contract.skillsDir);
    expect(general.systemPrompt).toContain('已安装 skill');
    expect(general.systemPrompt).toContain('即使工作区尚未创建');
    expect(general.systemPrompt).toContain('available_skills');
    expect(general.systemPrompt).toContain('不要在工作区里搜索');

    mkdirSync(join(general.skillsDir, 'extra-user-skill'), { recursive: true });
    writeFileSync(
      join(general.skillsDir, 'extra-user-skill', 'SKILL.md'),
      '---\nname: extra-user-skill\ndescription: User library only.\n---\n# extra\n',
      'utf8',
    );
    const profile = await loadProfile(contractDir, { allowUnsigned: true });
    expect(profile.agent.skills.map((s) => s.name)).not.toContain('extra-user-skill');
  });
});
