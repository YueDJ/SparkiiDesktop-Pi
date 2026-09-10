import { loadSettings, saveSettings, type AppSettings } from './settings.js';

export type DocumentParseSettings = {
  idleMinutes: number;
  keepResident: boolean;
};

export const DEFAULT_DOCUMENT_PARSE: DocumentParseSettings = {
  idleMinutes: 5,
  keepResident: false,
};

const MAX_IDLE_MINUTES = 60;

/** Clamp idle to 1–60, or 0 = no auto-kill (same as supervisor). */
export function clampIdleMinutes(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_DOCUMENT_PARSE.idleMinutes;
  if (n <= 0) return 0;
  return Math.min(MAX_IDLE_MINUTES, Math.max(1, Math.round(n)));
}

export function documentParseFromSettings(s: AppSettings): DocumentParseSettings {
  const dp = s.documentParse ?? {};
  return {
    idleMinutes: dp.idleMinutes === undefined
      ? DEFAULT_DOCUMENT_PARSE.idleMinutes
      : clampIdleMinutes(dp.idleMinutes),
    keepResident: dp.keepResident === true,
  };
}

export async function saveDocumentParseSettings(
  dataDir: string,
  partial: Partial<DocumentParseSettings>,
): Promise<DocumentParseSettings> {
  const prev = await loadSettings(dataDir);
  const current = documentParseFromSettings(prev);
  const next: DocumentParseSettings = {
    idleMinutes: partial.idleMinutes !== undefined
      ? clampIdleMinutes(partial.idleMinutes)
      : current.idleMinutes,
    keepResident: typeof partial.keepResident === 'boolean'
      ? partial.keepResident
      : current.keepResident,
  };
  await saveSettings(dataDir, { ...prev, documentParse: next });
  return next;
}
