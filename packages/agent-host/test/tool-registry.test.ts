import { linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { resolveToolDefinitions, WORKSPACE_NOT_CREATED } from "../src/tool-registry.js";
import type { ProposalDecision } from "../src/pi-runtime-transport.js";

const propose = vi.fn(async () => ({ approved: false, proposalId: "x", status: "denied" }) as ProposalDecision);
const requestAction = vi.fn(async (request: any) => ({
  requestId: request.requestId,
  status: "executed" as const,
  decision: {
    decision: "allow" as const,
    ruleId: "workspace.write",
    reason: "workspace",
  },
  result: { path: request.args.path },
}));

describe("resolveToolDefinitions", () => {
  it("resolves coding and connector tool names", () => {
    const defs = resolveToolDefinitions(["read", "bash", "document.read"], {
      cwd: tmpdir(), workspaceRoot: mkdtempSync(join(tmpdir(), "ws-")), propose,
    });
    expect(defs.map((d) => d.name).sort()).toEqual(["bash", "document_read", "read"]);
  });

  it("fails closed on unknown tool names", () => {
    expect(() => resolveToolDefinitions(["read", "nope"], { cwd: tmpdir(), propose })).toThrow(/unknown tool in saddle: nope/);
  });

  it("wires coding writes to the Runtime action requester", async () => {
    const ws = mkdtempSync(join(tmpdir(), "ws-"));
    const defs = resolveToolDefinitions(["write"], {
      cwd: tmpdir(),
      workspaceRoot: ws,
      propose,
      requestAction,
    });
    const write = defs[0] as any;
    await write.execute(
      "call-write",
      { path: "a.txt", content: "x" },
      undefined,
      () => {},
      {},
    );
    expect(requestAction).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "write",
      toolCallId: "call-write",
      args: { path: join(ws, "a.txt"), content: "x" },
    }));
    expect(propose).not.toHaveBeenCalled();
  });

  it("resolves the ontology connector tool surface", () => {
    const defs = resolveToolDefinitions(["ontology.graph_summary"], {
      cwd: tmpdir(), workspaceRoot: mkdtempSync(join(tmpdir(), "ws-")), propose,
    });
    expect(defs.map((d) => d.name)).toEqual(["ontology_graph_summary"]);
  });

  it("read tool returns WORKSPACE_NOT_CREATED when workspace missing", async () => {
    const ws = join(tmpdir(), "missing-ws-" + Date.now());
    const defs = resolveToolDefinitions(["read"], { cwd: tmpdir(), workspaceRoot: ws, propose });
    const read = defs[0];
    const result = await (read as any).execute("t1", { path: join(ws, "a.txt") }, undefined, undefined, {});
    expect((result as any).content?.[0]?.text).toBe(WORKSPACE_NOT_CREATED);
  });

  it("resolves relative read paths against workspaceRoot instead of anchor cwd", async () => {
    const ws = mkdtempSync(join(tmpdir(), "ws-"));
    writeFileSync(join(ws, "a.txt"), "hello workspace", "utf8");
    const anchor = mkdtempSync(join(tmpdir(), "anchor-"));
    const defs = resolveToolDefinitions(["read"], { cwd: anchor, workspaceRoot: ws, propose });
    const read = defs[0];
    const result = await (read as any).execute("t1", { path: "a.txt" }, undefined, undefined, {});
    expect((result as any).content?.[0]?.text).toContain("hello workspace");
  });

  it("read tool returns inline image content for an image file", async () => {
    const ws = mkdtempSync(join(tmpdir(), "ws-"));
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(join(ws, "pixel.png"), png);
    const defs = resolveToolDefinitions(["read"], { cwd: tmpdir(), workspaceRoot: ws, propose });
    const read = defs[0];
    const result = await (read as any).execute("t1", { path: "pixel.png" }, undefined, undefined, {});
    const content = (result as any).content;
    expect(Array.isArray(content)).toBe(true);
    const image = content.find((c: any) => c.type === "image");
    expect(image).toBeDefined();
    expect(image.mimeType).toBe("image/png");
    expect(typeof image.data).toBe("string");
    expect(image.data.length).toBeGreaterThan(0);
  });

  it("reads a skill-root file when the workspace does not exist", async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), "skills-"));
    mkdirSync(join(skillsDir, "foo"), { recursive: true });
    writeFileSync(join(skillsDir, "foo", "SKILL.md"), "skill body", "utf8");
    const ws = join(tmpdir(), "missing-ws-skill-" + Date.now());
    const defs = resolveToolDefinitions(["read"], {
      cwd: tmpdir(), workspaceRoot: ws, skillsDir, propose,
    });
    const result = await (defs[0] as any).execute(
      "t1",
      { path: join(skillsDir, "foo", "SKILL.md") },
      undefined,
      undefined,
      {},
    );
    expect((result as any).content?.[0]?.text).toContain("skill body");
    expect((result as any).content?.[0]?.text).not.toBe(WORKSPACE_NOT_CREATED);
  });

  it("still reads workspace files when the workspace exists", async () => {
    const ws = mkdtempSync(join(tmpdir(), "ws-"));
    const skillsDir = mkdtempSync(join(tmpdir(), "skills-"));
    writeFileSync(join(ws, "a.txt"), "hello workspace", "utf8");
    const defs = resolveToolDefinitions(["read"], {
      cwd: tmpdir(), workspaceRoot: ws, skillsDir, propose,
    });
    const result = await (defs[0] as any).execute("t1", { path: "a.txt" }, undefined, undefined, {});
    expect((result as any).content?.[0]?.text).toContain("hello workspace");
  });

  it("denies another agent's skill path even when workspace exists", async () => {
    const ws = mkdtempSync(join(tmpdir(), "ws-"));
    const skillsDir = mkdtempSync(join(tmpdir(), "skills-own-"));
    const otherSkills = mkdtempSync(join(tmpdir(), "skills-other-"));
    mkdirSync(join(otherSkills, "secret"), { recursive: true });
    writeFileSync(join(otherSkills, "secret", "SKILL.md"), "other agent skill", "utf8");
    const defs = resolveToolDefinitions(["read"], {
      cwd: tmpdir(), workspaceRoot: ws, skillsDir, propose,
    });
    const otherPath = join(otherSkills, "secret", "SKILL.md");
    const result = await (defs[0] as any).execute("t1", { path: otherPath }, undefined, undefined, {});
    expect((result as any).content?.[0]?.text).toBe(`拒绝访问:${otherPath} 不在工作区内`);
  });

  it("denies trust-anchor reads even when the file is inside the workspace", async () => {
    const ws = mkdtempSync(join(tmpdir(), "ws-"));
    writeFileSync(join(ws, ".env"), "SECRET=value", "utf8");
    const defs = resolveToolDefinitions(["read"], {
      cwd: tmpdir(), workspaceRoot: ws, propose,
    });
    const result = await (defs[0] as any).execute(
      "t1",
      { path: ".env" },
      undefined,
      undefined,
      {},
    );
    expect((result as any).content?.[0]?.text).toMatch(/信任锚|拒绝访问/);
    expect((result as any).content?.[0]?.text).not.toContain("SECRET=value");
  });

  it("denies symlink escapes from the workspace", async () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    const ws = mkdtempSync(join(tmpdir(), "ws-"));
    writeFileSync(join(outside, "secret.txt"), "outside-secret", "utf8");
    symlinkSync(outside, join(ws, "escape"), process.platform === "win32" ? "junction" : "dir");
    const defs = resolveToolDefinitions(["read"], {
      cwd: tmpdir(), workspaceRoot: ws, propose,
    });
    const result = await (defs[0] as any).execute(
      "t1",
      { path: "escape/secret.txt" },
      undefined,
      undefined,
      {},
    );
    expect((result as any).content?.[0]?.text).toMatch(/拒绝访问/);
    expect((result as any).content?.[0]?.text).not.toContain("outside-secret");
  });

  it("denies directly reading a hard-linked file", async () => {
    const root = mkdtempSync(join(tmpdir(), "hardlink-"));
    const ws = join(root, "ws");
    mkdirSync(ws);
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "shared-secret", "utf8");
    linkSync(outside, join(ws, "shared.txt"));
    const defs = resolveToolDefinitions(["read"], {
      cwd: tmpdir(), workspaceRoot: ws, propose,
    });
    const result = await (defs[0] as any).execute(
      "t1",
      { path: "shared.txt" },
      undefined,
      undefined,
      {},
    );
    expect((result as any).content?.[0]?.text).toMatch(/hard|拒绝访问/);
    expect((result as any).content?.[0]?.text).not.toContain("shared-secret");
  });

  it("asks Main before reading a workspace file", async () => {
    const ws = mkdtempSync(join(tmpdir(), "ws-"));
    const target = join(ws, "a.txt");
    writeFileSync(target, "authorized-content", "utf8");
    const actionRequests: any[] = [];
    const defs = resolveToolDefinitions(["read"], {
      cwd: tmpdir(),
      workspaceRoot: ws,
      propose,
      requestAction: async (request) => {
        actionRequests.push(request);
        return {
          requestId: request.requestId,
          status: "executed",
          decision: { decision: "allow", ruleId: "workspace.read", reason: "main approved" },
          result: { authorized: true, canonicalPath: target },
        };
      },
    });
    const result = await (defs[0] as any).execute(
      "t1",
      { path: "a.txt" },
      undefined,
      undefined,
      {},
    );
    expect((result as any).content?.[0]?.text).toContain("authorized-content");
    expect(actionRequests).toHaveLength(1);
    expect(actionRequests[0]).toMatchObject({
      toolName: "read",
      toolCallId: "t1",
      args: { path: target },
    });
  });

  it("still returns WORKSPACE_NOT_CREATED for workspace paths when workspace is missing", async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), "skills-"));
    const ws = join(tmpdir(), "missing-ws-still-" + Date.now());
    const defs = resolveToolDefinitions(["read"], {
      cwd: tmpdir(), workspaceRoot: ws, skillsDir, propose,
    });
    const result = await (defs[0] as any).execute("t1", { path: join(ws, "a.txt") }, undefined, undefined, {});
    expect((result as any).content?.[0]?.text).toBe(WORKSPACE_NOT_CREATED);
  });

  it("lists a skill-root directory when the workspace does not exist", async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), "skills-"));
    mkdirSync(join(skillsDir, "foo"), { recursive: true });
    writeFileSync(join(skillsDir, "foo", "SKILL.md"), "skill body", "utf8");
    const ws = join(tmpdir(), "missing-ws-ls-" + Date.now());
    const defs = resolveToolDefinitions(["ls"], {
      cwd: tmpdir(), workspaceRoot: ws, skillsDir, propose,
    });
    const result = await (defs[0] as any).execute("t1", { path: join(skillsDir, "foo") }, undefined, undefined, {});
    const text = (result as any).content?.[0]?.text ?? "";
    expect(text).toContain("SKILL.md");
    expect(text).not.toBe(WORKSPACE_NOT_CREATED);
  });

  it("isolates user-library and package skill roots across two agent saddles", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "data-"));
    const packageDir = mkdtempSync(join(tmpdir(), "pkg-"));
    const userSkills = join(dataDir, "agents", "general", "skills");
    const packageSkills = join(packageDir, "agent", "skills");
    mkdirSync(join(userSkills, "extra-user-skill"), { recursive: true });
    mkdirSync(join(packageSkills, "clause_extract"), { recursive: true });
    writeFileSync(join(userSkills, "extra-user-skill", "SKILL.md"), "user library skill", "utf8");
    writeFileSync(join(packageSkills, "clause_extract", "SKILL.md"), "package skill", "utf8");
    const ws = mkdtempSync(join(tmpdir(), "ws-iso-"));
    const userPath = join(userSkills, "extra-user-skill", "SKILL.md");
    const packagePath = join(packageSkills, "clause_extract", "SKILL.md");

    const generalRead = resolveToolDefinitions(["read"], {
      cwd: tmpdir(), workspaceRoot: ws, skillsDir: userSkills, propose,
    })[0] as any;
    const ownUser = await generalRead.execute("t1", { path: userPath }, undefined, undefined, {});
    const crossPackage = await generalRead.execute("t2", { path: packagePath }, undefined, undefined, {});
    expect(ownUser.content?.[0]?.text).toContain("user library skill");
    expect(crossPackage.content?.[0]?.text).toBe(`拒绝访问:${packagePath} 不在工作区内`);

    const packageRead = resolveToolDefinitions(["read"], {
      cwd: tmpdir(), workspaceRoot: ws, skillsDir: packageSkills, propose,
    })[0] as any;
    const ownPackage = await packageRead.execute("t3", { path: packagePath }, undefined, undefined, {});
    const crossUser = await packageRead.execute("t4", { path: userPath }, undefined, undefined, {});
    expect(ownPackage.content?.[0]?.text).toContain("package skill");
    expect(crossUser.content?.[0]?.text).toBe(`拒绝访问:${userPath} 不在工作区内`);
  });
});
