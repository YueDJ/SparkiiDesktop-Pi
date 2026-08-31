import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createReadToolDefinition,
  createLsToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { documentConnector, knowledgeConnector, reportConnector, type ToolDef } from "@sparkii/connectors";
import type { ProposalRequest } from "@sparkii/approval";
import { buildPiRuntimeTools } from "./pi-runtime-tools.js";
import { createCodingToolDefinitions } from "./coding-tools.js";
import type { ProposalDecision } from "./pi-runtime-transport.js";
import { isPathInside } from "./workspace-guard.js";

export const WORKSPACE_NOT_CREATED = "工作区尚未创建（尚无写操作）。请先让智能体创建文件，或在输入框上方指定工作区。";

export interface RegistryContext {
  cwd: string;
  workspaceRoot?: string;
  propose(request: ProposalRequest & { requestId: string }): Promise<ProposalDecision>;
}

const CONNECTOR_TOOLS = new Map<string, ToolDef>(
  [documentConnector, knowledgeConnector, reportConnector].flatMap((c) => c.tools.map((t) => [t.name, t] as const)),
);

function withWorkspaceGuard(def: ToolDefinition, root: string, pathCwd: string): ToolDefinition {
  const original = def.execute.bind(def);
  return {
    ...def,
    execute: async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
      if (!existsSync(root)) {
        return { content: [{ type: "text", text: WORKSPACE_NOT_CREATED }], details: {} };
      }
      const path: unknown = params?.path;
      if (typeof path === "string" && !isPathInside(root, resolve(pathCwd, path))) {
        return { content: [{ type: "text", text: `拒绝访问:${path} 不在工作区内` }], details: {} };
      }
      return original(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

export function resolveToolDefinitions(toolNames: string[], ctx: RegistryContext): ToolDefinition[] {
  const pathCwd = ctx.workspaceRoot ?? ctx.cwd;
  const codingByName = new Map(createCodingToolDefinitions({ cwd: pathCwd, workspaceRoot: ctx.workspaceRoot ?? pathCwd, propose: ctx.propose }).map((d) => [d.name, d]));
  const out: ToolDefinition[] = [];
  for (const name of toolNames) {
    if (name === "bash" || name === "powershell" || name === "edit" || name === "write") {
      const def = codingByName.get(name);
      if (def) out.push(def);
      else throw new Error(`unknown tool in saddle: ${name}`);
      continue;
    }
    if (name === "read") {
      const def = createReadToolDefinition(pathCwd, { autoResizeImages: false }) as ToolDefinition;
      out.push(ctx.workspaceRoot ? withWorkspaceGuard(def, ctx.workspaceRoot, pathCwd) : def);
      continue;
    }
    if (name === "ls" || name === "grep" || name === "find") {
      const factory = { ls: createLsToolDefinition, grep: createGrepToolDefinition, find: createFindToolDefinition }[name];
      const def = factory(pathCwd) as ToolDefinition;
      out.push(ctx.workspaceRoot ? withWorkspaceGuard(def, ctx.workspaceRoot, pathCwd) : def);
      continue;
    }
    const connector = CONNECTOR_TOOLS.get(name);
    if (connector) {
      const wrapped = buildPiRuntimeTools({ tools: [connector], propose: ctx.propose })[0];
      // buildPiRuntimeTools already exposes an API-safe name ([a-zA-Z0-9_-])
      // while keeping the original connector name for proposals; do not
      // override it back, or OpenAI-compatible endpoints reject the tool.
      out.push(wrapped as unknown as ToolDefinition);
      continue;
    }
    throw new Error(`unknown tool in saddle: ${name}`);
  }
  return out;
}
