import { describe, it, expect, afterEach, vi } from "vitest";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  buildSkillLoaderOptions,
  createPiSettingsManager,
  createPiSdkSessionHost,
  resolveAgentDir,
  currentPromptOriginToken,
} from "../src/pi-sdk-runtime.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applySaddleSystemPrompt } from "../src/skill-prompt.js";
import { createPiRuntime } from "../src/pi-runtime.js";
import { commandEnvelope, type PiRuntimeEnvelope } from "../src/pi-runtime-transport.js";

const tempDirs: string[] = [];
const PREV_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (PREV_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = PREV_AGENT_DIR;
});

describe("pi-sdk-runtime skill loader options", () => {
  it("maps skillsDir to additionalSkillPaths", () => {
    expect(buildSkillLoaderOptions("/tmp/skills")).toEqual({ additionalSkillPaths: ["/tmp/skills"] });
    expect(buildSkillLoaderOptions(undefined)).toEqual({ additionalSkillPaths: [] });
  });

  it("exports the SDK host factory", () => {
    expect(typeof createPiSdkSessionHost).toBe("function");
  });

  it("R8 round7 B2 turns a real SDK no-model rejection into a correlated terminal event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-prompt-error-"));
    tempDirs.push(dir);
    const sent: PiRuntimeEnvelope[] = [];
    let receive: ((envelope: PiRuntimeEnvelope) => void) | undefined;
    const transport = {
      postMessage: (envelope: PiRuntimeEnvelope) => { sent.push(envelope); },
      onMessage: (callback: (envelope: PiRuntimeEnvelope) => void) => {
        receive = callback;
        return () => { receive = undefined; };
      },
    };
    const host = await createPiSdkSessionHost({ transport, cwd: dir, agentDir: dir });
    const dispose = createPiRuntime({ host, transport });

    try {
      receive?.(commandEnvelope("prompt-request", {
        type: "prompt", message: "A", promptId: "prompt-a", originToken: "origin-prompt-a",
      } as any));
      await vi.waitFor(() => expect(sent.some((envelope) =>
        "event" in envelope && envelope.event.type === "prompt_error",
      )).toBe(true));
      const terminal = sent.find((envelope) => "event" in envelope && envelope.event.type === "prompt_error");
      expect(terminal).toMatchObject({
        direction: "runtime-to-main",
        event: {
          type: "prompt_error",
          command: "prompt",
          promptId: "prompt-a",
          terminal: true,
          message: expect.stringMatching(/model/i),
        },
      });
      expect(sent.some((envelope) => "event" in envelope && envelope.event.type === "agent_start")).toBe(false);
    } finally {
      dispose();
    }
  });

  it("R8 round7 B2 turns a real SDK prepare rejection into a correlated terminal event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-prompt-prepare-error-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "auth.json"), '{"anthropic":{"type":"apiKey","apiKey":"test-only"}}', "utf8");
    const sent: PiRuntimeEnvelope[] = [];
    let receive: ((envelope: PiRuntimeEnvelope) => void) | undefined;
    const transport = {
      postMessage: (envelope: PiRuntimeEnvelope) => { sent.push(envelope); },
      onMessage: (callback: (envelope: PiRuntimeEnvelope) => void) => {
        receive = callback;
        return () => { receive = undefined; };
      },
    };
    const host = await createPiSdkSessionHost({ transport, cwd: dir, agentDir: dir });
    await host.current().setApiKey("anthropic", "test-only");
    await host.configureSaddle({
      tools: [],
      model: { provider: "anthropic", modelId: "claude-haiku-4-5" },
    });
    await host.newSession();
    const prepare = vi.spyOn(AgentSession.prototype as any, "_prepareRun")
      .mockRejectedValueOnce(new Error("deterministic prepare rejection"));
    const dispose = createPiRuntime({ host, transport });

    try {
      receive?.(commandEnvelope("prompt-request", {
        type: "prompt", message: "A", promptId: "prompt-prepare", originToken: "origin-prompt-prepare",
      } as any));
      await vi.waitFor(() => expect(sent.some((envelope) =>
        "event" in envelope && envelope.event.type === "prompt_error",
      )).toBe(true));
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(sent.find((envelope) => "event" in envelope && envelope.event.type === "prompt_error"))
        .toMatchObject({
          event: {
            type: "prompt_error", command: "prompt", promptId: "prompt-prepare",
            terminal: true, message: "deterministic prepare rejection",
          },
        });
      expect(sent.some((envelope) => "event" in envelope && envelope.event.type === "agent_start")).toBe(false);
      expect(sent.some((envelope) => "event" in envelope && envelope.event.type === "agent_settled")).toBe(false);
    } finally {
      dispose();
    }
  });

  it("R8 B1 stamps every real SDK tool envelope with its overlapping prompt origin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-prompt-origin-"));
    tempDirs.push(dir);
    const input = join(dir, "input.txt");
    writeFileSync(input, "origin test", "utf8");
    const sent: PiRuntimeEnvelope[] = [];
    const origins = new Map<string, string | undefined>();
    let receive: ((envelope: PiRuntimeEnvelope) => void) | undefined;
    const transport = {
      postMessage: (envelope: PiRuntimeEnvelope) => {
        sent.push(envelope);
        if ("action" in envelope || "connectorRead" in envelope || "proposal" in envelope) {
          const requestId = "action" in envelope ? envelope.action.requestId
            : "connectorRead" in envelope ? envelope.connectorRead.requestId
              : envelope.proposal.requestId;
          origins.set(requestId, envelope.originToken);
          if ("action" in envelope) {
            receive?.({ direction: "main-to-runtime", requestId, sessionGeneration: 0, actionResult: {
              requestId, status: "executed", decision: { decision: "allow", ruleId: "test", reason: "test" },
              result: { canonicalPath: input },
            } });
          } else if ("connectorRead" in envelope) {
            receive?.({ direction: "main-to-runtime", requestId, sessionGeneration: 0,
              connectorReadResult: { ok: true, data: {} } });
          } else {
            receive?.({ direction: "main-to-runtime", requestId, sessionGeneration: 0,
              proposalDecision: { approved: true, proposalId: requestId, status: "executed" } });
          }
        }
      },
      onMessage: (callback: (envelope: PiRuntimeEnvelope) => void) => {
        receive = callback;
        return () => { receive = undefined; };
      },
    };
    const host = await createPiSdkSessionHost({ transport, cwd: dir, agentDir: dir });
    await host.configureSaddle({
      cwd: dir, workspaceRoot: dir, tools: ["read", "document.read", "report.export"],
    });
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
    // Keep the real AgentSession and its registered tool definitions; replace only
    // the provider-driving loop so each prompt can deterministically call tools.
    const prompt = vi.spyOn(AgentSession.prototype as any, "prompt").mockImplementation(async function (
      this: any, text: string,
    ) {
      await (text === "A" ? gateA : gateB);
      const tools = new Map(this.agent.state.tools.map((tool: any) => [tool.name, tool]));
      const calls: Array<[string, Record<string, unknown>]> = text === "A"
        ? [["read", { path: input }], ["document_read", { documents: [input] }], ["report_export", { title: "origin", format: "docx", content: text }]]
        : [["read", { path: input }], ["document_read", { documents: [input] }], ["report_export", { title: "origin", format: "docx", content: text }]];
      for (const [name, params] of calls) {
        const tool = tools.get(name);
        expect(tool, `missing real SDK tool ${name}`).toBeDefined();
        void tool.execute(`${text}-${name}`, params, undefined, undefined, {}).catch(() => undefined);
      }
    });
    const dispose = createPiRuntime({ host, transport });

    try {
      receive?.(commandEnvelope("prompt-A", {
        type: "prompt", message: "A", promptId: "prompt-A", originToken: "origin-A",
      } as any));
      receive?.(commandEnvelope("prompt-B", {
        type: "prompt", message: "B", promptId: "prompt-B", originToken: "origin-B",
      } as any));
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
      releaseB();
      await vi.waitFor(() => expect(origins.size).toBe(3));
      releaseA();
      await vi.waitFor(() => expect(origins.size).toBe(6));

      expect([...origins.keys()].filter((id) => !id.startsWith("A-") && !id.startsWith("B-"))).toHaveLength(2);
      for (const prefix of ["A", "B"]) {
        expect(origins.get(`${prefix}-document_read`)).toBe(`origin-${prefix}`);
        expect(origins.get(`${prefix}-report_export`)).toBe(`origin-${prefix}`);
      }
      expect([...origins.values()].filter((origin) => origin === "origin-A")).toHaveLength(3);
      expect([...origins.values()].filter((origin) => origin === "origin-B")).toHaveLength(3);
      expect(currentPromptOriginToken()).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("does not let a saddle system prompt drop the skill catalog", () => {
    const applied = applySaddleSystemPrompt("通用智能体", {
      systemPromptOptions: {
        skills: [{
          name: "using-superpowers",
          description: "Use skills first",
          filePath: "/lib/using-superpowers/SKILL.md",
          baseDir: "/lib/using-superpowers",
          sourceInfo: { path: "/lib/using-superpowers/SKILL.md", source: "saddle", scope: "user", origin: "top-level" },
          disableModelInvocation: false,
        }],
        selectedTools: ["read"],
      },
    });
    expect(applied?.systemPrompt).toContain("<available_skills>");
    expect(applied?.systemPrompt).toContain("using-superpowers");
  });

  it("passes prompt/steer/followUp text through without /skill: rewrite", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/pi-sdk-runtime.ts"), "utf8");
    expect(src).not.toMatch(/expandLeadingSkillSlash|loadSkillSlashAliases|skillSlashAliases|withSkillSlash/);
    expect(src).not.toMatch(/`\/skill:\$\{/);
    expect(src).not.toMatch(/"\/skill:"\s*\+/);
    expect(src).toMatch(/startPromptWithoutBlocking\(\s*session,\s*text,/);
    expect(src).toMatch(/session\.steer\(text,\s*images\)/);
    expect(src).toMatch(/session\.followUp\(text,\s*images\)/);
    expect(src).toMatch(/pendingConnectorReads/);
    expect(src).toMatch(/connectorRead:/);
    expect(src).toMatch(/connectorReadEnvelope/);
    expect(src).toMatch(/promptWorkingDirectory/);
    expect(src).toMatch(/systemPromptExtensionFactory\(\s*\(\) => pendingSaddle\?\.systemPrompt,\s*\(\) => pendingSaddle,\s*syncSaddleToolsOnPrompt,/);
    // Pi 1.0：工具必须进会话注册表，禁止再直接写 agent.state.tools（会在 prompt 被 loadout 覆盖）
    expect(src).not.toMatch(/agent\.state\.tools\s*=/);
    expect(src).toMatch(/customTools:\s*saddleTools/);
    // `tools:` 会在创建时冻结白名单，换鞍时新增的工具名会被静默丢弃；必须用 noTools 关默认工具
    expect(src).toMatch(/noTools:\s*"builtin"/);
    expect(src).not.toMatch(/tools:\s*saddleToolNames/);
    expect(src).toMatch(/registerSaddleTools/);
    expect(src).toMatch(/setActiveTools/);
  });

  it("does not enable Pi 1.0 prompt cache warming (per-call billing)", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-settings-"));
    writeFileSync(join(agentDir, "auth.json"), '{"anthropic":{"type":"apiKey","apiKey":"x"}}', "utf8");
    writeFileSync(join(agentDir, "models.json"), '{"providers":{}}', "utf8");

    const settingsManager = createPiSettingsManager(agentDir, agentDir);
    expect(settingsManager.getCacheWarmingMode()).toBe("off");
    expect(settingsManager.getImageAutoResize()).toBe(false);

    // Pi 的 settings 落盘是异步队列；等它写完再验，同时确认不会破坏同目录的 auth.json / models.json
    const settingsPath = join(agentDir, "settings.json");
    for (let attempt = 0; attempt < 100 && !existsSync(settingsPath); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const written = JSON.parse(readFileSync(settingsPath, "utf8")) as { cacheWarming?: string };
    expect(written.cacheWarming).toBe("off");
    expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"))).toHaveProperty("anthropic");
    expect(JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"))).toHaveProperty("providers");
    expect(createPiSettingsManager(agentDir, agentDir).getCacheWarmingMode()).toBe("off");
    expect(createPiSettingsManager(agentDir, agentDir).getImageAutoResize()).toBe(false);
  });
});

describe("pi-sdk-runtime agentDir resolution", () => {
  it("prefers explicit agentDir over env and fallback", () => {
    process.env.PI_CODING_AGENT_DIR = "C:/env/pi-agent";
    expect(resolveAgentDir("C:/explicit/pi-agent")).toBe("C:/explicit/pi-agent");
  });

  it("falls back to PI_CODING_AGENT_DIR when no explicit value is provided", () => {
    process.env.PI_CODING_AGENT_DIR = "C:/env/pi-agent";
    expect(resolveAgentDir()).toBe("C:/env/pi-agent");
  });

  it("falls back to the SDK agent dir when neither is set", () => {
    delete process.env.PI_CODING_AGENT_DIR;
    expect(resolveAgentDir()).toBeTypeOf("string");
  });
});
