import { describe, expect, it } from 'vitest';
import {
  actionResultEnvelope,
  runtimeActionEnvelope,
  type ActionExecutionResult,
  type RuntimeActionRequest,
} from '../src/index.js';

const request: RuntimeActionRequest = {
  requestId: 'r1',
  toolCallId: 'call-1',
  toolName: 'write',
  args: { path: 'C:/ws/a.txt', content: 'x' },
};

describe('runtime action transport', () => {
  it('carries tool intent without any authorization fields', () => {
    expect(runtimeActionEnvelope(request)).toEqual({
      direction: 'runtime-to-main',
      action: request,
    });
    expect(request).not.toHaveProperty('risk');
    expect(request).not.toHaveProperty('summary');
    expect(request).not.toHaveProperty('resources');
    expect(request).not.toHaveProperty('capability');
  });

  it('returns Main decisions through a correlated result envelope', () => {
    const result: ActionExecutionResult = {
      requestId: 'r1',
      status: 'executed',
      decision: {
        decision: 'allow',
        ruleId: 'workspace.write',
        reason: '工作区内文件修改',
      },
      result: { path: 'C:/ws/a.txt' },
    };
    expect(actionResultEnvelope('r1', result)).toEqual({
      direction: 'main-to-runtime',
      requestId: 'r1',
      actionResult: result,
    });
  });

  it('rejects empty correlation identifiers at envelope construction', () => {
    expect(() => runtimeActionEnvelope({ ...request, requestId: '' })).toThrow(/requestId/);
  });
});
