export type ShowSaveDialog = (
  win: unknown,
  opts: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> },
) => Promise<{ canceled: boolean; filePath?: string }>;

export async function resolveExportPath(
  getWindow: () => unknown,
  env: NodeJS.ProcessEnv,
  showSaveDialog: ShowSaveDialog,
): Promise<string | undefined> {
  if (env.SPARKII_E2E_EXPORT_DIR) return `${env.SPARKII_E2E_EXPORT_DIR}/report.docx`;
  const win = getWindow();
  if (!win) return undefined;
  const r = await showSaveDialog(win, { defaultPath: 'report.docx', filters: [{ name: 'Word', extensions: ['docx'] }] });
  return r.canceled || !r.filePath ? undefined : r.filePath;
}
