import type { ProposalRequest } from "@sparkii/approval";
import type { ToolDef } from "@sparkii/connectors";
import { jsonSchemaToTypeBox } from "./bridge/typebox.js";
import type { ProposalDecision } from "./pi-runtime-transport.js";

export interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
}

export function buildPiRuntimeTools(opts: {
  tools: ToolDef[];
  propose: (
    request: ProposalRequest & { requestId: string },
  ) => Promise<ProposalDecision>;
}): PiToolDefinition[] {
  return opts.tools.map((def) => {
    // Model APIs restrict function names to [a-zA-Z0-9_-]; keep the original
    // name for proposals while exposing a sanitized name to the agent SDK.
    const sdkName = def.name.replace(/[^a-zA-Z0-9_-]+/g, "_");
    return {
      name: sdkName,
      label: sdkName,
      description: def.description,
      parameters: jsonSchemaToTypeBox(def.params),
      async execute(toolCallId: string, params: Record<string, unknown>) {
        if (def.sideEffect === "read") {
          const result = await def.handler(params, {
            profileId: process.env.SPARKII_PROFILE_ID ?? "dev",
            sessionId: process.env.SPARKII_SESSION_ID ?? "session",
            actor: "agent",
            requestId: toolCallId,
          });
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        }
        const decision = await opts.propose({
          requestId: toolCallId,
          toolName: def.name,
          targetSystem: def.name.split(".")[0],
          summary: JSON.stringify(params).slice(0, 512),
          payload: params,
          risk: def.sideEffect,
        });
        return { content: [{ type: "text", text: JSON.stringify(decision) }], details: {} };
      },
    };
  });
}
