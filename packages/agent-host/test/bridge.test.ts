import { describe, it, expect } from 'vitest';
import { jsonSchemaToTypeBox, connectorId } from '../src/bridge/typebox.js';

describe('bridge helpers', () => {
  it('maps object/string/enum to typebox-ish nodes', () => {
    expect(jsonSchemaToTypeBox({ type: 'string' })).toMatchObject({ type: 'string' });
    expect(jsonSchemaToTypeBox({ type: 'object', properties: { a: { type: 'string' } } })).toMatchObject({ type: 'object' });
  });
  it('derives connector id from tool name', () => {
    expect(connectorId('report.export')).toBe('report');
  });
});
