import { describe, it, expect } from 'vitest';
import { validatePageSchema } from '../src/composer/validate.js';

describe('validatePageSchema', () => {
  it('accepts known widgets', () => {
    expect(validatePageSchema({ page: 'home', layout: { type: 'grid', columns: 1 }, widgets: [{ id: 'u', type: 'file-upload', bind: 'documents' }] })).toEqual({ ok: true });
  });
  it('rejects unknown widget type', () => {
    expect(validatePageSchema({ widgets: [{ id: 'x', type: 'evil' }] })).toMatchObject({ ok: false });
  });
  it('rejects code-like bind', () => {
    expect(validatePageSchema({ widgets: [{ id: 'x', type: 'file-upload', bind: 'global.process' }] })).toMatchObject({ ok: false });
  });
});
