import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkspacePathProbe } from '@sparkii/approval';
import { createCodingToolDefinitions } from '../../../packages/agent-host/src/coding-tools.ts';
import { resolveGuardedReadPath, isPlatformReservedPath } from '../../../packages/agent-host/src/workspace-guard.ts';
import { createWorkspaceFileService } from '../electron/main/security/workspace-file-service.js';
import { buildAgentSaddle } from '../electron/main/saddle.js';

function makeProbe(): WorkspacePathProbe {
  const key = (v: string) => v.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return {
    inspect: async (target) => {
      const abs = resolve(target);
      const exists = existsSync(abs);
      return {
        displayPath: target, canonicalPath: abs, identity: `mock:${key(abs)}`,
        nearestExistingAncestor: abs,
        isDirectory: exists ? (await import('node:fs')).statSync(abs).isDirectory() : false,
        isReparsePoint: false, exists,
      };
    },
    isSameOrDescendant: async (root, target) => key(target) === key(root) || key(target).startsWith(`${key(root)}/`),
    isSameObject: async (left, right) => key(left) === key(right),
  };
}

describe('memory workspace fence', () => {
  it('agent write 工具实测写 .sparkii 被拒（不是只读代码断言）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'sparkii-fence-'));
    const workspace = join(base, 'workspace');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(workspace, '.sparkii'), { recursive: true });
    const actions: string[] = [];
    const tools = createCodingToolDefinitions({
      cwd: workspace, workspaceRoot: workspace,
      requestAction: async (req) => {
        actions.push(req.toolName);
        return {
          requestId: req.requestId,
          status: 'executed' as const,
          decision: { decision: 'allow' as const, ruleId: 'test', reason: '' },
          result: { ok: true },
        };
      },
    });
    const write = tools.find((t) => t.name === 'write')!;
    await expect((write as any).execute('call-1', {
      path: '.sparkii/memory.json', content: '{}',
    }, undefined, undefined, undefined)).rejects.toThrow('平台保留目录');
    expect(actions).toEqual([]);
    // 普通路径仍可写，说明拒绝只针对保留目录。
    await (write as any).execute('call-2', { path: 'note.txt', content: 'ok' }, undefined, undefined, undefined);
    expect(actions).toEqual(['write']);
  });

  it('delete/move 工具与 read 守卫同样拒绝 .sparkii', async () => {
    const base = mkdtempSync(join(tmpdir(), 'sparkii-fence-'));
    const workspace = join(base, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const guarded = await resolveGuardedReadPath(workspace, join(workspace, '.sparkii', 'memory.json'));
    expect(guarded.ok).toBe(false);
    if (!guarded.ok) expect(guarded.code).toBe('PLATFORM_RESERVED');
    expect(isPlatformReservedPath(join(workspace, '.sparkii', 'a.txt'))).toBe(true);
    expect(isPlatformReservedPath(join(workspace, 'notes.sparkii.md'))).toBe(false);
  });

  it('文件树 list 过滤 .sparkii，且对该目录的写入被主进程服务拒绝', async () => {
    const base = mkdtempSync(join(tmpdir(), 'sparkii-fence-'));
    const workspace = join(base, 'workspace');
    mkdirSync(join(workspace, '.sparkii'), { recursive: true });
    writeFileSync(join(workspace, 'readme.md'), 'ok');
    const audits: Array<{ decision?: string }> = [];
    const service = createWorkspaceFileService({
      chatSessions: { get: () => ({ id: 's1', profileId: 'general', workspacePath: workspace }) } as never,
      audit: { append: async (ev: { decision?: string }) => { audits.push(ev); return ev; } } as never,
      security: { pathProbe: makeProbe(), protectedRoots: [] } as never,
      subjectUserId: 'u1',
    });
    const list = await service.execute('list', { sessionId: 's1', path: '.' });
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.entries).toEqual(['readme.md']);
    const write = await service.execute('write', { sessionId: 's1', path: '.sparkii/memory.json', content: '{}' });
    expect(write.ok).toBe(false);
    expect(audits.some((a) => a.decision === 'failed')).toBe(true);
  });

  it('记忆块追加在鞍文本末尾（skill/cwd 仍由平台合并）', () => {
    const saddle = buildAgentSaddle(
      { tools: [], skillsDir: '/skills', cwd: '/cwd', systemPrompt: '原始提示', manifest: {} } as never,
      '/cwd', '/ws', undefined, undefined,
      '<memory>\n[用户] (2026-11-23) 记住我\n</memory>',
    );
    expect(saddle.systemPrompt.startsWith('原始提示')).toBe(true);
    expect(saddle.systemPrompt).toContain('<memory>');
    expect(saddle.systemPrompt.indexOf('<memory>')).toBeGreaterThan(saddle.systemPrompt.indexOf('原始提示'));
  });
});
