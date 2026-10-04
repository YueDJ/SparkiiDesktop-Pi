import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentSession,
  createReadToolDefinition,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

/**
 * Pi 1.0 把「会话文件何时落盘」的门槛从「首条 assistant 消息」放宽到「首条 user 或 assistant 消息」
 * （`session-manager.js` 的 `_hasConversation()`）。桌面端多处读 `sessionFile`
 * （`ipc.ts`、`workflow.ts`、`pi-sdk-runtime.ts` 的 `getState`），这里把新口径钉住。
 */

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-session-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("pi 1.0 session persistence boundary", () => {
  it("creates the session file with the first user message", () => {
    const dir = tempDir();
    const sessionDir = join(dir, "sessions");
    const sessionManager = SessionManager.create(dir, sessionDir);

    // 没有任何对话之前不落盘（0.84.x 也是这个行为，门槛是首条 assistant）
    expect(sessionManager.getSessionFile()).toBeDefined();
    expect(existsSync(sessionManager.getSessionFile() as string)).toBe(false);

    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });

    expect(existsSync(sessionManager.getSessionFile() as string)).toBe(true);
    expect(sessionManager.getSessionFile()).toContain(sessionDir);
  });

  it("keeps agent.state.streamingMessage available for get_state snapshots", async () => {
    const dir = tempDir();
    const read = createReadToolDefinition(dir, { autoResizeImages: false });
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      sessionManager: SessionManager.inMemory(dir),
      settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
      customTools: [read],
      tools: [read.name],
    });
    try {
      // pi-sdk-runtime 的 sessionStateSnapshot 读 session.agent.state.streamingMessage
      expect("streamingMessage" in session.agent.state).toBe(true);
      expect(session.cacheWarmingStatus?.state ?? "off").not.toBe("warming");
    } finally {
      session.dispose();
    }
  });
});
