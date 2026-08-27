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
