import type { ModelTask, ModelTarget } from './types.js';

export function normalizeRouting(raw: Record<string, ModelTarget[]>): Record<ModelTask, ModelTarget[]> {
  const out = { default: raw.default ?? [], chat: [], extract: [], report: [] } as Record<ModelTask, ModelTarget[]>;
  for (const key of ['chat', 'extract', 'report'] as const) {
    out[key] = raw[key] ?? out.default;
  }
  return out;
}

export class ModelRouter {
  constructor(private routing: Record<ModelTask, ModelTarget[]>) {}
  resolve(task: ModelTask, available: (t: ModelTarget) => boolean = () => true): ModelTarget | null {
    const chain = this.routing[task] ?? this.routing.default;
    return chain.find(available) ?? null;
  }
}
