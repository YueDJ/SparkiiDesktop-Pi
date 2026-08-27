import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('provider settings smoke', async () => {
  test.setTimeout(120_000);
  const dataDir = mkdtempSync(join(tmpdir(), 'provider-data-'));
  writeFileSync(
    join(dataDir, 'settings.json'),
    JSON.stringify({
      activeProviderId: 'deepseek',
      providers: [
        { id: 'ollama', name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions' },
      ],
    }),
  );

  const app = await electron.launch({
    args: ['dist-electron/main/index.js'],
    env: { ...process.env, SPARKII_DATA_DIR: dataDir },
  });
  const page = await app.firstWindow();
  await page.getByTitle('设置').click();

  const providerSelect = page.getByTestId('provider-select');
  const apiKeyInput = page.getByTestId('api-key-input');
  const baseUrlInput = page.getByTestId('base-url-input');

  await expect(providerSelect).toBeVisible();
  await expect(providerSelect).toHaveValue('deepseek');
  await expect(baseUrlInput).not.toBeVisible();

  await apiKeyInput.fill('sk-test-123');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('设置已保存')).toBeVisible();

  await providerSelect.selectOption('ollama');
  await expect(baseUrlInput).toHaveValue('http://127.0.0.1:11434/v1');
  await expect(apiKeyInput).toHaveValue('');

  await providerSelect.selectOption('deepseek');
  await expect(baseUrlInput).not.toBeVisible();
  await expect(apiKeyInput).toHaveValue('sk-test-123');

  await app.close();
});
