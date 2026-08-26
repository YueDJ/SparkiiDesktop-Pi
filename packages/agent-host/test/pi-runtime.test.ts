import { describe, it, expect, vi } from "vitest";
import {
  createPiRuntime,
  type PiRuntimeSession,
  type PiRuntimeSessionHost,
} from "../src/pi-runtime.js";
import {
  commandEnvelope,
  eventEnvelope,
  responseEnvelope,
  readyEnvelope,
  type PiRuntimeEnvelope,
} from "../src/pi-runtime-transport.js";

function fakeSession(): PiRuntimeSession & { emit: (event: any) => void } {
  const listeners = new Set<(event: any) => void>();
  return {
    emit: (event) => listeners.forEach((cb) => cb(event)),
    prompt: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    setAutoRetry: vi.fn(async () => {}),
    setAutoCompaction: vi.fn(async () => {}),
    setSessionName: vi.fn(async () => {}),
    setApiKey: vi.fn(async () => {}),
    complete: vi.fn(async () => "标题"),
    listModels: vi.fn(async () => []),
    testConnection: vi.fn(async () => ({ ok: true })),
    subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    getMessages: () => [{ role: "user", text: "hi" }],
    getState: () => ({ streaming: false }),
    dispose: vi.fn(),
  } as any;
}

describe("createPiRuntime", () => {
  it("routes commands and emits events", async () => {
    const session = fakeSession();
    const current = session;
    const host: PiRuntimeSessionHost = {
      current: () => current,
      newSession: vi.fn(async () => {}),
      switchSession: vi.fn(async () => {}),
      configureSaddle: vi.fn(async () => {}),
    };
    const sent: PiRuntimeEnvelope[] = [];
    const transport = {
      postMessage: (env: PiRuntimeEnvelope) => sent.push(env),
      onMessage: (cb: (env: PiRuntimeEnvelope) => void) => {
        transport.emit = cb;
        return () => {};
      },
      emit: (_env: PiRuntimeEnvelope) => {},
    };
    const dispose = createPiRuntime({ host, transport });
    expect(sent).toContainEqual(readyEnvelope());

    transport.emit(commandEnvelope("r1", { type: "abort" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.abort).toHaveBeenCalled();
    expect(sent).toContainEqual(responseEnvelope("r1", {
      id: "r1", type: "response", command: "abort", success: true,
    }));

    const onMainEvent = vi.fn();
    const emitted = eventEnvelope({ type: "agent_start" });
    session.emit({ type: "agent_start" });
    expect(sent).toContainEqual(emitted);
    onMainEvent();
    dispose();
  });

  it("re-subscribes after switchSession", async () => {
    const first = fakeSession();
    const second = fakeSession();
    let current = first;
    const host: PiRuntimeSessionHost = {
      current: () => current,
      newSession: vi.fn(async () => { current = second; }),
      switchSession: vi.fn(async () => { current = second; }),
      configureSaddle: vi.fn(async () => {}),
    };
    const transport = {
      postMessage: () => {},
      onMessage: () => () => {},
    };
    createPiRuntime({ host, transport: transport as any });
    await host.switchSession("x.jsonl");
    expect(host.switchSession).toHaveBeenCalledWith("x.jsonl");
  });

  it("routes new session/model commands", async () => {
    const session = fakeSession();
    const host: PiRuntimeSessionHost = {
      current: () => session,
      newSession: vi.fn(async () => {}),
      switchSession: vi.fn(async () => {}),
      configureSaddle: vi.fn(async () => {}),
    };
    const sent: PiRuntimeEnvelope[] = [];
    const transport = {
      postMessage: (env: PiRuntimeEnvelope) => sent.push(env),
      onMessage: (cb: (env: PiRuntimeEnvelope) => void) => {
        transport.emit = cb;
        return () => {};
      },
      emit: (_env: PiRuntimeEnvelope) => {},
    };
    createPiRuntime({ host, transport });

    transport.emit(commandEnvelope("r1", { type: "set_session_name", name: "标题A" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.setSessionName).toHaveBeenCalledWith("标题A");
    expect(sent).toContainEqual(responseEnvelope("r1", {
      id: "r1", type: "response", command: "set_session_name", success: true,
    }));

    transport.emit(commandEnvelope("r2", { type: "set_api_key", provider: "deepseek", apiKey: "sk-x" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.setApiKey).toHaveBeenCalledWith("deepseek", "sk-x");

    transport.emit(commandEnvelope("r3", { type: "complete", provider: "deepseek", modelId: "m", text: "hi" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.complete).toHaveBeenCalledWith("deepseek", "m", "hi");
    expect(sent).toContainEqual(responseEnvelope("r3", {
      id: "r3", type: "response", command: "complete", success: true, data: "标题",
    }));
  });
});
