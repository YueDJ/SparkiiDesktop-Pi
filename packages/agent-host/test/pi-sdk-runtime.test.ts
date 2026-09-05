import { describe, it, expect, afterEach, vi } from "vitest";
import {
  bindRuntimeEventPipe,
  buildSkillLoaderOptions,
  createPiSdkSessionHost,
  resolveAgentDir,
} from "../src/pi-sdk-runtime.js";

const PREV_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
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

describe("bindRuntimeEventPipe", () => {
  function fakeSession() {
    const listeners = new Set<(event: unknown) => void>();
    return {
      listeners,
      bindExtensions: vi.fn(async () => {}),
      subscribe: (cb: (event: unknown) => void) => {
        listeners.add(cb);
        return () => { listeners.delete(cb); };
      },
      emit: (event: unknown) => { for (const listener of listeners) listener(event); },
    };
  }

  it("reattaches subscribe after the runtime replaces the session", async () => {
    const first = fakeSession();
    const second = fakeSession();
    let current = first;
    let rebind: ((session: typeof first) => Promise<void>) | undefined;
    const runtime = {
      get session() { return current; },
      setRebindSession(fn?: (session: typeof first) => Promise<void>) { rebind = fn; },
    };
    const received: unknown[] = [];
    const listeners = new Set<(event: unknown) => void>([(event) => received.push(event)]);
    bindRuntimeEventPipe(runtime, listeners);

    first.emit({ type: "agent_start" });
    expect(received).toEqual([{ type: "agent_start" }]);

    current = second;
    await rebind?.(second);
    expect(second.bindExtensions).toHaveBeenCalledWith({});
    expect(first.listeners.size).toBe(0);

    first.emit({ type: "stale" });
    second.emit({ type: "entry_appended" });
    expect(received).toEqual([{ type: "agent_start" }, { type: "entry_appended" }]);
  });
});
