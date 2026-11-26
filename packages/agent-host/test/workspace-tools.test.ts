import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeActionRequest } from '../src/runtime-actions.js';
import {
  createDeleteToolDefinition,
  createMoveToolDefinition,
} from '../src/workspace-tools.js';

function allow(request: RuntimeActionRequest) {
  return {
    requestId: request.requestId,
    status: 'executed' as const,
    decision: {
      decision: 'allow' as const,
      ruleId: 'workspace.write',
      reason: 'workspace',
    },
    result: { path: request.args.path ?? request.args.to },
  };
}

function harness() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'ws-tools-'));
  const requestAction = vi.fn(async (request: RuntimeActionRequest) => allow(request));
  return { workspaceRoot, requestAction };
}

const toolCtx = {
  sessionManager: {
    getSessionId: () => 's1',
    getSessionFile: () => null,
  },
};

describe('workspace tools', () => {
  it('declares structured delete and move schemas', () => {
    const h = harness();
    const del = createDeleteToolDefinition({
      cwd: h.workspaceRoot,
      workspaceRoot: h.workspaceRoot,
      requestAction: h.requestAction,
    });
    const move = createMoveToolDefinition({
      cwd: h.workspaceRoot,
      workspaceRoot: h.workspaceRoot,
      requestAction: h.requestAction,
    });
    expect(del).toMatchObject({
      name: 'delete',
      parameters: {
        type: 'object',
        required: ['path'],
        additionalProperties: false,
      },
    });
    expect(move).toMatchObject({
      name: 'move',
      parameters: {
        type: 'object',
        required: ['from', 'to'],
        additionalProperties: false,
      },
    });
  });

  it('sends delete as a Runtime Action with a workspace-relative target', async () => {
    const h = harness();
    const tool = createDeleteToolDefinition({
      cwd: h.workspaceRoot,
      workspaceRoot: h.workspaceRoot,
      requestAction: h.requestAction,
    });
    await (tool as any).execute(
      'call-delete',
      { path: 'generated' },
      undefined,
      () => {},
      toolCtx,
    );
    expect(h.requestAction).toHaveBeenCalledWith({
      requestId: expect.any(String),
      toolCallId: 'call-delete',
      toolName: 'delete',
      args: { path: join(h.workspaceRoot, 'generated') },
    });
  });

  it('sends move source and destination without trusting a Runtime scope', async () => {
    const h = harness();
    const tool = createMoveToolDefinition({
      cwd: h.workspaceRoot,
      workspaceRoot: h.workspaceRoot,
      requestAction: h.requestAction,
    });
    await (tool as any).execute(
      'call-move',
      { from: 'a.txt', to: 'src/b.txt' },
      undefined,
      () => {},
      toolCtx,
    );
    expect(h.requestAction).toHaveBeenCalledWith({
      requestId: expect.any(String),
      toolCallId: 'call-move',
      toolName: 'move',
      args: {
        from: join(h.workspaceRoot, 'a.txt'),
        to: join(h.workspaceRoot, 'src', 'b.txt'),
      },
    });
  });

  it.each(['delete', 'move'] as const)('%s rejects a recursive target containing .sparkii before Main is called', async (name) => {
    const h = harness();
    const source = join(h.workspaceRoot, 'src');
    mkdirSync(join(source, '.sparkii'), { recursive: true });
    writeFileSync(join(source, '.sparkii', 'memory.json'), 'retained-content');
    writeFileSync(join(source, 'app.ts'), 'ordinary');
    const tool = name === 'delete'
      ? createDeleteToolDefinition({ cwd: h.workspaceRoot, workspaceRoot: h.workspaceRoot, requestAction: h.requestAction })
      : createMoveToolDefinition({ cwd: h.workspaceRoot, workspaceRoot: h.workspaceRoot, requestAction: h.requestAction });

    await expect((tool as any).execute(
      `call-${name}`,
      name === 'delete' ? { path: 'src' } : { from: 'src', to: 'renamed' },
      undefined,
      () => {},
      toolCtx,
    )).rejects.toThrow(/\.sparkii 是平台保留目录/);
    expect(h.requestAction).not.toHaveBeenCalled();
  });

  it('rejects paths outside the workspace before Main is called', async () => {
    const h = harness();
    const tool = createDeleteToolDefinition({
      cwd: h.workspaceRoot,
      workspaceRoot: h.workspaceRoot,
      requestAction: h.requestAction,
    });
    await expect((tool as any).execute(
      'call-outside',
      { path: join(tmpdir(), 'outside.txt') },
      undefined,
      () => {},
      toolCtx,
    )).rejects.toThrow(/不在工作区/);
    expect(h.requestAction).not.toHaveBeenCalled();
  });
});
