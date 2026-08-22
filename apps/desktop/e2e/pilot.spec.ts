import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.skip(process.env.SPARKII_SKIP_LLM === '1');

test('contract review pilot acceptance', async () => {
  const fixture = join(mkdtempSync(join(tmpdir(), 'pilot-')), 'contract.txt');
  writeFileSync(fixture, '合同标的：设备采购。付款：验收后 30 日。违约责任：逾期按日万分之五。');
  const dataDir = mkdtempSync(join(tmpdir(), 'pilot-data-'));
  const exportDir = mkdtempSync(join(tmpdir(), 'pilot-export-'));
  const app = await electron.launch({
    args: ['dist-electron/main/index.js'],
    env: {
      ...process.env,
      SPARKII_PROFILE_DIR: 'profiles/contract-review',
      SPARKII_DATA_DIR: dataDir,
      SPARKII_E2E_DOCUMENT: fixture,
      SPARKII_E2E_EXPORT_DIR: exportDir,
    },
  });
  const page = await app.firstWindow();
  await page.getByPlaceholder('用户名').fill('admin');
  await page.getByPlaceholder('密码').fill('admin123');
  await page.getByText('登录').click();
  await page.getByTestId('upload').click();
  await page.getByTestId('review').click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 120000 });
  await page.getByRole('button', { name: '批准' }).click();
  await expect(page.getByText(/proposal.approved/)).toBeVisible();
  await app.close();
});
