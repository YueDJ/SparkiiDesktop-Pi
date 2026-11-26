import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const evidenceDir = process.env.SPARKII_UI_PROBE_EVIDENCE_DIR
  ? resolve(process.env.SPARKII_UI_PROBE_EVIDENCE_DIR)
  : fileURLToPath(new URL('.', import.meta.url));
const appDir = fileURLToPath(new URL('../../../apps/desktop/', import.meta.url));
const require = createRequire(join(appDir, 'package.json'));
const { build } = require('esbuild');
const { chromium } = await import(new URL('../../../apps/desktop/node_modules/@playwright/test/index.mjs', import.meta.url));

const temp = mkdtempSync(join(tmpdir(), 'sparkii-memory-ui-'));
const entry = join(temp, 'probe.tsx');
const bundle = join(temp, 'probe.js');
const css = join(temp, 'probe.css');

writeFileSync(entry, `
import { createRoot } from 'react-dom/client';
import { SettingsView } from ${JSON.stringify(join(appDir, 'src/shell/SettingsView.tsx'))};
import '@sparkii/ui/styles.css';
import ${JSON.stringify(join(appDir, 'src/styles.css'))};

const settings = {
  enabled: true, autoExtract: true, idleConsolidation: true,
  halfLifeDays: { user: 180, agent: 90, project: 60, episode: 14 },
  budgets: { user: 500, agent: 300, project: 800 },
  extractionDebounceMs: 90000, minUserTurns: 3,
  consolidateIdleMinutes: 10, consolidateIntervalHours: 24,
};
window.__repairCalls = [];
const scopes = ['/ws/a', '/ws/b'].map((workspacePath, index) => ({
  scope: 'project:proj_' + index, kind: 'project', label: '项目 ' + (index === 0 ? 'A' : 'B'),
  projectId: 'proj_' + index, workspacePath, corrupt: true, entries: [],
}));
const api = {
  getSettings: async () => ({}),
  listProviders: async () => [],
  getAppVersion: async () => '0.1.7',
  listAgents: async () => [{ id: 'general', name: '通用' }],
  listMemories: async () => ({
    scopes, pending: [], agents: [{ id: 'general', name: '通用' }], projects: [],
    settings, ftsAvailable: true, warnings: [],
  }),
  saveMemorySettings: async (partial) => ({ ...settings, ...partial }),
  addMemory: async () => ({}), updateMemory: async () => ({}), deleteMemory: async () => ({ ok: true }),
  resolvePending: async () => ({ ok: true }), archiveProject: async () => ({ ok: true }),
  rebuildMemoryIndex: async () => ({ entries: 0, corrupt: [] }), searchMemory: async () => [],
  repairProjectMemory: async (...args) => { window.__repairCalls.push(args); return { ok: true }; },
  on: () => () => {},
};
createRoot(document.getElementById('root')!).render(<SettingsView api={api as never} initialPane="memory" />);
`);

await build({
  entryPoints: [entry], bundle: true, outfile: bundle, platform: 'browser', format: 'esm',
  jsx: 'automatic', loader: { '.css': 'css' }, absWorkingDir: appDir,
  nodePaths: [join(appDir, 'node_modules')], logLevel: 'silent',
});

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Memory settings probe</title><link rel="stylesheet" href="/probe.css"></head><body><div id="root"></div><script type="module" src="/probe.js"></script></body></html>`;
writeFileSync(join(temp, 'index.html'), html);

const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const name = req.url === '/' ? 'index.html' : req.url.slice(1);
  if (!['index.html', 'probe.js', 'probe.css'].includes(name)) { res.writeHead(404); res.end(); return; }
  const body = readFileSync(join(temp, name));
  const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html';
  res.writeHead(200, { 'content-type': type }); res.end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const consoleMessages = [];
const badNetwork = [];
let browser;
try {
  browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) consoleMessages.push({ type: message.type(), text: message.text() });
  });
  page.on('pageerror', (error) => consoleMessages.push({ type: 'pageerror', text: error.message }));
  page.on('response', (response) => {
    if (response.status() >= 400) badNetwork.push({ url: response.url(), status: response.status() });
  });
  page.on('requestfailed', (request) => badNetwork.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.getByText('该项目的记忆内容无法读取，已暂停使用。确认后可重新整理。').first().waitFor();
  const warnings = await page.getByText('该项目的记忆内容无法读取，已暂停使用。确认后可重新整理。').count();
  await page.screenshot({ path: join(evidenceDir, 'ui-memory-initial.png'), fullPage: true });

  const repairAreas = page.getByLabel('修复内容');
  const replacementDialogs = [];
  await repairAreas.nth(1).fill('B 项目的修复内容');
  page.once('dialog', async (dialog) => {
    replacementDialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await page.getByRole('button', { name: '按提供内容修复' }).nth(1).click();
  const callsAfterReplaceDismiss = await page.evaluate(() => window.__repairCalls);

  await repairAreas.nth(0).fill('A 项目的修复草稿');
  await page.screenshot({ path: join(evidenceDir, 'ui-memory-isolated-repair.png'), fullPage: true });
  page.once('dialog', async (dialog) => {
    replacementDialogs.push(dialog.message());
    await dialog.accept();
  });
  await page.getByRole('button', { name: '按提供内容修复' }).nth(0).click();
  await page.waitForFunction(() => window.__repairCalls.length === 1);
  await page.getByText('已按提供内容修复').waitFor();
  const repairCalls = await page.evaluate(() => window.__repairCalls);
  const repairValues = await repairAreas.evaluateAll((areas) => areas.map((area) => area.value));

  const destructiveDialogs = [];
  page.once('dialog', async (dialog) => {
    destructiveDialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await page.getByRole('button', { name: '重新整理' }).first().click();
  const callsAfterDismiss = await page.evaluate(() => window.__repairCalls);
  const result = {
    url, viewport: { width: 1440, height: 1000 }, warnings,
    repairCallsAfterReplaceDismiss: callsAfterReplaceDismiss,
    repairCalls, callsAfterDismiss, repairValues,
    replacementDialogs, destructiveDialogs,
    replacementConfirmationDismissed: callsAfterReplaceDismiss.length === 0
      && replacementDialogs.length >= 1 && replacementDialogs[0].includes('覆盖'),
    replacementConfirmationAccepted: repairCalls.length === 1
      && repairCalls[0][0] === '/ws/a' && repairCalls[0][1] === 'replace'
      && repairCalls[0][2] === 'A 项目的修复草稿'
      && replacementDialogs.length >= 2 && replacementDialogs[1].includes('覆盖'),
    destructiveConfirmationDismissed: callsAfterDismiss.length === repairCalls.length
      && destructiveDialogs.length === 1,
    projectDraftsIsolated: repairValues[0] === 'A 项目的修复草稿' && repairValues[1] === 'B 项目的修复内容',
    consoleMessages, badNetwork,
  };
  writeFileSync(join(evidenceDir, 'ui-probe-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (warnings !== 2 || !result.replacementConfirmationDismissed || !result.replacementConfirmationAccepted
    || !result.destructiveConfirmationDismissed || !result.projectDraftsIsolated || consoleMessages.length || badNetwork.length) process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(temp, { recursive: true, force: true });
}
