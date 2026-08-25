import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ProposalRequest } from "@sparkii/approval";
import type { ProposalDecision } from "./pi-runtime-transport.js";
import { isPathInside } from "./workspace-guard.js";

export interface CodingToolsContext {
  cwd: string;
  workspaceRoot: string;
  propose(request: ProposalRequest & { requestId: string }): Promise<ProposalDecision>;
}

function guardPath(ctx: CodingToolsContext, absolutePath: string): void {
  if (!isPathInside(ctx.workspaceRoot, absolutePath)) {
    throw new Error(`拒绝访问:${absolutePath} 不在工作区内`);
  }
}

export function createCodingToolDefinitions(ctx: CodingToolsContext): Array<ToolDefinition<any, any, any>> {
  const bash = createBashToolDefinition(ctx.cwd, {
    operations: {
      exec: async (command: string, cwd: string, opts: { onData: (data: Buffer) => void }) => {
        const decision = await ctx.propose({
          requestId: randomUUID(),
          toolName: "bash",
          targetSystem: "general",
          summary: command.slice(0, 512),
          payload: { command, cwd, workspaceRoot: ctx.workspaceRoot },
          risk: "write",
        });
        if (!decision.approved) {
          opts.onData(Buffer.from(`操作未执行:${decision.status}\n`));
          return { exitCode: 1 };
        }
        const result = (decision.result ?? {}) as { exitCode?: number | null; output?: string };
        if (result.output) opts.onData(Buffer.from(result.output));
        return { exitCode: result.exitCode ?? 0 };
      },
    },
  });

  const edit = createEditToolDefinition(ctx.cwd, {
    operations: {
      readFile: async (absolutePath: string) => {
        guardPath(ctx, absolutePath);
        return readFile(absolutePath);
      },
      access: async (absolutePath: string) => {
        guardPath(ctx, absolutePath);
        await access(absolutePath);
      },
      writeFile: async (absolutePath: string, content: string) => {
        guardPath(ctx, absolutePath);
        const decision = await ctx.propose({
          requestId: randomUUID(),
          toolName: "edit",
          targetSystem: "general",
          summary: `edit ${absolutePath}`,
          payload: { path: absolutePath, content },
          risk: "write",
        });
        if (!decision.approved) throw new Error(`编辑未执行:${decision.status}`);
      },
    },
  });

  const write = createWriteToolDefinition(ctx.cwd, {
    operations: {
      mkdir: async (dir: string) => {
        guardPath(ctx, dir);
      },
      writeFile: async (absolutePath: string, content: string) => {
        guardPath(ctx, absolutePath);
        const decision = await ctx.propose({
          requestId: randomUUID(),
          toolName: "write",
          targetSystem: "general",
          summary: `write ${absolutePath}`,
          payload: { path: absolutePath, content },
          risk: "write",
        });
        if (!decision.approved) throw new Error(`写入未执行:${decision.status}`);
      },
    },
  });

  return [bash, edit, write];
}
