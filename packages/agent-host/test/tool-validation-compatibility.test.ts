import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createReadToolDefinition,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { validateToolArguments, type Tool, type ToolCall } from '@earendil-works/pi-ai';
import { jsonSchemaToTypeBox } from '../src/bridge/typebox.js';
import { buildPiRuntimeTools } from '../src/pi-runtime-tools.js';
import { createDeleteToolDefinition } from '../src/workspace-tools.js';

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { type: 'toolCall', id: `call-${name}`, name, arguments: args };
}

function asTool(definition: ToolDefinition, description = 'test tool'): Tool {
  return {
    name: definition.name,
    description,
    parameters: definition.parameters,
  };
}

describe('Pi 1.5 tool argument validation compatibility', () => {
  it('validates required and additional properties through pi-schema', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-schema-workspace-'));
    const deleteTool = asTool(createDeleteToolDefinition({
      cwd: root,
      workspaceRoot: root,
      requestAction: vi.fn(),
    }));

    expect(() => validateToolArguments(deleteTool, toolCall('delete', {})))
      .toThrow(/path: missing/i);
    expect(() => validateToolArguments(deleteTool, toolCall('delete', { path: 'a', extra: true })))
      .toThrow(/extra: unknown field/i);
    expect(validateToolArguments(deleteTool, toolCall('delete', { path: 'a' })))
      .toEqual({ path: 'a' });
  });

  it('keeps built-in tool parameters valid', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-schema-read-'));
    const readTool = asTool(createReadToolDefinition(root, { autoResizeImages: false }));
    expect(validateToolArguments(readTool, toolCall('read', { path: 'a.txt' })))
      .toMatchObject({ path: 'a.txt' });
  });

  it('coerces converted connector arguments before the proposal payload is validated', async () => {
    const propose = vi.fn(async (request: { requestId: string }) => ({
      approved: false,
      proposalId: request.requestId,
      status: 'denied',
    }));
    const connectorTool = {
      name: 'report.export',
      description: 'export report',
      sideEffect: 'write' as const,
      params: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 10, description: 'max rows' },
          tags: { type: 'array', items: { type: 'string' }, description: 'tags' },
        },
        required: ['limit', 'tags'],
        additionalProperties: false,
      },
      handler: vi.fn(),
    };
    const [converted] = buildPiRuntimeTools({ tools: [connectorTool], propose });

    expect(converted.parameters).toMatchObject({
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'max rows' },
        tags: { type: 'array', items: { type: 'string' }, description: 'tags' },
      },
      additionalProperties: false,
    });

    const validated = validateToolArguments(converted as Tool, toolCall('report_export', {
      limit: '5',
      tags: 'one',
    }));
    expect(validated).toEqual({ limit: 5, tags: ['one'] });
    expect(() => validateToolArguments(converted as Tool, toolCall('report_export', {
      limit: '5',
      tags: ['one'],
      extra: true,
    }))).toThrow(/extra: unknown field/i);

    await converted.execute('call-report', validated);
    expect(propose).toHaveBeenCalledWith(expect.objectContaining({
      payload: { limit: 5, tags: ['one'] },
    }));
  });

  it('preserves integer conversion in the schema bridge', () => {
    expect(jsonSchemaToTypeBox({ type: 'integer', minimum: 1 })).toEqual({
      type: 'integer',
      minimum: 1,
    });
  });
});
