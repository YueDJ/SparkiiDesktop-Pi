import { describe, it, expect } from "vitest";
import type { PiProviderInfo } from "@sparkii/agent-host";
import { buildProviderList } from "../electron/main/provider-catalog.js";

describe("provider catalog", () => {
  it("merges builtin whitelist with custom providers and excludes non-whitelisted builtins", () => {
    const runtimeProviders: PiProviderInfo[] = [
      { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKeyAuth: true, oauthAuth: false },
      { id: "google", name: "Google", baseUrl: "https://generativelanguage.googleapis.com", apiKeyAuth: true, oauthAuth: true },
    ];
    const result = buildProviderList(runtimeProviders, [
      { id: "ollama", name: "本地 Ollama", baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions" },
    ]);

    const ids = result.map((p) => p.id);
    expect(ids).toContain("deepseek");
    expect(ids).toContain("ollama");
    expect(ids).not.toContain("google");

    const deepseek = result.find((p) => p.id === "deepseek");
    expect(deepseek?.kind).toBe("builtin");
    expect(deepseek?.baseUrl).toBe("https://api.deepseek.com");
    expect(deepseek?.apiKeyAuth).toBe(true);

    const ollama = result.find((p) => p.id === "ollama");
    expect(ollama?.kind).toBe("custom");
    expect(ollama?.api).toBe("openai-completions");
    expect(ollama?.baseUrl).toBe("http://127.0.0.1:11434/v1");
  });
});
