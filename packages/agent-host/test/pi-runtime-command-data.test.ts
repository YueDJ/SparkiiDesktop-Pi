import { describe, it, expect, vi } from "vitest";
import { createPiRuntime, type PiRuntimeSession, type PiRuntimeSessionHost } from "../src/pi-runtime.js";
import { commandEnvelope, type PiRuntimeEnvelope } from "../src/pi-runtime-transport.js";
import { sessionStateSnapshot } from "../src/pi-sdk-runtime.js";

function makeHost() {
  const session = {
    prompt: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    setAutoRetry: vi.fn(async () => {}),
    setAutoCompaction: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    onRuntimeError: vi.fn(() => () => {}),
    getMessages: vi.fn(() => [{ role: "user", text: "hi" }]),
    getSessionEntries: vi.fn(() => [{ type: "message", message: { role: "user", content: "hi" } }]),
    getState: vi.fn(() => ({ sessionId: "s1", sessionFile: "/tmp/s.json" })),
    dispose: vi.fn(),
  } as unknown as PiRuntimeSession;
  const host = {
    current: () => session,
    newSession: vi.fn(async () => {}),
    switchSession: vi.fn(async () => {}),
    configureSaddle: vi.fn(async () => {}),
  } as unknown as PiRuntimeSessionHost;
  return { host, session };
}

describe("pi runtime command data", () => {
  it("returns state data for get_state", async () => {
    const { host } = makeHost();
    const posted: PiRuntimeEnvelope[] = [];
    let handler: (e: PiRuntimeEnvelope) => void = () => {};
    const transport = {
      postMessage: (e: PiRuntimeEnvelope) => posted.push(e),
      onMessage: (cb: (e: PiRuntimeEnvelope) => void) => { handler = cb; return () => {}; },
    };
    createPiRuntime({ host, transport });
    handler(commandEnvelope("1", { type: "get_state" }));
    await new Promise((r) => setTimeout(r, 0));
    const resp = posted.find((e) => "response" in e && e.id === "1");
    expect((resp as any)?.response?.data).toMatchObject({ sessionFile: "/tmp/s.json" });
  });

  it("returns messages for get_messages", async () => {
    const { host } = makeHost();
    const posted: PiRuntimeEnvelope[] = [];
    let handler: (e: PiRuntimeEnvelope) => void = () => {};
    const transport = {
      postMessage: (e: PiRuntimeEnvelope) => posted.push(e),
      onMessage: (cb: (e: PiRuntimeEnvelope) => void) => { handler = cb; return () => {}; },
    };
    createPiRuntime({ host, transport });
    handler(commandEnvelope("2", { type: "get_messages" }));
    await new Promise((r) => setTimeout(r, 0));
    const resp = posted.find((e) => "response" in e && e.id === "2");
    expect((resp as any)?.response?.data).toEqual([{ role: "user", text: "hi" }]);
  });

  it("returns the active branch for get_session_entries", async () => {
    const { host, session } = makeHost();
    const posted: PiRuntimeEnvelope[] = [];
    let handler: (e: PiRuntimeEnvelope) => void = () => {};
    const transport = {
      postMessage: (e: PiRuntimeEnvelope) => posted.push(e),
      onMessage: (cb: (e: PiRuntimeEnvelope) => void) => { handler = cb; return () => {}; },
    };
    createPiRuntime({ host, transport });
    handler(commandEnvelope("2b", { type: "get_session_entries" }));
    await new Promise((r) => setTimeout(r, 0));
    const resp = posted.find((e) => "response" in e && e.id === "2b");
    expect((resp as any)?.response?.success).toBe(true);
    expect(session.getSessionEntries).toHaveBeenCalled();
    expect((resp as any)?.response?.data).toEqual([{ type: "message", message: { role: "user", content: "hi" } }]);
  });

  it("forwards streamingMessage from get_state", async () => {
    const { host, session } = makeHost();
    const streamingMessage = { role: "assistant", content: [{ type: "text", text: "第3条" }] };
    (session.getState as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      sessionId: "s1",
      isStreaming: true,
      streamingMessage,
    });
    const posted: PiRuntimeEnvelope[] = [];
    let handler: (e: PiRuntimeEnvelope) => void = () => {};
    const transport = {
      postMessage: (e: PiRuntimeEnvelope) => posted.push(e),
      onMessage: (cb: (e: PiRuntimeEnvelope) => void) => { handler = cb; return () => {}; },
    };
    createPiRuntime({ host, transport });
    handler(commandEnvelope("2c", { type: "get_state" }));
    await new Promise((r) => setTimeout(r, 0));
    const resp = posted.find((e) => "response" in e && e.id === "2c");
    expect((resp as any)?.response?.data).toMatchObject({ isStreaming: true, streamingMessage });
  });

  it("dispatches configure_session to the host", async () => {
    const { host } = makeHost();
    const posted: PiRuntimeEnvelope[] = [];
    let handler: (e: PiRuntimeEnvelope) => void = () => {};
    const transport = {
      postMessage: (e: PiRuntimeEnvelope) => posted.push(e),
      onMessage: (cb: (e: PiRuntimeEnvelope) => void) => { handler = cb; return () => {}; },
    };
    createPiRuntime({ host, transport });
    const saddle = { tools: ["read", "bash"], skillsDir: "/tmp/skills" };
    handler(commandEnvelope("3", { type: "configure_session", saddle }));
    await new Promise((r) => setTimeout(r, 0));
    expect(host.configureSaddle).toHaveBeenCalledWith(saddle);
  });
});

describe("session state snapshot", () => {
  it("carries the in-flight streamingMessage from agent state", () => {
    const streamingMessage = { role: "assistant", content: [{ type: "text", text: "第3条" }] };
    const snapshot = sessionStateSnapshot({
      isStreaming: true,
      isCompacting: false,
      sessionId: "s1",
      sessionFile: "/tmp/s.jsonl",
      agent: { state: { streamingMessage } },
    });
    expect(snapshot).toMatchObject({
      streaming: true,
      isStreaming: true,
      sessionId: "s1",
      streamingMessage,
    });
  });

  it("reports a null streamingMessage when nothing is in flight", () => {
    const snapshot = sessionStateSnapshot({
      isStreaming: false,
      sessionId: "s1",
      agent: { state: {} },
    });
    expect(snapshot.streamingMessage).toBeNull();
    expect(snapshot.isStreaming).toBe(false);
  });
});
