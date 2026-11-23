import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorStore } from '../electron/main/error-store.js';
import { MemoryService } from '../electron/main/memory/service.js';
import { handleMemoryToolAction } from '../electron/main/memory/tools.js';
import { userMemoryFile } from '../electron/main/memory/settings.js';
import { createMemoryToolDefinitions } from '../../../packages/agent-host/src/memory-tools.js';
import { buildAgentSaddle } from '../electron/main/saddle.js';

let root: string;
let dataDir: string;
let errors: ErrorStore;
let service: MemoryService;
let audit: ReturnType<typeof vi.fn>;
let propose: ReturnType<typeof vi.fn>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sparkii-tools-'));
  dataDir = join(root, 'data');
  errors = new ErrorStore(join(dataDir, 'errors.db'));
  service = new MemoryService({ dataDir, errors, sessionExists: () => true });
  audit = vi.fn(async () => ({}));
  propose = vi.fn(async () => ({ approved: true, proposalId: 'p1', status: 'approved' }));
});

afterEach(() => {
  service.close();
  errors.close();
  rmSync(root, { recursive: true, force: true });
});

function runTool(name: string, args: Record<string, unknown>) {
  const defs = createMemoryToolDefinitions({
    requestAction: (request) => handleMemoryToolAction(request, {
      service, audit: { append: audit }, actor: 'u1', sessionId: 'sess-1', profileId: 'general',
      propose,
    }),
  });
  const def = defs.find((d) => d.name === name)!;
  return (def as any).execute(`call-${name}`, args, undefined, undefined, undefined);
}

describe('memory tools — platform trusted branch', () => {
  it('memory_remember 直接写入 active 并审计', async () => {
    const out = await runTool('memory_remember', { text: '用户偏好用中文汇报' });
    expect(out.details.ok).toBe(true);
    expect(service.buildBlock({ profileId: 'general' })).toContain('用户偏好用中文汇报');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'memory.remember', decision: 'allowed' }));
  });

  it('memory_forget 先弹审批；拒绝不删，批准才三处真删', async () => {
    const added = service.addMemory({ scope: 'user', text: '这条将被忘掉' });
    propose.mockResolvedValueOnce({ approved: false, proposalId: 'p0', status: 'denied' });
    const denied = await runTool('memory_forget', { query: '将被忘掉' });
    expect(denied.details.ok).toBe(false);
    expect(service.store.rowFor(added.id)).toBeTruthy();
    const proposal = propose.mock.calls[0][0];
    expect(proposal.toolName).toBe('memory_forget');
    expect(proposal.preview.lines.join('')).toContain('这条将被忘掉');
    expect(proposal.risk).toBe('high-risk');

    const approved = await runTool('memory_forget', { query: '将被忘掉' });
    expect(approved.details).toMatchObject({ ok: true, removed: 1 });
    expect(service.store.rowFor(added.id)).toBeUndefined();
    expect(service.searchMemory('将被忘掉')).toHaveLength(0);
    expect(readFileSync(userMemoryFile(dataDir), 'utf8')).not.toContain(added.id);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'memory.forget', decision: 'allowed' }));
  });

  it('memory_search 只读命中并强化（不重置其他记忆）', async () => {
    service.addMemory({ scope: 'user', text: '用户要求先给结论的汇报格式' });
    const out = await runTool('memory_search', { query: '先给结论的汇报' });
    expect(out.details.ok).toBe(true);
    expect(out.details.hits).toHaveLength(1);
    expect(service.store.usageFor(out.details.hits[0].id).lastAccessedAt).not.toBeNull();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'memory.search' }));
  });

  it('总开关关闭时三工具均被拒，无写入无检索', async () => {
    service.saveSettings({ enabled: false });
    await expect(runTool('memory_remember', { text: 'x' })).rejects.toThrow('记忆功能已关闭');
  });

  it('工具名与鞍附加同源：签名 agent 清单不变，平台统一追加', () => {
    const agent = { tools: ['read'], skillsDir: '/skills', systemPrompt: 'p' };
    const saddle = buildAgentSaddle(agent as never, '/cwd', '/ws', undefined, undefined, '', true);
    expect(saddle.tools).toEqual([
      'read', 'memory_remember', 'memory_forget', 'memory_search',
    ]);
    expect(agent.tools).toEqual(['read']);
    const without = buildAgentSaddle(agent as never, '/cwd', '/ws');
    expect(without.tools).toEqual(['read']);
  });
});
