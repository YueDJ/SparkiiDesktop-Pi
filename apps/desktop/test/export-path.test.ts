import { describe, it, expect } from 'vitest';
import { resolveExportPath } from '../electron/main/export-path.js';

const picker = async (o: unknown) => ({ canceled: false, filePath: 'C:/tmp/chosen.docx' });

describe('resolveExportPath', () => {
  it('uses SPARKII_E2E_EXPORT_DIR when set', async () => {
    await expect(resolveExportPath(() => null, { SPARKII_E2E_EXPORT_DIR: 'C:/tmp/out' }, picker)).resolves.toBe('C:/tmp/out/report.docx');
  });
  it('returns undefined when there is no window', async () => {
    await expect(resolveExportPath(() => null, {}, picker)).resolves.toBeUndefined();
  });
  it('returns the chosen path from the dialog', async () => {
    await expect(resolveExportPath(() => ({ id: 1 }), {}, picker)).resolves.toBe('C:/tmp/chosen.docx');
  });
  it('returns undefined when the dialog is canceled', async () => {
    await expect(resolveExportPath(() => ({ id: 1 }), {}, async () => ({ canceled: true }))).resolves.toBeUndefined();
  });
});
