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

export function resolveAgentSkillsDir(input: {
  id: string;
  dir: string;
  dataDir: string;
  skillLibrary?: 'package' | 'user';
}): string {
  if (input.skillLibrary === 'user') {
    return join(input.dataDir, 'agents', input.id, 'skills');
  }
  return join(input.dir, 'agent', 'skills');
}

export async function loadAgentRuntimes(
  inputs: AgentRuntimeInput[],
  opts: { dataDir: string },
): Promise<Map<string, AgentRuntime>> {
  return new Map(
    inputs.map(({ id, manifest, dir, tools, systemPrompt }) => [
      id,
      {
        id,
        manifest,
        tools: tools ?? manifest.capabilities.tools ?? [],
        dir,
        skillsDir: resolveAgentSkillsDir({
          id,
          dir,
          dataDir: opts.dataDir,
          skillLibrary: manifest.skillLibrary,
        }),
        systemPrompt,
      },
    ]),
  );
}
