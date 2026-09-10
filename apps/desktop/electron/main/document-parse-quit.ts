import { getDocumentParseSupervisor } from './document-parse-supervisor.js';

export type DocumentParseQuitApp = {
  on(event: 'before-quit', listener: (event: { preventDefault: () => void }) => void): unknown;
  quit(): void;
};

export function installDocumentParseQuitHook(
  app: DocumentParseQuitApp,
  getSupervisor: () => { beginQuit: () => Promise<void> } = getDocumentParseSupervisor,
): void {
  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    void getSupervisor().beginQuit().finally(() => app.quit());
  });
}
