import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  ActionExecutionResult,
  RuntimeActionRequest,
} from "./runtime-actions.js";
import { isPathInside } from "./workspace-guard.js";

export interface CodingToolsContext {
  cwd: string;
  workspaceRoot: string;
  requestAction(request: RuntimeActionRequest): Promise<ActionExecutionResult>;
  recordSessionEntry?(customType: string, data: Record<string, unknown>): void;
}

const activeToolCallId = new AsyncLocalStorage<string>();

function guardPath(ctx: CodingToolsContext, absolutePath: string): void {
  if (!isPathInside(ctx.workspaceRoot, absolutePath)) {
    throw new Error(`拒绝访问:${absolutePath} 不在工作区内`);
  }
}

async function requestToolAction(
  ctx: CodingToolsContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ActionExecutionResult> {
  return ctx.requestAction({
    requestId: randomUUID(),
    toolCallId: activeToolCallId.getStore(),
    toolName,
    args,
  });
}

function executionError(
  toolName: string,
  result: ActionExecutionResult,
): Error {
  const detail = result.error?.message ?? result.decision.reason;
  return new Error(`${toolName}未执行:${result.status}:${detail}`);
}

function shellExec(ctx: CodingToolsContext) {
  return async (command: string, cwd: string, opts: { onData: (data: Buffer) => void }) => {
    const result = await requestToolAction(ctx, "bash", {
      command,
    });
    if (result.status === "denied" || result.status === "failed") {
      opts.onData(Buffer.from(`${result.decision.reason}\n`));
      return { exitCode: 1 };
    }
    const data = (result.result ?? {}) as { exitCode?: number | null; output?: string };
    if (data.output) opts.onData(Buffer.from(data.output));
    return { exitCode: data.exitCode ?? 0 };
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
        const result = await requestToolAction(ctx, "edit", {
          path: absolutePath,
          content,
        });
        if (result.status !== "executed") throw executionError("编辑", result);
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
        const result = await requestToolAction(ctx, "write", {
          path: absolutePath,
          content,
        });
        if (result.status !== "executed") throw executionError("写入", result);
      },
    },
  });

  return [bash, edit, write].map(withToolCallScope);
}
