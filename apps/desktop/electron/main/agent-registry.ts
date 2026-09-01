import type { AgentManifest } from '@sparkii/config';

export interface AgentRuntime {
  id: string;
  manifest: AgentManifest;
  tools: string[];
}

export async function loadAgentRuntimes(
  inputs: Array<{ id: string; manifest: AgentManifest }>,
): Promise<Map<string, AgentRuntime>> {
  return new Map(
    inputs.map(({ id, manifest }) => [
      id,
      {
        id,
        manifest,
        tools: manifest.capabilities.tools ?? [],
      },
    ]),
  );
}
