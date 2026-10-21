import { mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
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

  it('sends bash as a raw Runtime action and streams Main output', async () => {
    const h = harness();
    const bash = createCodingToolDefinitions(h.context)
      .find((definition) => definition.name === 'bash')!;
    const result = await (bash as any).execute(
      'call-1',
      { command: 'printf hello' },
      undefined,
      () => {},
      toolCtx,
    );

    expect(h.requestAction).toHaveBeenCalledWith({
      requestId: expect.any(String),
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'printf hello' },
    });
    expect((result as any).content?.[0]?.text).toContain('ok');
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
    expect(h.records).toEqual([]);
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
