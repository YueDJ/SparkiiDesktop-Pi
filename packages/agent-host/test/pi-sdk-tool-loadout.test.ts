import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentSession,
  createBashToolDefinition,
  createReadToolDefinition,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

/**
 * Pi 1.0 起，模型可见工具集由会话内部的「工具注册表 + loadout」推导：
 * 每次 prompt 前 `_preparePromptAndToolLoadout()` 会用注册表过滤 `selectedTools` 并回写
 * `agent.state.tools`。0.84.x 允许直接赋值 `session.agent.state.tools`，1.0 会被覆盖成空。
 * 本文件锁定升级后必须成立的装配契约（离线，不访问 provider）。
 */

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-loadout-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function inMemorySettings() {
  return SettingsManager.inMemory({ cacheWarming: "off" });
}

describe("pi 1.0 tool loadout", () => {
  it("declares exactly the saddle tools (customTools + tools)", async () => {
    const cwd = tempDir();
    const read = createReadToolDefinition(cwd, { autoResizeImages: false });
    const bash = createBashToolDefinition(cwd);

    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: inMemorySettings(),
      customTools: [read, bash],
      tools: [read.name, bash.name],
    });
    try {
      const active = [...session.getActiveToolNames()].sort();
      // 不多不少：既不能缺鞍里的工具，也不能因 usesDefaultTools 多出内置工具
      expect(active).toEqual([bash.name, read.name].sort());
      expect(active).not.toContain("write");
      expect(active).not.toContain("edit");
      expect(active).not.toContain("codemode");
      expect(active).not.toContain("tool_search");
    } finally {
      session.dispose();
    }
  });

  it("leaks the default builtin tools when customTools is passed without tools", async () => {
    const cwd = tempDir();
    const read = createReadToolDefinition(cwd, { autoResizeImages: false });

    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: inMemorySettings(),
      customTools: [read],
    });
    try {
      const active = session.getActiveToolNames();
      // 这就是为什么 pi-sdk-runtime 必须同时传 tools：只传 customTools 会激活默认内置工具
      expect(active).toContain("bash");
      expect(active).toContain("read");
    } finally {
      session.dispose();
    }
  });

  it("disables a tool again when only the remaining name is activated", async () => {
    const cwd = tempDir();
    const read = createReadToolDefinition(cwd, { autoResizeImages: false });
    const bash = createBashToolDefinition(cwd);

    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: inMemorySettings(),
      customTools: [read, bash],
      tools: [read.name, bash.name],
    });
    try {
      expect([...session.getActiveToolNames()].sort()).toEqual([bash.name, read.name].sort());
      // 换鞍（缩小工具集）：注册表里仍在，但不再声明给模型
      session.setActiveToolsByName([read.name]);
      expect(session.getActiveToolNames()).toEqual([read.name]);
    } finally {
      session.dispose();
    }
  });
});
