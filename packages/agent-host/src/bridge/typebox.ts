import type { JSONSchema } from '@sparkii/connectors';

export function connectorId(toolName: string): string { return toolName.split('.')[0]; }

export function jsonSchemaToTypeBox(schema: JSONSchema): unknown {
  // Produce plain JSON Schema nodes (TypeBox-compatible shape) that model
  // APIs accept as tool parameter schemas (type must be present and non-null).
  const t = schema.type;
  if (t === 'string') return schema.enum ? { type: 'string', enum: schema.enum } : { type: 'string' };
  if (t === 'number' || t === 'integer') return { type: 'number' };
  if (t === 'boolean') return { type: 'boolean' };
  if (t === 'array') return { type: 'array', items: jsonSchemaToTypeBox((schema.items ?? { type: 'string' }) as JSONSchema) };
  if (t === 'object') {
    const props = Object.fromEntries(Object.entries((schema.properties ?? {}) as Record<string, JSONSchema>).map(([k, v]) => [k, jsonSchemaToTypeBox(v)]));
    return { type: 'object', properties: props, required: schema.required ?? Object.keys(props) };
  }
  throw new Error(`unsupported JSON schema type: ${String(t)}`);
}
