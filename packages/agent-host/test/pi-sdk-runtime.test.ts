import { describe, it, expect } from "vitest";
import { buildSkillLoaderOptions, createPiSdkSessionHost } from "../src/pi-sdk-runtime.js";

describe("pi-sdk-runtime skill loader options", () => {
  it("maps skillsDir to additionalSkillPaths", () => {
    expect(buildSkillLoaderOptions("/tmp/skills")).toEqual({ additionalSkillPaths: ["/tmp/skills"] });
    expect(buildSkillLoaderOptions(undefined)).toEqual({ additionalSkillPaths: [] });
  });

  it("exports the SDK host factory", () => {
    expect(typeof createPiSdkSessionHost).toBe("function");
  });
});
