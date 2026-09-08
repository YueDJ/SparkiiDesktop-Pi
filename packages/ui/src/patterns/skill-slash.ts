const DEST_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseLeadingSkillSlash(text: string): { name: string; rest: string } | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/')) return null;
  const afterSlash = trimmed.slice(1);
  const nameMatch = /^([a-z0-9]+(?:-[a-z0-9]+)*)/.exec(afterSlash);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  if (name.length < 1 || name.length > 64 || !DEST_NAME_RE.test(name)) return null;
  const afterName = afterSlash.slice(name.length);
  if (afterName === '') return { name, rest: '' };
  if (!/^\s/.test(afterName)) return null;
  return { name, rest: afterName.slice(1) };
}
