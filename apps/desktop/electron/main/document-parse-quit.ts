import { getDocumentParseSupervisor } from './document-parse-supervisor.js';

export type DocumentParseQuitApp = {
  on(event: 'before-quit', listener: (event: { preventDefault: () => void }) => void): unknown;
  quit(): void;
};

/**
 * 第三参 shouldBypass 供升级关机（isUpdating）使用：为真时直接放行，
 * 不 preventDefault()、不二次 quit()，让主 Agent 的 app.quit() 真正退出（§7.7 步骤 1）。
 * 前两参与既有调用/测试完全兼容。
 */
export function installDocumentParseQuitHook(
  app: DocumentParseQuitApp,
  getSupervisor: () => { beginQuit: () => Promise<void> } = getDocumentParseSupervisor,
  shouldBypass?: () => boolean,
): void {
  let quitting = false;
  app.on('before-quit', (e) => {
    if (shouldBypass?.()) return;
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    void getSupervisor().beginQuit().finally(() => app.quit());
  });
}
