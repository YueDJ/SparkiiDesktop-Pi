import type { PiProviderInfo } from "@sparkii/agent-host";

export const BUILTIN_PROVIDER_IDS: readonly string[] = [
  "openai",
  "anthropic",
  "deepseek",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "moonshotai",
  "moonshotai-cn",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "zai",
  "zai-coding-cn",
  "ant-ling",
];

export type ProviderKind = "builtin" | "custom";

/**
 * 知识后端的凭据 id 是保留名：自定义模型服务商若取同名，`keyFor(id)` 会读到知识凭据
 * （`main` 上原本没有任何保留名机制）。保存自定义服务商时拒绝这两个 id。
 */
export const RESERVED_KNOWLEDGE_PROVIDER_IDS: readonly string[] = ["sparkiirag", "sparkiionto"];

export function isReservedKnowledgeProviderId(id: unknown): boolean {
  const text = String(id ?? "").trim();
  return RESERVED_KNOWLEDGE_PROVIDER_IDS.some((reserved) => text === reserved || text === `apiKey:${reserved}`);
}

/** 返回第一个与知识后端凭据命名冲突的服务商 id（没有则返回 null）。 */
export function findReservedProviderConflict(providers: unknown): string | null {
  if (!Array.isArray(providers)) return null;
  for (const item of providers) {
    const id = (item ?? {}) as { id?: unknown };
    if (isReservedKnowledgeProviderId(id.id)) return String(id.id);
  }
  return null;
}

export type ProviderApi = "openai-completions" | "anthropic-messages";

export interface CustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  api: ProviderApi;
}

export interface ProviderEntry {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKeyAuth: boolean;
  oauthAuth: boolean;
  api?: ProviderApi;
}

export function buildProviderList(
  runtimeProviders: PiProviderInfo[],
  customProviders: CustomProvider[],
): ProviderEntry[] {
  const runtime = new Map(runtimeProviders.map((p) => [p.id, p]));
  const custom = new Map(customProviders.map((p) => [p.id, p]));
  const entries: ProviderEntry[] = [];

  for (const id of BUILTIN_PROVIDER_IDS) {
    if (custom.has(id)) continue;
    const base = runtime.get(id);
    if (!base) continue;
    entries.push({
      id: base.id,
      name: base.name,
      kind: "builtin",
      baseUrl: base.baseUrl,
      apiKeyAuth: base.apiKeyAuth,
      oauthAuth: base.oauthAuth,
    });
  }

  for (const provider of customProviders) {
    entries.push({
      id: provider.id,
      name: provider.name,
      kind: "custom",
      baseUrl: provider.baseUrl,
      apiKeyAuth: false,
      oauthAuth: false,
      api: provider.api,
    });
  }

  return entries;
}
