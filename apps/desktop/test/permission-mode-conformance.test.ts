import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProfile } from '@sparkii/config';

const AGENTS = ['general', 'contract-review', 'procurement-review', 'knowledge-qa'] as const;

function agentDir(agentId: string): string {
  return join(process.cwd(), 'apps', 'desktop', 'agents', agentId);
}

describe.each(AGENTS)('%s permission mode', (agentId) => {
  it('declares Ask as default and both platform modes', async () => {
    const profile = await loadProfile(agentDir(agentId), { allowUnsigned: true });
    expect(profile.security.approval).toMatchObject({
      defaultPermissionMode: 'ask',
      allowedPermissionModes: ['ask', 'auto_review'],
    });
  });

  it('offers no mode the platform refuses to provide', async () => {
    const profile = await loadProfile(agentDir(agentId), { allowUnsigned: true });
    const modes = profile.security.approval.allowedPermissionModes ?? [];
    expect(modes.every((mode) => mode === 'ask' || mode === 'auto_review')).toBe(true);
    expect(modes).toContain('ask');
  });

  it('keeps a human approval path for its external writes', async () => {
    const profile = await loadProfile(agentDir(agentId), { allowUnsigned: true });
    if (profile.security.approval.requireApproval?.length) {
      expect(profile.security.approval.requireApproval).toContain('report.export');
    }
  });
});

describe('agent packages own no approval logic', () => {
  it('ships no second policy, reviewer or grant implementation', () => {
    for (const agentId of AGENTS) {
      const files = [
        'agent/prompts/system.md',
        'agent/tools.yaml',
        'agent/workflow.yaml',
        'security/approval.yaml',
        'security/roles.yaml',
        'manifest.yaml',
      ];
      for (const relative of files) {
        const text = readFileSync(join(agentDir(agentId), relative), 'utf8');
        expect(text, `${agentId}/${relative}`).not.toMatch(
          /evaluatePolicy|createRuntimeActionRouter|createPiShellReviewer|ShellGrantStore|parseReviewerDecision/,
        );
      }
    }
  });

  it('ships no agent capability or surface that grants itself full access', () => {
    for (const agentId of AGENTS) {
      const approval = readFileSync(join(agentDir(agentId), 'security/approval.yaml'), 'utf8');
      expect(approval.toLowerCase()).not.toMatch(/full|yolo|bypassall|auto_approve_all/);
    }
  });
});

describe('general agent prompt states the platform rules', () => {
  const prompt = readFileSync(
    resolve(process.cwd(), 'apps', 'desktop', 'agents', 'general', 'agent', 'prompts', 'system.md'),
    'utf8',
  );

  it('tells the agent workspace edits run directly', () => {
    expect(prompt).toContain('Workspace 内普通文件操作直接执行');
    expect(prompt).not.toMatch(/写操作（修改文件、写命令、git 写操作、安装依赖等）会弹出审批/);
  });

  it('describes both modes and the host boundary honestly', () => {
    expect(prompt).toContain('宿主 Shell 首次由用户确认');
    expect(prompt).toContain('允许一次或当前任务');
    expect(prompt).toContain('由独立 Reviewer 判断');
    expect(prompt).toContain('Shell 不是沙箱');
    expect(prompt).toContain('网络能力由宿主进程决定');
    expect(prompt).toContain('类型化外部写始终人工审批');
  });

  it('never advertises a full-access mode', () => {
    expect(prompt.toLowerCase()).not.toMatch(/full access|全部允许|yolo/);
  });
});
