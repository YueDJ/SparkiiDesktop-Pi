const OFFICE_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.docx', '.xlsx']);
const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

const GARBLED_RATIO_THRESHOLD = 0.30;
const MIN_CHARS_PER_PAGE = 50;

function isControlChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (code >= 0x00 && code <= 0x1f) || code === 0x7f;
}

function garbledRatio(textLayer: string): number {
  if (textLayer.length === 0) return 0;
  let bad = 0;
  for (const ch of textLayer) {
    if (ch === '\uFFFD' || isControlChar(ch)) bad++;
  }
  return bad / textLayer.length;
}

export function shouldUseStructure(input: {
  ext: string;
  textLayer: string | null;
  pageCount: number;
}): boolean {
  const ext = input.ext.toLowerCase();
  if (OFFICE_EXTENSIONS.has(ext)) return false;
  if (PHOTO_EXTENSIONS.has(ext)) return true;
  if (ext !== '.pdf') return false;

  if (input.textLayer === null) return true;

  const stripped = input.textLayer.replace(/\s/g, '');
  if (stripped.length < MIN_CHARS_PER_PAGE * input.pageCount) return true;

  if (garbledRatio(input.textLayer) > GARBLED_RATIO_THRESHOLD) return true;

  return false;
}
