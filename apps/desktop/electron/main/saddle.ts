import { join } from 'node:path';
import type { SessionSaddle } from '@sparkii/agent-host';
import type { ProfileRuntime } from './runtime.js';

export function buildProfileSaddle(
  pr: ProfileRuntime,
  cwd: string,
  workspaceRoot?: string,
  model?: { provider: string; modelId: string },
  thinkingLevel?: string | null,
): SessionSaddle {
  return {
    tools: pr.profile.agent.tools,
    skillsDir: join(pr.dir, 'agent', 'skills'),
    cwd,
    systemPrompt: pr.profile.agent.prompts.system,
    workspaceRoot,
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}
