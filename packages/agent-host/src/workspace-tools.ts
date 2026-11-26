import { randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type {
  ActionExecutionResult,
  RuntimeActionRequest,
} from './runtime-actions.js';
import { isPathInside, isPlatformReservedPath } from './workspace-guard.js';

export interface WorkspaceToolContext {
  cwd: string;
  workspaceRoot: string;
  requestAction(request: RuntimeActionRequest): Promise<ActionExecutionResult>;
}

async function rejectReservedDescendants(absolutePath: string): Promise<void> {
  let info;
  try {
    info = await lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  // Do not follow links. Main separately rejects reparse points during the
  // actual mutation; this preflight fences retained children before approval.
  if (!info.isDirectory() || info.isSymbolicLink()) return;
  for (const entry of await readdir(absolutePath)) {
    const child = join(absolutePath, entry);
    if (isPlatformReservedPath(child)) {
      throw new Error(`拒绝访问:${child} .sparkii 是平台保留目录`);
    }
    await rejectReservedDescendants(child);
  }
}

async function targetPath(ctx: WorkspaceToolContext, value: unknown): Promise<string> {
  const path = String(value ?? '').trim();
  if (!path) throw new Error('路径不能为空');
  const absolute = resolve(ctx.workspaceRoot, path);
  if (!isPathInside(ctx.workspaceRoot, absolute)) {
    throw new Error(`拒绝访问:${path} 不在工作区内`);
  }
  if (isPlatformReservedPath(absolute)) {
    throw new Error(`拒绝访问:${path} .sparkii 是平台保留目录`);
  }
  await rejectReservedDescendants(absolute);
  return absolute;
}

async function executeAction(
  ctx: WorkspaceToolContext,
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; details: unknown }> {
  const result = await ctx.requestAction({
    requestId: randomUUID(),
    toolCallId,
    toolName,
    args,
  });
  if (result.status !== 'executed') {
    const message = result.error?.message ?? result.decision.reason;
    throw new Error(`${toolName}未执行:${result.status}:${message}`);
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result.result ?? { ok: true }) }],
    details: result.result ?? {},
  };
}

export function createDeleteToolDefinition(
  ctx: WorkspaceToolContext,
): ToolDefinition<any, any, any> {
  return {
    name: 'delete',
    label: '删除',
    description: '删除工作区内普通文件或子目录。不能删除 Workspace 根或受保护对象。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区内的相对或绝对路径' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    execute: async (toolCallId: string, params: { path?: unknown }) =>
      executeAction(ctx, toolCallId, 'delete', {
        path: await targetPath(ctx, params?.path),
      }),
  } as ToolDefinition<any, any, any>;
}

export function createMoveToolDefinition(
  ctx: WorkspaceToolContext,
): ToolDefinition<any, any, any> {
  return {
    name: 'move',
    label: '移动',
    description: '移动或重命名工作区内普通文件或子目录。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '工作区内的源路径' },
        to: { type: 'string', description: '工作区内的目标路径' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    execute: async (
      toolCallId: string,
      params: { from?: unknown; to?: unknown },
    ) => executeAction(ctx, toolCallId, 'move', {
      from: await targetPath(ctx, params?.from),
      to: await targetPath(ctx, params?.to),
    }),
  } as ToolDefinition<any, any, any>;
}
