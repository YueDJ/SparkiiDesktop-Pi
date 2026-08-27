import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test.skip(process.env.SPARKII_SKIP_LLM === '1');

test('contract review pilot acceptance', async () => {
  // The full contract-review flow runs live model calls plus a 120s approval
  // wait, so the default 30s test timeout is not enough.
  test.setTimeout(360_000);
  const fixture = join(mkdtempSync(join(tmpdir(), 'pilot-')), 'contract.txt');
  writeFileSync(fixture, '合同标的：设备采购。付款：验收后 30 日。违约责任：逾期按日万分之五。');
  const dataDir = mkdtempSync(join(tmpdir(), 'pilot-data-'));
  const exportDir = mkdtempSync(join(tmpdir(), 'pilot-export-'));
  const app = await electron.launch({
    args: ['dist-electron/main/index.js'],
    env: {
      ...process.env,
      SPARKII_PROFILE_DIR: join(repoRoot, 'profiles/contract-review'),
      SPARKII_DATA_DIR: dataDir,
      SPARKII_E2E_DOCUMENT: fixture,
      SPARKII_E2E_EXPORT_DIR: exportDir,
    },
  });
  const page = await app.firstWindow();
  await page.getByTestId('agent-card-contract').click();
  await page.getByTestId('upload').click();
  await page.getByTestId('review').click();
  // 新提案到达时自动弹出审批详情(高风险为模态,写操作为右侧面板)
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 300000 });
  await page.getByRole('button', { name: '批准' }).click();
  // 底部状态栏常驻显示一句话状态,含"审核完成"
  await expect(page.getByText(/审核完成/)).toBeVisible({ timeout: 300000 });
  // 审计移入独立页面:批准后进入审计时间线查看留痕
  await page.getByRole('button', { name: '审计' }).click();
  await expect(page.getByText(/proposal.approved/)).toBeVisible();
  await app.close();
});
