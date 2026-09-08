import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PiRuntimePool } from "../src/pi-runtime-pool.js";
import type { PiRuntimeEnvelope, PiRuntimeHostHandle } from "../src/pi-runtime-transport.js";

const childPath = fileURLToPath(new URL("./fixtures/pi-runtime-skills-child.mjs", import.meta.url));

function writeSkill(root: string, name: string, description: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
    "utf8",
  );
}

function forkHandle(agentDir: string, children: ChildProcess[]): () => PiRuntimeHostHandle {
  return () => {
    const child = fork(childPath, [], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    });
    children.push(child);
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
  };
}

describe("PiRuntimePool skill isolation", () => {
  const dirs: string[] = [];
  const children: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of children) {
      if (!child.killed && child.exitCode === null) child.kill();
    }
    children.length = 0;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("reloads Pi getSkills on the reused process after configure + new_session", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-pool-agent-"));
    const skillA = mkdtempSync(join(tmpdir(), "pi-pool-a-"));
    const skillB = mkdtempSync(join(tmpdir(), "pi-pool-b-"));
    dirs.push(agentDir, skillA, skillB);
    writeSkill(skillA, "skill-alpha", "Alpha only.");
    writeSkill(skillB, "skill-beta", "Beta only.");

    const pool = new PiRuntimePool({
      maxAgents: 1,
      makeSupervisor: forkHandle(agentDir, children),
    });

    const first = await pool.acquire("general-session", {
      saddle: { tools: ["read"], skillsDir: skillA },
    });
    const boundA = await first.client.send({ type: "new_session" });
    expect(boundA.success).toBe(true);
    expect(boundA.data).toMatchObject({ skills: ["skill-alpha"] });

    await pool.release("general-session");

    const second = await pool.acquire("contract-session", {
      saddle: { tools: ["read"], skillsDir: skillB },
    });
    expect(second.client).toBe(first.client);
    expect(children).toHaveLength(1);

    const leftover = await second.client.send({ type: "get_state" });
    expect(leftover.data).toMatchObject({ skills: ["skill-alpha"] });

    const boundB = await second.client.send({ type: "new_session" });
    expect(boundB.success).toBe(true);
    expect(boundB.data).toMatchObject({ skills: ["skill-beta"] });
    expect((boundB.data as { skills: string[] }).skills).not.toContain("skill-alpha");

    await pool.stopAll();
  });
});
