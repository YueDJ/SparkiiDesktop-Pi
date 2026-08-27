import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { writePiModelsConfig } from '../electron/main/pi-model-config.js';

describe('pi-model-config', () => {
  it('writes only custom providers to models.json without builtin ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-model-'));
    await writePiModelsConfig(dir, [
      { id: 'ollama', name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions' },
      { id: 'claude-compat', name: 'Claude 兼容', baseUrl: 'https://x', api: 'anthropic-messages' },
    ]);
    const cfg = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'));
    expect(cfg.providers).toEqual({
      ollama: { baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions' },
      'claude-compat': { baseUrl: 'https://x', api: 'anthropic-messages' },
    });
    expect(cfg.providers.deepseek).toBeUndefined();
  });
});
