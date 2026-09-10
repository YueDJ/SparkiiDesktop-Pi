import { describe, it, expect } from 'vitest';
import { documentConnector } from '../src/document/index.js';

describe('document.read host', () => {
  it('declares host main and stubs the child handler', async () => {
    const tool = documentConnector.tools.find((t) => t.name === 'document.read')!;
    expect(tool.host).toBe('main');
    expect(tool.sideEffect).toBe('read');
    const result = await tool.handler({}, { profileId: 'p', sessionId: 's', actor: 'u', requestId: 'r' });
    expect(result).toEqual({
      ok: false,
      error: { code: 'CONNECTOR_DENIED', message: 'document.read must run on main' },
    });
  });
});
