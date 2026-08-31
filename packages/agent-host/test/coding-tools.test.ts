import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { createCodingToolDefinitions, type CodingToolsContext } from "../src/coding-tools.js";
import type { ProposalDecision } from "../src/pi-runtime-transport.js";

const toolCtx = { sessionManager: { getSessionId: () => "test-session", getSessionFile: () => null } };

function ctx(over: Partial<CodingToolsContext & { proposes: ReturnType<typeof vi.fn> }> = {}): CodingToolsContext & { proposes: ReturnType<typeof vi.fn> } {
  const proposes = vi.fn(async () => ({ approved: true, proposalId: "p", status: "executed", result: { exitCode: 0, output: "ok" } }) as ProposalDecision);
  return {
    cwd: join(tmpdir(), "cwd"),
    workspaceRoot: mkdtempSync(join(tmpdir(), "ws-")),
    propose: proposes,
    proposes,
    ...over,
  };
}

describe("createCodingToolDefinitions", () => {
  it("registers bash/powershell/edit/write with native names", () => {
    const defs = createCodingToolDefinitions(ctx());
    expect(defs.map((d) => d.name).sort()).toEqual(["bash", "edit", "powershell", "write"]);
  });

  it("bash exec proposes and streams output on approval", async () => {
    const c = ctx();
    const defs = createCodingToolDefinitions(c);
    const bash = defs.find((d) => d.name === "bash")!;
    const sessionCtx = { sessionManager: { getSessionId: () => "s1", getSessionFile: () => "/tmp/s1.jsonl" } };
    const result = await (bash as any).execute("t1", { command: "echo hi" }, undefined, undefined, sessionCtx);
    expect(c.proposes).toHaveBeenCalledWith(expect.objectContaining({ toolName: "bash" }));
    expect((result as any).content?.[0]?.text).toContain("ok");
  });

  it("writeFile proposes with path/content and rejects on denial", async () => {
    const propose = vi.fn(async () => ({ approved: false, proposalId: "p", status: "denied" }) as ProposalDecision);
    const denied = ctx({ propose, proposes: propose });
    const defs = createCodingToolDefinitions(denied);
    const write = defs.find((d) => d.name === "write")!;
    await expect((write as any).execute("t1", { path: join(denied.workspaceRoot, "a.txt"), content: "x" }, undefined, undefined, toolCtx)).rejects.toThrow(/未执行/);
    expect(denied.proposes).toHaveBeenCalledWith(expect.objectContaining({ toolName: "write", payload: expect.objectContaining({ path: expect.stringContaining("a.txt") }) }));
  });

  it("blocks writes outside workspace before proposing", async () => {
    const c = ctx();
    const defs = createCodingToolDefinitions(c);
    const write = defs.find((d) => d.name === "write")!;
    await expect((write as any).execute("t1", { path: join(tmpdir(), "outside.txt"), content: "x" }, undefined, undefined, toolCtx)).rejects.toThrow(/不在工作区/);
    expect(c.proposes).not.toHaveBeenCalled();
  });

  it("resolves relative write paths against workspaceRoot instead of anchor cwd", async () => {
    const anchor = mkdtempSync(join(tmpdir(), "anchor-"));
    const c = ctx({ cwd: anchor });
    const defs = createCodingToolDefinitions(c);
    const write = defs.find((d) => d.name === "write")!;
    await (write as any).execute("t1", { path: "a.txt", content: "x" }, undefined, undefined, toolCtx);
    expect(c.proposes).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "write",
      payload: expect.objectContaining({ path: join(c.workspaceRoot, "a.txt") }),
    }));
  });
});
