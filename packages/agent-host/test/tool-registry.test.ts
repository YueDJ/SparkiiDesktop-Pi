import { mkdtempSync } from "node:fs";
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
    expect(defs.map((d) => d.name).sort()).toEqual(["bash", "document.read", "read"]);
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
});
