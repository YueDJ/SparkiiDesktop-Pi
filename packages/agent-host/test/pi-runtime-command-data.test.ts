import { describe, it, expect, vi } from "vitest";
import { createPiRuntime, type PiRuntimeSession, type PiRuntimeSessionHost } from "../src/pi-runtime.js";
import { commandEnvelope, type PiRuntimeEnvelope } from "../src/pi-runtime-transport.js";

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
    getMessages: vi.fn(() => [{ role: "user", text: "hi" }]),
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
});
