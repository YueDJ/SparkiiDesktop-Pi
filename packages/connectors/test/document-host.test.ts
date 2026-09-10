import { describe, it, expect } from 'vitest';
import { documentConnector } from '../src/document/index.js';

describe('document.read host (task 1)', () => {
  it('does not yet declare host main — chat still runs the child handler', () => {
    const tool = documentConnector.tools.find((t) => t.name === 'document.read')!;
    expect(tool.host).not.toBe('main');
    expect(tool.sideEffect).toBe('read');
  });
});
