import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { PiRuntimePool } from "../src/pi-runtime-pool.js";
import type { PiRuntimeEnvelope, PiRuntimeHostHandle } from "../src/pi-runtime-transport.js";

const childPath = fileURLToPath(new URL("./fixtures/pi-runtime-saddle-child.mjs", import.meta.url));

function forkHandle(): PiRuntimeHostHandle {
  const child: ChildProcess = fork(childPath, [], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
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

describe("PiRuntimePool saddle wiring", () => {
  it("configures saddle then switches to resume file", async () => {
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: forkHandle });
    const slot = await pool.acquire("s1", {
      saddle: { tools: ["read", "bash"] },
      resumeSessionFile: "/tmp/session.json",
    });
    const state = await slot.client.send({ type: "get_state" });
    expect(state.data).toMatchObject({ sessionFile: "/tmp/session.json" });
    await pool.release("s1");
    await pool.stopAll();
  });

  it("fails closed when configure_session rejects", async () => {
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: forkHandle });
    await expect(pool.acquire("s2", { saddle: { tools: ["__unknown__"] } })).rejects.toThrow(/unknown tool/);
    await pool.stopAll();
  });
});
