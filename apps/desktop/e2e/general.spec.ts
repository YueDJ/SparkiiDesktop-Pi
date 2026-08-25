import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('general agent surface smoke', async () => {
  test.setTimeout(120_000);
  const dataDir = mkdtempSync(join(tmpdir(), 'general-data-'));
  const app = await electron.launch({
    args: ['dist-electron/main/index.js'],
    env: { ...process.env, SPARKII_DATA_DIR: dataDir },
  });
  const page = await app.firstWindow();
  await page.getByPlaceholder('用户名').fill('admin');
  await page.getByPlaceholder('密码').fill('admin123');
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByTestId('agent-card-general').click();
  await page.getByText('新建会话').click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await expect(page.getByTestId('workspace-path')).toContainText(/Sparkii/);
  await app.close();
});
