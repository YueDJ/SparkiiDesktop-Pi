import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { listPiSessions, readPiSessionEntries, readPiSessionMessages } from "../src/session-catalog.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("session-catalog", () => {
  it("reads messages from a session jsonl file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sparkii-cat-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "session", version: 3, id: "a", timestamp: "2026-08-26T00:00:00.000Z", cwd: dir }),
        JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-08-26T00:00:01.000Z", message: { role: "user", content: "hi" } }),
      ].join("\n"),
      "utf8",
    );
    const messages = readPiSessionMessages(file);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("hi");
  });

  it("reads full session entries including tool calls and compaction", () => {
    const dir = mkdtempSync(join(tmpdir(), "sparkii-cat-entries-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "session", version: 3, id: "a", timestamp: "2026-08-26T00:00:00.000Z", cwd: dir }),
        JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-08-26T00:00:01.000Z", message: { role: "user", content: "hi" } }),
        JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: "2026-08-26T00:00:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }] } }),
        JSON.stringify({ type: "compaction", id: "c1", parentId: "m2", timestamp: "2026-08-26T00:00:03.000Z", summary: "summarized", firstKeptEntryId: "m2", tokensBefore: 1000 }),
      ].join("\n"),
      "utf8",
    );

    const entries = readPiSessionEntries(file);
    expect(entries.map((e) => e.type)).toEqual(["message", "message", "compaction"]);
    expect(entries[1]).toMatchObject({ type: "message", id: "m2" });
    expect(entries[2]).toMatchObject({ type: "compaction", tokensBefore: 1000 });
  });

  it("maps SessionManager.listAll results into summaries", async () => {
    const created = new Date("2026-08-26T00:00:00.000Z");
    const modified = new Date("2026-08-26T00:01:00.000Z");
    const spy = vi.spyOn(SessionManager, "listAll").mockResolvedValue([
      {
        id: "s1",
        path: "/tmp/sessions/s1.jsonl",
        cwd: "/tmp",
        name: "标题",
        created,
        modified,
        messageCount: 3,
        firstMessage: "第一条消息",
        allMessagesText: "全部消息",
      },
    ] as any);

    const sessions = await listPiSessions("/tmp/sessions");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual({
      id: "s1",
      path: "/tmp/sessions/s1.jsonl",
      cwd: "/tmp",
      name: "标题",
      firstMessage: "第一条消息",
      created,
      modified,
      messageCount: 3,
    });
    expect(spy).toHaveBeenCalledWith("/tmp/sessions");
  });
});
