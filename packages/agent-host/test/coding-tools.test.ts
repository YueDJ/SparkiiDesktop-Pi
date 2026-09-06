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
  it("registers bash/edit/write with native names", () => {
    const defs = createCodingToolDefinitions(ctx());
    expect(defs.map((d) => d.name).sort()).toEqual(["bash", "edit", "write"]);
  });

  it("bash exec proposes and streams output on approval", async () => {
    const c = ctx();
    const defs = createCodingToolDefinitions(c);
    const bash = defs.find((d) => d.name === "bash")!;
    const sessionCtx = { sessionManager: { getSessionId: () => "s1", getSessionFile: () => "/tmp/s1.jsonl" } };
    const result = await (bash as any).execute("t1", { command: "echo hi" }, undefined, undefined, sessionCtx);
    expect(c.proposes).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "bash",
      summary: "echo hi",
      preview: { kind: "text", lines: ["echo hi"] },
    }));
    expect((result as any).content?.[0]?.text).toContain("ok");
  });

  it("writeFile proposes with path/content and rejects on denial", async () => {
    const propose = vi.fn(async () => ({ approved: false, proposalId: "p", status: "denied" }) as ProposalDecision);
    const denied = ctx({ propose, proposes: propose });
    const defs = createCodingToolDefinitions(denied);
    const write = defs.find((d) => d.name === "write")!;
    await expect((write as any).execute("t1", { path: join(denied.workspaceRoot, "a.txt"), content: "x" }, undefined, undefined, toolCtx)).rejects.toThrow(/未执行/);
    expect(denied.proposes).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "write",
      summary: "写入 a.txt",
      payload: expect.objectContaining({ path: expect.stringContaining("a.txt") }),
    }));
    expect(denied.proposes.mock.calls[0][0].preview).toBeUndefined();
  });

  it("edit proposes a workspace-relative summary without preview", async () => {
    const { writeFile } = await import("node:fs/promises");
    const c = ctx();
    await writeFile(join(c.workspaceRoot, "a.txt"), "old");
    const defs = createCodingToolDefinitions(c);
    const edit = defs.find((d) => d.name === "edit")!;
    await (edit as any).execute("t1", {
      path: join(c.workspaceRoot, "a.txt"),
      edits: [{ oldText: "old", newText: "new" }],
    }, undefined, undefined, toolCtx);
    expect(c.proposes).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "edit",
      summary: "修改 a.txt",
      payload: expect.objectContaining({ path: expect.stringContaining("a.txt") }),
    }));
    expect(c.proposes.mock.calls[0][0].preview).toBeUndefined();
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

  it("summarizes bash as the first line truncated to 120 characters", async () => {
    const c = ctx();
    const defs = createCodingToolDefinitions(c);
    const bash = defs.find((d) => d.name === "bash")!;
    const first = "x".repeat(200);
    await (bash as any).execute("t1", { command: `${first}\nsecond` }, undefined, undefined, toolCtx);
    expect(c.proposes.mock.calls[0][0].summary).toBe(first.slice(0, 120));
    expect(c.proposes.mock.calls[0][0].preview).toEqual({ kind: "text", lines: [first, "second"] });
  });
});
