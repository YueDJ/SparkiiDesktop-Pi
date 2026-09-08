import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSyntheticSourceInfo, type Skill } from "@earendil-works/pi-coding-agent";
import {
  applySaddleSystemPrompt,
  mergeSaddleSystemPrompt,
} from "../src/skill-prompt.js";
import * as skillPrompt from "../src/skill-prompt.js";

function skill(name: string, extras: Partial<Skill> = {}): Skill {
  const filePath = extras.filePath ?? `/data/agents/general/skills/${name}/SKILL.md`;
  const baseDir = extras.baseDir ?? `/data/agents/general/skills/${name}`;
  return {
    name,
    description: `${name} description`,
    filePath,
    baseDir,
    sourceInfo: createSyntheticSourceInfo(filePath, { source: "saddle", baseDir }),
    disableModelInvocation: false,
    ...extras,
  };
}

describe("mergeSaddleSystemPrompt", () => {
  it("keeps the saddle prompt and appends the Pi skill catalog", () => {
    const merged = mergeSaddleSystemPrompt("你是通用智能体。", {
      systemPromptOptions: {
        skills: [skill("using-superpowers")],
        cwd: "C:\\ws\\session",
        selectedTools: ["read", "ls", "bash"],
      },
    });

    expect(merged.startsWith("你是通用智能体。")).toBe(true);
    expect(merged).toContain("<available_skills>");
    expect(merged).toContain("<name>using-superpowers</name>");
    expect(merged).toContain("/data/agents/general/skills/using-superpowers/SKILL.md");
    expect(merged).toContain("Current working directory: C:/ws/session");
    expect(merged).not.toContain("You are an expert coding assistant");
  });

  it("falls back to an <available_skills> block already in the base prompt", () => {
    const merged = mergeSaddleSystemPrompt("saddle", {
      systemPrompt: [
        "You are an expert coding assistant",
        "<available_skills>",
        "  <skill>",
        "    <name>brainstorming</name>",
        "    <location>/skills/brainstorming/SKILL.md</location>",
        "  </skill>",
        "</available_skills>",
        "Current working directory: /tmp/ws",
      ].join("\n"),
    });

    expect(merged).toContain("<name>brainstorming</name>");
    expect(merged).toContain("Current working directory: /tmp/ws");
    expect(merged).not.toContain("You are an expert coding assistant");
  });

  it("omits the catalog when read is not in the selected tools", () => {
    const merged = mergeSaddleSystemPrompt("saddle", {
      systemPromptOptions: {
        skills: [skill("hidden")],
        selectedTools: ["bash"],
      },
    });
    expect(merged).toBe("saddle");
    expect(merged).not.toContain("available_skills");
  });

  it("returns undefined when the saddle has no system prompt", () => {
    expect(applySaddleSystemPrompt(undefined, {
      systemPromptOptions: { skills: [skill("x")] },
    })).toBeUndefined();
  });
});

describe("skill-prompt exports", () => {
  it("no longer exports slash rewrite helpers", () => {
    expect(skillPrompt).not.toHaveProperty("expandLeadingSkillSlash");
    expect(skillPrompt).not.toHaveProperty("skillSlashAliases");
    expect(skillPrompt).not.toHaveProperty("loadSkillSlashAliases");
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/skill-prompt.ts"), "utf8");
    expect(src).not.toMatch(/expandLeadingSkillSlash|skillSlashAliases|loadSkillSlashAliases/);
  });
});
