import { mkdtempSync } from 'node:fs';
import { link, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createCodingToolDefinitions,
  type CodingToolsContext,
} from '../src/coding-tools.js';
import type {
  ActionExecutionResult,
  RuntimeActionRequest,
} from '../src/runtime-actions.js';

const toolCtx = {
  sessionManager: {
    getSessionId: () => 'test-session',
    getSessionFile: () => null,
  },
};

const allowDecision = {
  decision: 'allow' as const,
  ruleId: 'workspace.write',
  reason: '工作区内文件修改',
};

function executed(
  requestId: string,
  result: unknown,
): ActionExecutionResult {
  return {
    requestId,
    status: 'executed',
    decision: allowDecision,
    result,
  };
}

function harness(overrides: Partial<CodingToolsContext> = {}) {
  const requests: RuntimeActionRequest[] = [];
  const requestAction = vi.fn(async (request: RuntimeActionRequest) => {
    requests.push(request);
    return executed(request.requestId, {
      exitCode: 0,
      output: 'ok',
      path: request.args.path,
    });
  });
  const records: Array<{ customType: string; data: Record<string, unknown> }> = [];
  const context: CodingToolsContext = {
    cwd: join(tmpdir(), 'anchor'),
    workspaceRoot: mkdtempSync(join(tmpdir(), 'ws-')),
    requestAction,
    recordSessionEntry: (customType, data) => records.push({ customType, data }),
    ...overrides,
  };
  return { context, requestAction, requests, records };
}

