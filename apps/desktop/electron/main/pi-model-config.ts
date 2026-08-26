import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 设置页的 provider 展示名 → Pi SDK 的 provider id（以及 OpenAI 兼容的 api 类型）。 */
const PROVIDER_CONFIG: Record<string, { id: string; api: string }> = {
  '本地 Ollama': { id: 'ollama', api: 'openai-completions' },
  '本地 vLLM': { id: 'vllm', api: 'openai-completions' },
  '云端 OpenAI 兼容': { id: 'openai-compat', api: 'openai-completions' },
  DeepSeek: { id: 'deepseek', api: 'openai-completions' },
};

export function providerIdForLabel(label: string): string {
  return PROVIDER_CONFIG[label]?.id ?? 'openai-compat';
}

/**
 * 把用户选择的 provider 与 baseUrl 写进 Pi agentDir 的 models.json（ModelConfig 快照），
 * 使子进程里的 ModelRuntime 能识别该 provider 并使用自定义 baseUrl。
 */
export async function writePiModelsConfig(
  piAgentDir: string,
  providerId: string,
  baseUrl: string,
): Promise<void> {
  const api = PROVIDER_CONFIG[Object.keys(PROVIDER_CONFIG).find((k) => PROVIDER_CONFIG[k].id === providerId) ?? '']?.api ?? 'openai-completions';
  const config = { providers: { [providerId]: { baseUrl, api } } };
  await mkdir(piAgentDir, { recursive: true });
  await writeFile(join(piAgentDir, 'models.json'), JSON.stringify(config, null, 2), 'utf8');
}
