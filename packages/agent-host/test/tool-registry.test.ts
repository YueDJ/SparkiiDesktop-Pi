import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { resolveToolDefinitions, WORKSPACE_NOT_CREATED } from "../src/tool-registry.js";
import type { ProposalDecision } from "../src/pi-runtime-transport.js";

const propose = vi.fn(async () => ({ approved: false, proposalId: "x", status: "denied" }) as ProposalDecision);

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

  it("still returns WORKSPACE_NOT_CREATED for workspace paths when workspace is missing", async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), "skills-"));
    const ws = join(tmpdir(), "missing-ws-still-" + Date.now());
    const defs = resolveToolDefinitions(["read"], {
      cwd: tmpdir(), workspaceRoot: ws, skillsDir, propose,
    });
    const result = await (defs[0] as any).execute("t1", { path: join(ws, "a.txt") }, undefined, undefined, {});
    expect((result as any).content?.[0]?.text).toBe(WORKSPACE_NOT_CREATED);
  });
});
