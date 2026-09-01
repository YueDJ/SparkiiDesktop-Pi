import type { AgentManifest } from '@sparkii/config';
import { join } from 'node:path';

export interface AgentRuntime {
  id: string;
  manifest: AgentManifest;
  tools: string[];
  dir: string;
  skillsDir: string;
  systemPrompt?: string;
}

export interface AgentRuntimeInput {
  id: string;
  manifest: AgentManifest;
  dir: string;
  tools?: string[];
  systemPrompt?: string;
}

export async function loadAgentRuntimes(
  inputs: AgentRuntimeInput[],
): Promise<Map<string, AgentRuntime>> {
  return new Map(
    inputs.map(({ id, manifest, dir, tools, systemPrompt }) => [
      id,
      {
        id,
        manifest,
        tools: tools ?? manifest.capabilities.tools ?? [],
        dir,
        skillsDir: join(dir, 'agent', 'skills'),
        systemPrompt,
      },
    ]),
  );
}