describe('createCodingToolDefinitions', () => {
  it('registers native bash/edit/write definitions', () => {
    const { context } = harness();
    expect(createCodingToolDefinitions(context).map((d) => d.name).sort())
      .toEqual(['bash', 'edit', 'write']);
  });

  it('disables model shell before it can reach the runtime action router', async () => {
    const h = harness();
    const bash = createCodingToolDefinitions(h.context)
      .find((definition) => definition.name === 'bash')!;
    const result = await (bash as any).execute(
      'call-1',
      { command: 'cat alias/memory.json' },
      undefined,
      () => {},
      toolCtx,
    );

    expect(h.requestAction).not.toHaveBeenCalled();
    expect((result as any).content?.[0]?.text).toContain('模型 Shell 已禁用');
    expect(h.records).toEqual([]);
  });

  it('sends write through the action protocol without approval rows', async () => {
    const h = harness();
    const write = createCodingToolDefinitions(h.context)
      .find((definition) => definition.name === 'write')!;
    await (write as any).execute(
      'call-write',
      { path: join(h.context.workspaceRoot, 'a.txt'), content: 'x' },
      undefined,
      undefined,
      toolCtx,
    );

    expect(h.requestAction).toHaveBeenCalledWith({
      requestId: expect.any(String),
      toolCallId: 'call-write',
      toolName: 'write',
      args: {
        path: join(h.context.workspaceRoot, 'a.txt'),
        content: 'x',
      },
    });
    expect(h.records).toEqual([]);
  });

  it('sends edit content through the same Main-verified write path', async () => {
    const h = harness();
    await writeFile(join(h.context.workspaceRoot, 'a.txt'), 'old');
    const edit = createCodingToolDefinitions(h.context)
      .find((definition) => definition.name === 'edit')!;
    await (edit as any).execute(
      'call-edit',
      {
        path: join(h.context.workspaceRoot, 'a.txt'),
        edits: [{ oldText: 'old', newText: 'new' }],
      },
      undefined,
      undefined,
      toolCtx,
    );

    expect(h.requestAction).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'edit',
      toolCallId: 'call-edit',
      args: {
        path: join(h.context.workspaceRoot, 'a.txt'),
        content: 'new',
      },
    }));
    expect(h.requests.map((request) => request.toolName)).toEqual(['read', 'edit']);
    expect(h.records).toEqual([]);
  });

  it('does not read or match oldText until Main authorizes the edit source', async () => {
    const h = harness();
    const path = join(h.context.workspaceRoot, 'a.txt');
    await writeFile(path, 'before-authorization');
    h.requestAction.mockImplementationOnce(async (request: RuntimeActionRequest) => {
      h.requests.push(request);
      await writeFile(path, 'after-authorization');
      return executed(request.requestId, { authorized: true });
    });
    const edit = createCodingToolDefinitions(h.context)
      .find((definition) => definition.name === 'edit')!;

    await (edit as any).execute(
      'call-edit',
      {
        path,
        edits: [{ oldText: 'after-authorization', newText: 'new' }],
      },
      undefined,
      undefined,
      toolCtx,
    );

    expect(h.requests.map((request) => request.toolName)).toEqual(['read', 'edit']);
    expect(h.requests[0]).toEqual(expect.objectContaining({
      toolName: 'read',
      toolCallId: 'call-edit',
      args: { path },
    }));
    expect(h.requests[1].args).toEqual({ path, content: 'new' });
  });

  it('does not expose oldText matches through a protected hard-link alias', async () => {
    const h = harness();
    const reserved = join(h.context.workspaceRoot, '.sparkii');
    const protectedFile = join(reserved, 'memory.json');
    const alias = join(h.context.workspaceRoot, 'memory-alias.json');
    await mkdir(reserved);
    await writeFile(protectedFile, '{"secret":"protected-value"}');
    await link(protectedFile, alias);
    h.requestAction.mockImplementation(async (request: RuntimeActionRequest) => {
      h.requests.push(request);
      return {
        requestId: request.requestId,
        status: 'denied',
        decision: {
          decision: 'deny' as const,
          ruleId: 'platform.trust-anchor',
          reason: 'protected alias',
        },
      };
    });
    const edit = createCodingToolDefinitions(h.context)
      .find((definition) => definition.name === 'edit')!;
    const attempt = (oldText: string) => (edit as any).execute(
      'call-alias',
      { path: alias, edits: [{ oldText, newText: 'changed' }] },
      undefined,
      undefined,
      toolCtx,
    );

    await expect(attempt('protected-value')).rejects.toThrow('未执行:denied');
    await expect(attempt('not-in-the-file')).rejects.toThrow('未执行:denied');
    expect(h.requests.map((request) => request.toolName)).toEqual(['read', 'read']);
    expect(await readFile(protectedFile, 'utf8')).toBe('{"secret":"protected-value"}');
  });

  it('rejects a hard-linked source after read authorization without matching it', async () => {
    const h = harness();
    const source = join(h.context.workspaceRoot, 'source.txt');
    const alias = join(h.context.workspaceRoot, 'alias.txt');
    await writeFile(source, 'protected-value');
    await link(source, alias);
    const edit = createCodingToolDefinitions(h.context)
      .find((definition) => definition.name === 'edit')!;

    await expect((edit as any).execute(
      'call-hardlink',
      { path: alias, edits: [{ oldText: 'protected-value', newText: 'changed' }] },
      undefined,
      undefined,
      toolCtx,
    )).rejects.toThrow(/hard-linked/);
    expect(h.requests.map((request) => request.toolName)).toEqual(['read']);
    expect(await readFile(source, 'utf8')).toBe('protected-value');
  });

  it('blocks writes outside the workspace before requesting an action', async () => {
    const h = harness();
    const write = createCodingToolDefinitions(h.context)
      .find((definition) => definition.name === 'write')!;
    await expect((write as any).execute(
      'call-outside',
      { path: join(tmpdir(), 'outside.txt'), content: 'x' },
      undefined,
      undefined,
      toolCtx,
    )).rejects.toThrow(/不在工作区/);
    expect(h.requestAction).not.toHaveBeenCalled();
  });

  it('resolves relative paths against the workspace, not the process anchor', async () => {
    const h = harness();
    const write = createCodingToolDefinitions(h.context)
      .find((definition) => definition.name === 'write')!;
    await (write as any).execute(
      'call-relative',
      { path: 'src/a.txt', content: 'x' },
      undefined,
      undefined,
      toolCtx,
    );
    expect(h.requestAction).toHaveBeenCalledWith(expect.objectContaining({
      args: {
        path: join(h.context.workspaceRoot, 'src', 'a.txt'),
        content: 'x',
      },
    }));
  });

  it('fails closed when Main denies the action', async () => {
    const h = harness();
    h.requestAction.mockResolvedValueOnce({
      requestId: 'denied',
      status: 'denied',
      decision: {
        decision: 'deny',
        ruleId: 'platform.critical-target',
        reason: 'critical',
      },
    });
    const write = createCodingToolDefinitions(h.context)
      .find((definition) => definition.name === 'write')!;
    await expect((write as any).execute(
      'call-denied',
      { path: join(h.context.workspaceRoot, 'a.txt'), content: 'x' },
      undefined,
      undefined,
      toolCtx,
    )).rejects.toThrow(/未执行/);
    expect(h.records).toEqual([]);
  });
});
