import {
  formatSkillsForPrompt,
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
