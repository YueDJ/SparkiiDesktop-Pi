import { describe, it, expect, vi } from "vitest";
import { buildPiRuntimeTools } from "../src/pi-runtime-tools.js";

describe("buildPiRuntimeTools", () => {
  it("executes read tools locally", async () => {
    const read = {
      name: "document.read", description: "read", sideEffect: "read" as const,
      params: { type: "object", properties: { path: { type: "string" } } },
      handler: vi.fn(async () => ({ ok: true, data: { text: "hello" } })),
    };
    const tools = buildPiRuntimeTools({ tools: [read], propose: vi.fn() });
    const result = await tools[0].execute("id1", { path: "a.pdf" });
    expect(read.handler).toHaveBeenCalled();
    expect(result.content[0].text).toContain("hello");
  });

  it("proposes write tools instead of executing them", async () => {
    const write = {
      name: "report.export", description: "export", sideEffect: "write" as const,
      params: { type: "object", properties: {} },
      handler: vi.fn(),
    };
    const propose = vi.fn(async () => ({ approved: false, proposalId: "p1", status: "denied" }));
    const tools = buildPiRuntimeTools({ tools: [write], propose });
    const result = await tools[0].execute("id2", { path: "a.docx" });
    expect(write.handler).not.toHaveBeenCalled();
    expect(propose).toHaveBeenCalledWith(expect.objectContaining({ toolName: "report.export", risk: "write" }));
    expect(result.content[0].text).toContain("denied");
  });
});
