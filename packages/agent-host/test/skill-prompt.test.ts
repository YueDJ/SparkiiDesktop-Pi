import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSyntheticSourceInfo, type Skill } from "@earendil-works/pi-coding-agent";
import {
  applySaddleSystemPrompt,
  expandLeadingSkillSlash,
  loadSkillSlashAliases,
  mergeSaddleSystemPrompt,
  skillSlashAliases,
} from "../src/skill-prompt.js";

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

describe("expandLeadingSkillSlash", () => {
  const aliases = skillSlashAliases([
    skill("using-superpowers", { baseDir: "/lib/superpowers" }),
    skill("brainstorming"),
  ]);

  it("rewrites /name to /skill:name when the skill exists", () => {
    expect(expandLeadingSkillSlash("/brainstorming", aliases)).toBe("/skill:brainstorming");
    expect(expandLeadingSkillSlash("/brainstorming please", aliases)).toBe("/skill:brainstorming please");
  });

  it("maps a single-skill folder destName to the frontmatter name", () => {
    expect(expandLeadingSkillSlash("/superpowers", aliases)).toBe("/skill:using-superpowers");
  });

  it("leaves unknown slashes and already-expanded commands alone", () => {
    expect(expandLeadingSkillSlash("/tmp", aliases)).toBe("/tmp");
    expect(expandLeadingSkillSlash("/skill:brainstorming extra", aliases)).toBe("/skill:brainstorming extra");
    expect(expandLeadingSkillSlash("please /brainstorming", aliases)).toBe("please /brainstorming");
  });
});

describe("loadSkillSlashAliases", () => {
  it("reads frontmatter names from a user skill library", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-aliases-"));
    const dest = join(root, "superpowers");
    mkdirSync(dest, { recursive: true });
    writeFileSync(
      join(dest, "SKILL.md"),
      "---\nname: using-superpowers\ndescription: Bootstrap skill use.\n---\n# using\n",
      "utf8",
    );

    const aliases = loadSkillSlashAliases(root);
    expect(aliases.get("using-superpowers")).toBe("using-superpowers");
    expect(aliases.get("superpowers")).toBe("using-superpowers");
    expect(loadSkillSlashAliases(undefined).size).toBe(0);
  });
});
