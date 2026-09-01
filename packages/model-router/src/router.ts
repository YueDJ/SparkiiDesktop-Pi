import type { ModelCapability, ModelDescriptor, ModelRequirement, ModelTask, ModelTarget } from './types.js';

export function normalizeRouting(raw: Record<string, ModelTarget[]>): Record<ModelTask, ModelTarget[]> {
  const out = { default: raw.default ?? [], chat: [], extract: [], report: [], coding: [], title: [] } as Record<ModelTask, ModelTarget[]>;
  for (const key of ['chat', 'extract', 'report', 'coding', 'title'] as const) {
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

export function findCompatibleModels(
  models: ModelDescriptor[],
  requirement: ModelRequirement,
): ModelDescriptor[] {
  return models.filter((model) =>
    requirement.requires.every((capability) =>
      model.capabilities.includes(capability as ModelCapability),
    ),
  );
}

export function recommendModel(
  models: ModelDescriptor[],
  requirement: ModelRequirement,
  preferredKey?: string | null,
): ModelDescriptor | null {
  if (preferredKey) {
    const preferred = models.find(
      (model) => `${model.provider}/${model.modelId}` === preferredKey,
    );
    if (
      preferred &&
      requirement.requires.every((capability) =>
        preferred.capabilities.includes(capability as ModelCapability),
      )
    ) {
      return preferred;
    }
  }
  return findCompatibleModels(models, requirement)[0] ?? null;
}
