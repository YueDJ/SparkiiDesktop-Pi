import type { JSONSchema } from '@sparkii/connectors';

export function connectorId(toolName: string): string { return toolName.split('.')[0]; }

export function jsonSchemaToTypeBox(schema: JSONSchema): unknown {
  // 本函数不 import typebox，产出与 Type.Object 等价的描述对象，供 registerTool 的运行时适配
  const t = schema.type;
  if (t === 'string') return { kind: 'string', enum: schema.enum };
  if (t === 'number' || t === 'integer') return { kind: 'number' };
  if (t === 'boolean') return { kind: 'boolean' };
  if (t === 'array') return { kind: 'array', items: jsonSchemaToTypeBox((schema.items ?? { type: 'string' }) as JSONSchema) };
  if (t === 'object') {
    const props = Object.fromEntries(Object.entries((schema.properties ?? {}) as Record<string, JSONSchema>).map(([k, v]) => [k, jsonSchemaToTypeBox(v)]));
    return { kind: 'object', properties: props, required: schema.required ?? Object.keys(props) };
  }
  throw new Error(`unsupported JSON schema type: ${String(t)}`);
}
