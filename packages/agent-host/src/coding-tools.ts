import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { relative } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ProposalRequest } from "@sparkii/approval";
import { toPreviewLines } from "@sparkii/approval";
import type { ProposalDecision } from "./pi-runtime-transport.js";
import { isPathInside } from "./workspace-guard.js";

export interface CodingToolsContext {
  cwd: string;
  workspaceRoot: string;
  propose(request: ProposalRequest & { requestId: string }): Promise<ProposalDecision>;
  recordSessionEntry?(customType: string, data: Record<string, unknown>): void;
}

const activeToolCallId = new AsyncLocalStorage<string>();

function workspaceRelative(workspaceRoot: string, absolutePath: string): string {
  const rel = relative(workspaceRoot, absolutePath);
  if (!rel || rel.startsWith("..")) return absolutePath;
  return rel;
}

function bashSummary(command: string): string {
  const firstLine = command.split("\n")[0] ?? "";
  return firstLine.slice(0, 120);
}

function guardPath(ctx: CodingToolsContext, absolutePath: string): void {
  if (!isPathInside(ctx.workspaceRoot, absolutePath)) {
    throw new Error(`拒绝访问:${absolutePath} 不在工作区内`);
  }
}

function slimApprovalData(
  requestId: string,
  toolName: string,
  status: "pending" | "approved" | "denied",
  extra: { proposalId?: string } = {},
): Record<string, unknown> {
  const data: Record<string, unknown> = { requestId, toolName, status };
  const toolCallId = activeToolCallId.getStore();
  if (toolCallId) data.toolCallId = toolCallId;
  if (extra.proposalId) data.proposalId = extra.proposalId;
  return data;
}

async function proposeWrite(
  ctx: CodingToolsContext,
  request: ProposalRequest & { requestId: string },
): Promise<ProposalDecision> {
  ctx.recordSessionEntry?.("approval_required", slimApprovalData(request.requestId, request.toolName, "pending"));
  try {
    const decision = await ctx.propose(request);
    ctx.recordSessionEntry?.("approval_resolved", slimApprovalData(
      request.requestId,
      request.toolName,
      decision.approved ? "approved" : "denied",
      decision.proposalId ? { proposalId: decision.proposalId } : {},
    ));
    return decision;
  } catch (error) {
    ctx.recordSessionEntry?.("approval_resolved", slimApprovalData(request.requestId, request.toolName, "denied"));
    throw error;
  }
}

function shellExec(ctx: CodingToolsContext) {
  return async (command: string, cwd: string, opts: { onData: (data: Buffer) => void }) => {
    const decision = await proposeWrite(ctx, {
      requestId: randomUUID(),
      toolName: "bash",
      targetSystem: "general",
      summary: bashSummary(command),
      preview: { kind: "text", lines: toPreviewLines(command) },
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
  };
}

function withToolCallScope(def: ToolDefinition<any, any, any>): ToolDefinition<any, any, any> {
  const original = def.execute.bind(def);
  return {
    ...def,
    execute: (toolCallId: string, params: any, signal: any, onUpdate: any, sessionCtx: any) =>
      activeToolCallId.run(toolCallId, () => original(toolCallId, params, signal, onUpdate, sessionCtx)),
  };
}

export function createCodingToolDefinitions(ctx: CodingToolsContext): Array<ToolDefinition<any, any, any>> {
  // 会话锚点 cwd 只用于承载 Pi 进程与历史；工具的相对路径和执行
  // 必须落在用户可见的工作区根内。
  const pathCwd = ctx.workspaceRoot;

  const bash = createBashToolDefinition(pathCwd, {
    operations: {
      exec: shellExec(ctx),
    },
  });

  const edit = createEditToolDefinition(pathCwd, {
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
        const decision = await proposeWrite(ctx, {
          requestId: randomUUID(),
          toolName: "edit",
          targetSystem: "general",
          summary: `修改 ${workspaceRelative(ctx.workspaceRoot, absolutePath)}`,
          payload: { path: absolutePath, content },
          risk: "write",
        });
        if (!decision.approved) throw new Error(`编辑未执行:${decision.status}`);
      },
    },
  });

  const write = createWriteToolDefinition(pathCwd, {
    operations: {
      mkdir: async (dir: string) => {
        guardPath(ctx, dir);
      },
      writeFile: async (absolutePath: string, content: string) => {
        guardPath(ctx, absolutePath);
        const decision = await proposeWrite(ctx, {
          requestId: randomUUID(),
          toolName: "write",
          targetSystem: "general",
          summary: `写入 ${workspaceRelative(ctx.workspaceRoot, absolutePath)}`,
          payload: { path: absolutePath, content },
          risk: "write",
        });
        if (!decision.approved) throw new Error(`写入未执行:${decision.status}`);
      },
    },
  });

  return [bash, edit, write].map(withToolCallScope);
}
