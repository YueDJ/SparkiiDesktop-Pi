import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { capturedPaths, capturedFactories } = vi.hoisted(() => ({
  capturedPaths: [] as string[][],
  capturedFactories: [] as Array<(pi: any) => void>,
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();

  function fakeSession() {
    return {
      agent: { state: { tools: [], streamingMessage: null } },
      extensionRunner: { hasHandlers: () => false, emit: async () => undefined },
      abort: async () => {},
      dispose: () => {},
      prompt: async () => {},
      steer: async () => {},
      followUp: async () => {},
      subscribe: () => () => {},
      messages: [],
      sessionManager: {
        getBranch: () => [],
        appendCustomEntry: () => "1",
        getEntry: () => undefined,
        isPersisted: () => false,
        getSessionDir: () => "/tmp",
        getSessionFile: () => "/tmp/s.jsonl",
        newSession: () => {},
      },
      sessionFile: "/tmp/s.jsonl",
      sessionId: "s",
      isStreaming: false,
      isCompacting: false,
      getContextUsage: () => null,
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
      clearQueue: () => ({ steering: [], followUp: [] }),
      setSteeringMode: () => {},
      setFollowUpMode: () => {},
      setModel: async () => {},
      setSessionName: () => {},
      setThinkingLevel: () => {},
      getThinkingLevel: () => "off",
      getAvailableThinkingLevels: () => [],
      createReplacedSessionContext: () => ({}),
    };
  }

  return {
    ...actual,
    createAgentSessionServices: vi.fn(async (opts) => {
      capturedPaths.push([...(opts.resourceLoaderOptions?.additionalSkillPaths ?? [])]);
      capturedFactories.push(...(opts.resourceLoaderOptions?.extensionFactories ?? []));
      return {
        cwd: opts.cwd,
        agentDir: opts.agentDir ?? opts.cwd,
        diagnostics: [],
        resourceLoader: { getSkills: () => ({ skills: [], diagnostics: [] }) },
        modelRuntime: {},
        settingsManager: {},
      };
    }),
    createAgentSessionFromServices: vi.fn(async ({ services }) => ({
      session: fakeSession(),
      services,
      extensionsResult: { extensions: [], errors: [] },
      diagnostics: services.diagnostics ?? [],
    })),
  };
});

import { createPiSdkSessionHost } from "../src/pi-sdk-runtime.js";

const PREV_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  capturedPaths.length = 0;
  capturedFactories.length = 0;
  if (PREV_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = PREV_AGENT_DIR;
});

function dummyTransport() {
  return {
    postMessage: () => {},
    onMessage: () => () => {},
  };
}

describe("createPiSdkSessionHost skill loader rebind", () => {
  it("rebinds additionalSkillPaths on new_session after configure, not on configure alone", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-rebind-"));
    const host = await createPiSdkSessionHost({
      transport: dummyTransport(),
      agentDir,
      cwd: agentDir,
    });

    expect(capturedPaths).toEqual([[]]);

    await host.configureSaddle({ tools: ["read"], skillsDir: "/skills-a" });
    expect(capturedPaths).toEqual([[]]);

    await host.newSession();
    expect(capturedPaths.at(-1)).toEqual(["/skills-a"]);

    await host.configureSaddle({ tools: ["read"], skillsDir: "/skills-b" });
    expect(capturedPaths.at(-1)).toEqual(["/skills-a"]);

    await host.newSession();
    expect(capturedPaths.at(-1)).toEqual(["/skills-b"]);
    expect(capturedPaths.filter((paths) => paths.length > 0)).toEqual([["/skills-a"], ["/skills-b"]]);
  });

  it("projects user and custom start events without reading their prompt field", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-prompt-"));
    const host = await createPiSdkSessionHost({
      transport: dummyTransport(),
      agentDir,
      cwd: agentDir,
    });
    await host.configureSaddle({ tools: [], systemPrompt: "saddle prompt" });

    const handlers = new Map<string, (event: any) => any>();
    const pi = {
      on: vi.fn((name: string, handler: (event: any) => any) => {
        handlers.set(name, handler);
      }),
      registerTool: vi.fn(),
      setActiveTools: vi.fn(),
    };
    const factory = capturedFactories.at(-1);
    expect(factory).toBeDefined();
    factory!(pi);

    const fallbackPrompt = [
      "<available_skills><skill><name>fallback-skill</name></skill></available_skills>",
      "Current working directory: C:/fallback",
    ].join("\n");
    const eventBase = {
      type: "before_agent_start" as const,
      systemPrompt: fallbackPrompt,
      systemPromptOptions: {},
    };
    const userEvent = {
      ...eventBase,
      messageType: "user" as const,
      get prompt(): string {
        throw new Error("prompt must not be read");
      },
    };
    const customEvent = {
      ...eventBase,
      messageType: "custom" as const,
      message: { role: "user", content: [{ type: "text", text: "custom" }] },
    };

    const handler = handlers.get("before_agent_start");
    expect(handler).toBeDefined();
    for (const event of [userEvent, customEvent]) {
      expect(() => handler!(event)).not.toThrow();
      const result = handler!(event);
      expect(result.systemPrompt).toContain("saddle prompt");
      expect(result.systemPrompt).toContain("<name>fallback-skill</name>");
      expect(result.systemPrompt).toContain("Current working directory: C:/fallback");
    }
  });
});
