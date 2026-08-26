import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { providerIdForLabel, writePiModelsConfig } from '../electron/main/pi-model-config.js';

describe('pi-model-config', () => {
  it('maps provider labels to pi provider ids', () => {
    expect(providerIdForLabel('DeepSeek')).toBe('deepseek');
    expect(providerIdForLabel('本地 Ollama')).toBe('ollama');
    expect(providerIdForLabel('未知服务商')).toBe('openai-compat');
  });

  it('writes models.json with provider baseUrl and api', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-model-'));
    await writePiModelsConfig(dir, 'deepseek', 'https://api.deepseek.com/v1');
    const cfg = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'));
    expect(cfg.providers.deepseek).toEqual({ baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions' });
  });
});
