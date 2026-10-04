import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiSdkSessionHost } from "../src/pi-sdk-runtime.js";

/**
 * 产品级装配回归（真实 SDK，离线）：进程池槽位复用时，`configure_session` 会在一台**已存在**的会话上换鞍。
 * Pi 1.0 的工具可见面由「注册表（customTools / 扩展 registerTool）+ 激活集合」决定，且
 * `tools:` 选项会在创建时冻结一份白名单（`agent-session.js` 构造后无更新点，注册表按它过滤），
 * 所以换鞍必须走 `noTools: "builtin"` + `registerTool` + `setActiveTools`。
 * 这组用例锁死：不多（不激活内置默认工具）、不少（新增工具真的可用）、不泄漏（撤下的工具不再声明）。
 */

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-host-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const transport = {
  postMessage: (): void => {},
  onMessage: (): (() => void) => () => {},
};

type Host = Awaited<ReturnType<typeof createPiSdkSessionHost>>;

function activeTools(host: Host): string[] {
  const state = host.current().getState();
  return [...((state.activeToolNames as string[] | undefined) ?? [])].sort();
}

async function makeHost(): Promise<{ dir: string; host: Host }> {
  const dir = tempDir();
  const host = await createPiSdkSessionHost({ transport, cwd: dir, agentDir: dir });
  return { dir, host };
}

describe("pi sdk host saddle tool assembly", () => {
  it("exposes no tools at all before a saddle is configured", async () => {
    const { host } = await makeHost();
    expect(activeTools(host)).toEqual([]);
  });

  it("applies the saddle to the live session and swaps it on reconfigure", async () => {
    const { dir, host } = await makeHost();

    await host.configureSaddle({ tools: ["read"], cwd: dir, workspaceRoot: dir });
    expect(activeTools(host)).toEqual(["read"]);

    // 新增工具必须真的可用：`tools:` 白名单一旦冻结，这里会静默变回 ["read"]
    await host.configureSaddle({ tools: ["read", "write"], cwd: dir, workspaceRoot: dir });
    expect(activeTools(host)).toEqual(["read", "write"]);

    // 撤下的工具不得残留（跨 profile 不泄漏）
    await host.configureSaddle({ tools: ["write"], cwd: dir, workspaceRoot: dir });
    expect(activeTools(host)).toEqual(["write"]);

    // 空鞍 = 模型看不到任何工具，且不会回退到内置默认工具
    await host.configureSaddle({ tools: [], cwd: dir, workspaceRoot: dir });
    expect(activeTools(host)).toEqual([]);
  });

  it("re-applies the saddle after the session is replaced", async () => {
    const { dir, host } = await makeHost();
    await host.configureSaddle({ tools: ["read"], cwd: dir, workspaceRoot: dir });
    expect(activeTools(host)).toEqual(["read"]);

    await host.newSession();
    expect(activeTools(host)).toEqual(["read"]);

    const sessionPath = join(dir, "resume.jsonl");
    writeFileSync(
      sessionPath,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        timestamp: new Date().toISOString(),
        cwd: dir,
      })}\n`,
      "utf8",
    );
    await host.switchSession(sessionPath);
    expect(activeTools(host)).toEqual(["read"]);
  });

  it("fails closed on an unknown tool name and stops exposing the previous tools", async () => {
    const { dir, host } = await makeHost();
    await host.configureSaddle({ tools: ["read"], cwd: dir, workspaceRoot: dir });
    expect(activeTools(host)).toEqual(["read"]);

    await expect(
      host.configureSaddle({ tools: ["__not_a_tool__"], cwd: dir, workspaceRoot: dir }),
    ).rejects.toThrow(/unknown tool/);
    expect(activeTools(host)).toEqual([]);
  });
});
