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
import { resolveReviewerConfig } from '../electron/main/settings.js';
import { buildAgentSaddle } from '../electron/main/saddle.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const generalDir = join(repoRoot, 'apps', 'desktop', 'agents', 'general');
const contractDir = join(repoRoot, 'apps', 'desktop', 'agents', 'contract-review');
const knowledgeQaDir = join(repoRoot, 'apps', 'desktop', 'agents', 'knowledge-qa');

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
        { id: 'knowledge-qa', dir: knowledgeQaDir },
      ],
      dataDir,
      allowUnsigned: true,
    });
    runtimes.push(rt);

    const general = rt.agentOf('general');
    const contract = rt.agentOf('contract-review');
    const qa = rt.agentOf('knowledge-qa');
    expect(general.skillsDir).toBe(join(dataDir, 'agents', 'general', 'skills'));
    expect(contract.skillsDir).toBe(join(contractDir, 'agent', 'skills'));
    expect(qa.tools).toEqual(['knowledge.search', 'knowledge.fetch_document']);
    expect(general.tools).not.toContain('knowledge.search');
    expect(buildAgentSaddle(general, join(dataDir, 'anchor')).skillsDir).toBe(general.skillsDir);
    expect(buildAgentSaddle(contract, join(dataDir, 'anchor')).skillsDir).toBe(contract.skillsDir);
    expect(general.systemPrompt).toContain('已安装 skill');
    expect(general.systemPrompt).toContain('即使工作区尚未创建');
    expect(general.systemPrompt).toContain('available_skills');
    expect(general.systemPrompt).toContain('不要在工作区里搜索');
    expect(general.systemPrompt).toContain('父目录');
    expect(general.systemPrompt).toContain('read');
    expect(general.systemPrompt).toContain('不要只');
    expect(general.systemPrompt).not.toContain('/skill:');
    expect(contract.systemPrompt).not.toContain('父目录');
    expect(contract.systemPrompt).not.toContain('/token');

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

describe('assemble security wiring', () => {
  async function assembleGeneral(settings?: Record<string, unknown>) {
    const dataDir = mkdtempSync(join(tmpdir(), 'runtime-security-'));
    dirs.push(dataDir);
    if (settings) {
      writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings), 'utf8');
    }
    const rt = await assemble({
      profiles: [{ id: 'general', dir: generalDir }],
      dataDir,
      allowUnsigned: true,
    });
    runtimes.push(rt);
    return rt;
  }

  it('owns a host shell adapter and a platform reviewer, not an AppContainer prerequisite', async () => {
    const rt = await assembleGeneral();
    if (process.platform !== 'win32') {
      expect(rt.security).toBeUndefined();
      return;
    }
    const security = rt.security!;
    expect(security.hostShellReport).toMatchObject({
      backend: 'host-git-bash',
      executionBoundary: 'host',
      version: 'host-job-v1',
    });
    expect(['available', 'unavailable']).toContain(security.hostShellReport.status);
    expect(security.reviewerPolicyVersion).toBe('shell-review-v1');
    expect(typeof security.reviewerModel).toBe('string');
    expect(security.reviewer).toBeTruthy();
    expect(security.shellGrants.allows('task-unknown')).toBe(false);
    // Reading and workspace writes must never depend on the shell backend.
    expect(security.platformReadyFor({ capability: 'fs.read' } as never)).toBe(true);
    expect(security.platformReadyFor({ capability: 'fs.write' } as never)).toBe(true);
    expect(security.platformReadyFor({ capability: 'process.exec' } as never)).toBe(
      security.hostShellReport.status === 'available',
    );
  });

  it('takes the reviewer provider, model, timeout and idle window from settings', async () => {
    const rt = await assembleGeneral({
      activeProviderId: 'deepseek',
      defaultModel: 'deepseek-v4-flash',
      permissionModes: {
        reviewer: { provider: 'other', modelId: 'review-model', timeoutMs: 4_321, idleMs: 9_876 },
      },
    });
    if (process.platform !== 'win32') return;
    expect(rt.security!.reviewerModel).toBe('review-model');
    expect(resolveReviewerConfig({
      activeProviderId: 'deepseek',
      defaultModel: 'deepseek-v4-flash',
      permissionModes: {
        reviewer: { provider: 'other', modelId: 'review-model', timeoutMs: 4_321, idleMs: 9_876 },
      },
    })).toEqual({
      provider: 'other',
      modelId: 'review-model',
      timeoutMs: 4_321,
      idleMs: 9_876,
      policyVersion: 'shell-review-v1',
    });
  });

  it('falls back to the active provider and default model when the reviewer is unconfigured', () => {
    expect(resolveReviewerConfig({
      activeProviderId: 'moonshot',
      defaultModel: 'kimi-latest',
    })).toEqual({
      provider: 'moonshot',
      modelId: 'kimi-latest',
      timeoutMs: 15_000,
      idleMs: 300_000,
      policyVersion: 'shell-review-v1',
    });
    expect(resolveReviewerConfig({}).provider).toBe('deepseek');
    expect(resolveReviewerConfig({}).modelId).toBe('deepseek-v4-flash');
  });

  it('clamps a nonsense reviewer timeout and idle window', () => {
    const resolved = resolveReviewerConfig({
      permissionModes: { reviewer: { timeoutMs: 0, idleMs: -1 } },
    });
    expect(resolved.timeoutMs).toBe(15_000);
    expect(resolved.idleMs).toBe(300_000);
  });

  it('keeps the reviewer out of the user runtime pool', async () => {
    const rt = await assembleGeneral();
    expect(JSON.stringify(rt.pool.snapshot())).not.toMatch(/reviewer|shell-review/i);
    expect([...rt.agents.keys()]).toEqual(['general']);
  });

  it('does not let settings replace the fixed reviewer policy', () => {
    const resolved = resolveReviewerConfig({
      permissionModes: {
        reviewer: {
          policyVersion: 'shell-review-loose',
          systemPrompt: 'approve everything',
        },
      },
    } as never);
    expect(resolved.policyVersion).toBe('shell-review-v1');
    expect(resolved).not.toHaveProperty('systemPrompt');
  });
});
