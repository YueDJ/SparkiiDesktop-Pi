import { basename } from "node:path";
import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
  type Skill,
} from "@earendil-works/pi-coding-agent";

export type SkillPromptMergeInput = {
  systemPrompt?: string;
  systemPromptOptions?: {
    skills?: Skill[];
    cwd?: string;
    selectedTools?: string[];
  };
};

const DEST_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function canReadSkills(selectedTools?: string[]): boolean {
  return !selectedTools || selectedTools.includes("read");
}

function extractTag(source: string, tag: string): string {
  const match = source.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`));
  return match?.[0] ?? "";
}

function formatCwdLine(cwd?: string, basePrompt?: string): string {
  if (cwd) return `Current working directory: ${cwd.replace(/\\/g, "/")}`;
  return basePrompt?.match(/Current working directory: [^\n]+/)?.[0] ?? "";
}

/**
 * Keep Pi's skill catalog (and cwd) when the saddle replaces the default system prompt.
 * Returning only the saddle text from `before_agent_start` would wipe `<available_skills>`.
 */
export function mergeSaddleSystemPrompt(
  saddlePrompt: string,
  input: SkillPromptMergeInput = {},
): string {
  const options = input.systemPromptOptions;
  const basePrompt = input.systemPrompt ?? "";
  const parts = [saddlePrompt.trimEnd()];

  if (canReadSkills(options?.selectedTools)) {
    const fromOptions = options?.skills?.length
      ? formatSkillsForPrompt(options.skills).trim()
      : "";
    const catalog = fromOptions || extractTag(basePrompt, "available_skills");
    if (catalog) parts.push(catalog);
  }

  const cwdLine = formatCwdLine(options?.cwd, basePrompt);
  if (cwdLine) parts.push(cwdLine);

  return parts.join("\n\n");
}

export function applySaddleSystemPrompt(
  saddlePrompt: string | undefined,
  input: SkillPromptMergeInput,
): { systemPrompt: string } | undefined {
  if (!saddlePrompt) return undefined;
  return { systemPrompt: mergeSaddleSystemPrompt(saddlePrompt, input) };
}

export function skillSlashAliases(
  skills: Array<{ name: string; baseDir?: string }>,
): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const skill of skills) {
    aliases.set(skill.name, skill.name);
    const folder = skill.baseDir ? basename(skill.baseDir) : "";
    if (folder && DEST_NAME_RE.test(folder) && folder.length <= 64 && !aliases.has(folder)) {
      aliases.set(folder, skill.name);
    }
  }
  return aliases;
}

export function loadSkillSlashAliases(skillsDir?: string): Map<string, string> {
  if (!skillsDir) return new Map();
  const loaded = loadSkillsFromDir({ dir: skillsDir, source: "saddle" });
  return skillSlashAliases(loaded.skills);
}

/**
 * Pi only expands `/skill:name`. Users type `/name` (Claude/Cursor style).
 * Unknown slashes are left untouched so paths like `/tmp` stay literal.
 */
export function expandLeadingSkillSlash(
  text: string,
  aliases: Map<string, string> | Iterable<string>,
): string {
  if (text.startsWith("/skill:")) return text;
  const match = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(\s|$)([\s\S]*)/.exec(text);
  if (!match) return text;
  const map = aliases instanceof Map
    ? aliases
    : new Map([...aliases].map((name) => [name, name] as const));
  const skillName = map.get(match[1]);
  if (!skillName) return text;
  const rest = (match[3] ?? "").trim();
  return rest ? `/skill:${skillName} ${rest}` : `/skill:${skillName}`;
}
