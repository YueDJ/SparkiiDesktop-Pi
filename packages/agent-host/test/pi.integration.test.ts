import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { PiRuntimeSupervisor } from "../src/pi-runtime-supervisor.js";
import {
  type PiRuntimeEnvelope,
  type PiRuntimeHostHandle,
} from "../src/pi-runtime-transport.js";

const childPath = fileURLToPath(new URL("./fixtures/pi-runtime-test-child.mjs", import.meta.url));

function forkHandle(): PiRuntimeHostHandle {
  const child: ChildProcess = fork(childPath, [], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  return {
    postMessage: (envelope) => child.send(envelope),
    onMessage: (callback) => {
      const listener = (envelope: PiRuntimeEnvelope) => callback(envelope);
      child.on("message", listener);
      return () => child.removeListener("message", listener);
    },
    onExit: (callback) => {
      const listener = (code: number | null) => callback(code);
      child.on("exit", listener);
      return () => child.removeListener("exit", listener);
    },
    kill: () => child.kill(),
  };
}

describe("PiRuntimeSupervisor integration", () => {
  it("round-trips commands and events through a real child process", async () => {
    const supervisor = new PiRuntimeSupervisor(forkHandle);
    const client = await supervisor.start();
    const events: unknown[] = [];
    client.onEvent((event) => events.push(event));
    const response = await client.send({ type: "abort" });
    expect(response.success).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(events).toContainEqual({ type: "agent_start" });
    await supervisor.stop();
  });
});
