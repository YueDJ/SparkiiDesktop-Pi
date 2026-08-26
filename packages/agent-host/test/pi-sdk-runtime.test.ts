import { describe, it, expect, afterEach } from "vitest";
import {
  buildSkillLoaderOptions,
  createPiSdkSessionHost,
  resolveAgentDir,
} from "../src/pi-sdk-runtime.js";

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
