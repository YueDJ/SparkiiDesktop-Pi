import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  createReadToolDefinition,
  createLsToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { documentConnector, knowledgeConnector, reportConnector, sparkiiOntoConnector, type ToolDef } from "@sparkii/connectors";
import type { ProposalRequest } from "@sparkii/approval";
import { buildPiRuntimeTools } from "./pi-runtime-tools.js";
import { createCodingToolDefinitions } from "./coding-tools.js";
import {
  createDeleteToolDefinition,
  createMoveToolDefinition,
} from "./workspace-tools.js";
import type { ProposalDecision, ConnectorReadRequest, ConnectorReadResult } from "./pi-runtime-transport.js";
import type {
  ActionExecutionResult,
  RuntimeActionRequest,
} from "./runtime-actions.js";
import { isPathInside, resolveGuardedReadPath } from "./workspace-guard.js";

export const WORKSPACE_NOT_CREATED = "工作区尚未创建（尚无写操作）。请先让智能体创建文件，或在输入框上方指定工作区。";

export interface RegistryContext {
  cwd: string;
  workspaceRoot?: string;
  skillsDir?: string;
  propose(request: ProposalRequest & { requestId: string }): Promise<ProposalDecision>;
  requestAction?(request: RuntimeActionRequest): Promise<ActionExecutionResult>;
  connectorRead?(request: ConnectorReadRequest): Promise<ConnectorReadResult>;
  recordSessionEntry?(customType: string, data: Record<string, unknown>): void;
}

const CONNECTOR_TOOLS = new Map<string, ToolDef>(
  [documentConnector, knowledgeConnector, reportConnector, sparkiiOntoConnector].flatMap((c) => c.tools.map((t) => [t.name, t] as const)),
);

function withWorkspaceGuard(
  def: ToolDefinition,
  root: string,
  pathCwd: string,
  skillsDir?: string,
  requestAction?: RegistryContext["requestAction"],
): ToolDefinition {
  const original = def.execute.bind(def);
  return {
    ...def,
    execute: async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
      const path: unknown = params?.path;
      const absolute = resolve(pathCwd, typeof path === "string" ? path : ".");
      const skillPath = Boolean(
        typeof path === "string"
        && skillsDir
        && isPathInside(skillsDir, absolute),
      );
      if (!existsSync(root) && !skillPath) {
        return { content: [{ type: "text", text: WORKSPACE_NOT_CREATED }], details: {} };
      }
      if (!skillPath && requestAction) {
        const result = await requestAction({
          requestId: randomUUID(),
          toolCallId,
          toolName: def.name,
          args: { ...params, path: absolute },
        });
        if (result.status !== "executed") {
          const reason = result.error?.message ?? result.decision.reason;
          return { content: [{ type: "text", text: `拒绝访问:${path} ${reason}` }], details: {} };
        }
        const authorized = result.result as { canonicalPath?: unknown } | undefined;
        const canonicalPath = typeof authorized?.canonicalPath === "string"
          ? authorized.canonicalPath
          : absolute;
        return original(
          toolCallId,
          { ...params, path: canonicalPath },
          signal,
          onUpdate,
          ctx,
        );
      }
      const guarded = await resolveGuardedReadPath(root, absolute, skillsDir);
      if (!guarded.ok) {
        const detail = guarded.code === 'OUTSIDE_WORKSPACE'
          ? '不在工作区内'
          : guarded.message;
        return {
          content: [{ type: "text", text: `拒绝访问:${path ?? absolute} ${detail}` }],
          details: {},
        };
      }
      return original(
        toolCallId,
        { ...params, path: guarded.canonicalPath },
        signal,
        onUpdate,
        ctx,
      );
    },
  };
}

export function resolveToolDefinitions(toolNames: string[], ctx: RegistryContext): ToolDefinition[] {
  const pathCwd = ctx.workspaceRoot ?? ctx.cwd;
  const requestAction = ctx.requestAction ?? (async (request: RuntimeActionRequest) => ({
    requestId: request.requestId,
    status: "denied" as const,
    decision: {
      decision: "deny" as const,
      ruleId: "platform.action-handler-unavailable",
      reason: "Main runtime action router is unavailable",
    },
  }));
  const codingByName = new Map(createCodingToolDefinitions({
    cwd: pathCwd,
    workspaceRoot: ctx.workspaceRoot ?? pathCwd,
    requestAction,
    recordSessionEntry: ctx.recordSessionEntry,
  }).map((d) => [d.name, d]));
  codingByName.set('delete', createDeleteToolDefinition({
    cwd: pathCwd,
    workspaceRoot: ctx.workspaceRoot ?? pathCwd,
    requestAction,
  }));
  codingByName.set('move', createMoveToolDefinition({
    cwd: pathCwd,
    workspaceRoot: ctx.workspaceRoot ?? pathCwd,
    requestAction,
  }));
  const out: ToolDefinition[] = [];
  for (const name of toolNames) {
    if (
      name === "bash"
      || name === "edit"
      || name === "write"
      || name === "delete"
      || name === "move"
    ) {
      const def = codingByName.get(name);
      if (def) out.push(def);
      else throw new Error(`unknown tool in saddle: ${name}`);
      continue;
    }
    if (name === "read") {
      const def = createReadToolDefinition(pathCwd, { autoResizeImages: false }) as ToolDefinition;
      out.push(ctx.workspaceRoot ? withWorkspaceGuard(def, ctx.workspaceRoot, pathCwd, ctx.skillsDir, ctx.requestAction) : def);
      continue;
    }
    if (name === "ls" || name === "grep" || name === "find") {
      const factory = { ls: createLsToolDefinition, grep: createGrepToolDefinition, find: createFindToolDefinition }[name];
      const def = factory(pathCwd) as ToolDefinition;
      out.push(ctx.workspaceRoot ? withWorkspaceGuard(def, ctx.workspaceRoot, pathCwd, ctx.skillsDir, ctx.requestAction) : def);
      continue;
    }
    const connector = CONNECTOR_TOOLS.get(name);
    if (connector) {
      const wrapped = buildPiRuntimeTools({
        tools: [connector],
        propose: ctx.propose,
        connectorRead: ctx.connectorRead,
      })[0];
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
