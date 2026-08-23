import { describe, it, expect } from "vitest";
import { createPiSdkSessionHost } from "../src/pi-sdk-runtime.js";

describe("pi-sdk-runtime", () => {
  it("exports the SDK host factory", () => {
    expect(typeof createPiSdkSessionHost).toBe("function");
  });
});
