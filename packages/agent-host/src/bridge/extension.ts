import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { documentConnector, knowledgeConnector, reportConnector, type ToolDef } from '@sparkii/connectors';
import { connectorId, jsonSchemaToTypeBox } from './typebox.js';

const controlUrl = process.env.SPARKII_CONTROL_URL!;
const controlToken = process.env.SPARKII_CONTROL_TOKEN!;

async function propose(payload: unknown) {
  const r = await fetch(`${controlUrl}/propose`, {
    method: 'POST',
    headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`control channel error: ${r.status}`);
  return r.json();
}

export default function (pi: ExtensionAPI) {
  const connectors = [documentConnector, knowledgeConnector, reportConnector];
  for (const c of connectors) {
    for (const def of c.tools) {
      if (def.sideEffect === 'read') {
        pi.registerTool({
          name: def.name,
          label: def.name,
          description: def.description,
          parameters: jsonSchemaToTypeBox(def.params) as any,
          async execute(_id, params, _signal, _onUpdate, ctx) {
            const r = await def.handler(params as Record<string, unknown>, {
              profileId: process.env.SPARKII_PROFILE_ID ?? 'dev',
              sessionId: process.env.SPARKII_SESSION_ID ?? 'session',
              actor: 'agent', requestId: _id,
            });
            return { content: [{ type: 'text', text: JSON.stringify(r) }], details: {} };
          },
        });
      } else {
        pi.registerTool({
          name: def.name,
          label: def.name,
          description: def.description,
          parameters: jsonSchemaToTypeBox(def.params) as any,
          async execute(_id, params) {
            const decision = await propose({
              requestId: _id, toolName: def.name, targetSystem: connectorId(def.name),
              summary: JSON.stringify(params).slice(0, 512), payload: params, risk: def.sideEffect,
            });
            return { content: [{ type: 'text', text: JSON.stringify(decision) }], details: {} };
          },
        });
      }
    }
  }
}
