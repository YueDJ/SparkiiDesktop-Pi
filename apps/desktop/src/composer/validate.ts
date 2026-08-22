import type { PageSchema } from '@sparkii/config';
import { widgetRegistry } from './registry.js';

export function validatePageSchema(schema: PageSchema): { ok: true } | { ok: false; error: string } {
  const widgets = (schema.widgets as Array<{ id?: string; type?: string; bind?: string }>) ?? [];
  for (const w of widgets) {
    if (!w.type || !(w.type in widgetRegistry)) return { ok: false, error: `unknown widget: ${w.type}` };
    if (w.bind && !/^(documents|workflow|chat)(\.[a-zA-Z0-9_]+)*$/.test(w.bind)) return { ok: false, error: `invalid bind: ${w.bind}` };
  }
  return { ok: true };
}
