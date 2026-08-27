import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CustomProvider } from './provider-catalog.js';

/**
 * 把自定义 provider（baseUrl + api 类型）写进 Pi agentDir 的 models.json。
 * 内置 provider 不落盘；API key 也不落盘，key 由 setRuntimeApiKey 注入。
 */
export async function writePiModelsConfig(
  piAgentDir: string,
  providers: CustomProvider[],
): Promise<void> {
  const config = {
    providers: Object.fromEntries(
      providers.map((p) => [p.id, { baseUrl: p.baseUrl, api: p.api }]),
    ),
  };
  await mkdir(piAgentDir, { recursive: true });
  await writeFile(join(piAgentDir, 'models.json'), JSON.stringify(config, null, 2), 'utf8');
}
