import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('general agent surface smoke', async () => {
  test.setTimeout(120_000);
  const dataDir = mkdtempSync(join(tmpdir(), 'general-data-'));
  const app = await electron.launch({
    args: ['dist-electron/main/index.js'],
    env: { ...process.env, SPARKII_DATA_DIR: dataDir },
  });
  const page = await app.firstWindow();
  await page.getByTestId('agent-nav-general').click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await expect(page.getByTestId('workspace-path')).toContainText(/Sparkii/);
  await expect(page.getByRole('button', { name: 'Ask' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Auto review' })).toBeVisible();
  await expect(page.getByText(/Host Git Bash/)).toBeVisible();
  await expect(page.getByText(/Full access/i)).toHaveCount(0);
  await app.close();
});
