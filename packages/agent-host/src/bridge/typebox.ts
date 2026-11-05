import type { JSONSchema } from '@sparkii/connectors';

export function connectorId(toolName: string): string { return toolName.split('.')[0]; }

function copyScalarKeywords(schema: JSONSchema): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['description', 'default', 'minimum', 'maximum']) {
    if (schema[key] !== undefined) result[key] = schema[key];
  }
  return result;
}

export function jsonSchemaToTypeBox(schema: JSONSchema): unknown {
  // Produce plain JSON Schema nodes (TypeBox-compatible shape) that model
  // APIs accept as tool parameter schemas (type must be present and non-null).
  const t = schema.type;
  const common = copyScalarKeywords(schema);
  if (t === 'string') return schema.enum ? { type: 'string', enum: schema.enum, ...common } : { type: 'string', ...common };
  if (t === 'number' || t === 'integer') return { type: t, ...common };
  if (t === 'boolean') return { type: 'boolean', ...common };
  if (t === 'array') {
    return {
      type: 'array',
      items: jsonSchemaToTypeBox((schema.items ?? { type: 'string' }) as JSONSchema),
      ...common,
    };
  }
  if (t === 'object') {
    const props = Object.fromEntries(Object.entries((schema.properties ?? {}) as Record<string, JSONSchema>).map(([k, v]) => [k, jsonSchemaToTypeBox(v)]));
    return {
      type: 'object',
      properties: props,
      required: schema.required ?? Object.keys(props),
      ...(schema.additionalProperties !== undefined ? { additionalProperties: schema.additionalProperties } : {}),
      ...common,
    };
  }
  throw new Error(`unsupported JSON schema type: ${String(t)}`);
}
