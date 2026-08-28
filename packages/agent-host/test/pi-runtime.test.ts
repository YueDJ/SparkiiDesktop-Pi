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
  const runtimeErrorListeners = new Set<(error: any) => void>();
  return {
    emit: (event) => listeners.forEach((cb) => cb(event)),
    prompt: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    clearQueue: vi.fn(async () => ({ steering: ["先做这个"], followUp: ["做完后整理"] })),
    setSteeringMode: vi.fn(async () => {}),
    setFollowUpMode: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    setAutoRetry: vi.fn(async () => {}),
    setAutoCompaction: vi.fn(async () => {}),
    setSessionName: vi.fn(async () => {}),
    setApiKey: vi.fn(async () => {}),
    removeApiKey: vi.fn(async () => {}),
    complete: vi.fn(async () => "标题"),
    listModels: vi.fn(async () => []),
    setThinkingLevel: vi.fn(),
    getThinkingLevel: vi.fn(() => "medium"),
    getAvailableThinkingLevels: vi.fn(() => ["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
    listProviders: vi.fn(async () => [
      { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKeyAuth: true, oauthAuth: false },
    ]),
    subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    onRuntimeError: (cb: (error: any) => void) => { runtimeErrorListeners.add(cb); return () => runtimeErrorListeners.delete(cb); },
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

  it("forwards runtime errors through the event transport", async () => {
    let runtimeErrorCb: ((error: any) => void) | undefined;
    const session = fakeSession();
    session.onRuntimeError = vi.fn((cb: (error: any) => void) => {
      runtimeErrorCb = cb;
      return () => {};
    });
    const host: PiRuntimeSessionHost = {
      current: () => session,
      newSession: vi.fn(async () => {}),
      switchSession: vi.fn(async () => {}),
      configureSaddle: vi.fn(async () => {}),
    };
    const sent: PiRuntimeEnvelope[] = [];
    const transport = {
      postMessage: (env: PiRuntimeEnvelope) => sent.push(env),
      onMessage: () => () => {},
    };
    createPiRuntime({ host, transport: transport as any });

    runtimeErrorCb?.({ message: "api rate limit", command: "prompt", stack: "stack" });
    expect(sent).toContainEqual(eventEnvelope({
      type: "runtime_error",
      message: "api rate limit",
      command: "prompt",
      stack: "stack",
    }));
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

    transport.emit(commandEnvelope("r2b", { type: "remove_api_key", provider: "deepseek" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.removeApiKey).toHaveBeenCalledWith("deepseek");

    transport.emit(commandEnvelope("r3", { type: "complete", provider: "deepseek", modelId: "m", text: "hi" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.complete).toHaveBeenCalledWith("deepseek", "m", "hi");
    expect(sent).toContainEqual(responseEnvelope("r3", {
      id: "r3", type: "response", command: "complete", success: true, data: "标题",
    }));
  });

  it("routes list_providers to the session and returns provider info", async () => {
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

    transport.emit(commandEnvelope("r4", { type: "list_providers" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toContainEqual(responseEnvelope("r4", {
      id: "r4", type: "response", command: "list_providers", success: true,
      data: [
        { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKeyAuth: true, oauthAuth: false },
      ],
    }));
  });

  it("routes thinking level commands to the session", async () => {
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

    transport.emit(commandEnvelope("t1", { type: "set_thinking_level", level: "high" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.setThinkingLevel).toHaveBeenCalledWith("high");

    transport.emit(commandEnvelope("t2", { type: "get_thinking_level" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toContainEqual(responseEnvelope("t2", {
      id: "t2", type: "response", command: "get_thinking_level", success: true, data: "medium",
    }));

    transport.emit(commandEnvelope("t3", { type: "list_thinking_levels" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toContainEqual(responseEnvelope("t3", {
      id: "t3", type: "response", command: "list_thinking_levels", success: true,
      data: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    }));
  });

  it("routes queue commands and returns cleared queue data", async () => {
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

    transport.emit(commandEnvelope("q1", { type: "clear_queue" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.clearQueue).toHaveBeenCalled();
    expect(sent).toContainEqual(responseEnvelope("q1", {
      id: "q1", type: "response", command: "clear_queue", success: true,
      data: { steering: ["先做这个"], followUp: ["做完后整理"] },
    }));

    transport.emit(commandEnvelope("q2", { type: "set_steering_mode", mode: "one-at-a-time" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.setSteeringMode).toHaveBeenCalledWith("one-at-a-time");

    transport.emit(commandEnvelope("q3", { type: "set_follow_up_mode", mode: "all" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.setFollowUpMode).toHaveBeenCalledWith("all");
  });
});
