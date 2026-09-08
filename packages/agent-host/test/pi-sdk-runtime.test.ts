import { describe, it, expect, afterEach } from "vitest";
import {
  buildSkillLoaderOptions,
  createPiSdkSessionHost,
  resolveAgentDir,
} from "../src/pi-sdk-runtime.js";
import { applySaddleSystemPrompt, expandLeadingSkillSlash } from "../src/skill-prompt.js";

const PREV_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  if (PREV_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = PREV_AGENT_DIR;
});

describe("pi-sdk-runtime skill loader options", () => {
  it("maps skillsDir to additionalSkillPaths", () => {
    expect(buildSkillLoaderOptions("/tmp/skills")).toEqual({ additionalSkillPaths: ["/tmp/skills"] });
    expect(buildSkillLoaderOptions(undefined)).toEqual({ additionalSkillPaths: [] });
  });

  it("exports the SDK host factory", () => {
    expect(typeof createPiSdkSessionHost).toBe("function");
  });

  it("does not let a saddle system prompt drop the skill catalog", () => {
    const applied = applySaddleSystemPrompt("通用智能体", {
      systemPromptOptions: {
        skills: [{
          name: "using-superpowers",
          description: "Use skills first",
          filePath: "/lib/using-superpowers/SKILL.md",
          baseDir: "/lib/using-superpowers",
          sourceInfo: { path: "/lib/using-superpowers/SKILL.md", source: "saddle", scope: "user", origin: "top-level" },
          disableModelInvocation: false,
        }],
        selectedTools: ["read"],
      },
    });
    expect(applied?.systemPrompt).toContain("<available_skills>");
    expect(applied?.systemPrompt).toContain("using-superpowers");
    expect(expandLeadingSkillSlash("/using-superpowers", ["using-superpowers"])).toBe("/skill:using-superpowers");
  });
});

describe("pi-sdk-runtime agentDir resolution", () => {
  it("prefers explicit agentDir over env and fallback", () => {
    process.env.PI_CODING_AGENT_DIR = "C:/env/pi-agent";
    expect(resolveAgentDir("C:/explicit/pi-agent")).toBe("C:/explicit/pi-agent");
  });

  it("falls back to PI_CODING_AGENT_DIR when no explicit value is provided", () => {
    process.env.PI_CODING_AGENT_DIR = "C:/env/pi-agent";
    expect(resolveAgentDir()).toBe("C:/env/pi-agent");
  });

  it("falls back to the SDK agent dir when neither is set", () => {
    delete process.env.PI_CODING_AGENT_DIR;
    expect(resolveAgentDir()).toBeTypeOf("string");
  });
});
