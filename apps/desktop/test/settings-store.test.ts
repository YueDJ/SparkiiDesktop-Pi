import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, saveSettings } from '../electron/main/settings.js';

let dir = '';
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function makeDir() {
  dir = await mkdtemp(join(tmpdir(), 'sparkii-settings-'));
  return dir;
}

describe('settings store', () => {
  it('returns defaults when no settings file exists', async () => {
    const d = await makeDir();
    expect(await loadSettings(d)).toEqual({});
  });

  it('roundtrips saved settings', async () => {
    const d = await makeDir();
    await saveSettings(d, { provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', maxAgents: 2 });
    const loaded = await loadSettings(d);
    expect(loaded.provider).toBe('DeepSeek');
    expect(loaded.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(loaded.maxAgents).toBe(2);
  });
});
