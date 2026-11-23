import { join } from 'node:path';
import type { SessionSaddle } from '@sparkii/agent-host';
import type { ProfileRuntime } from './runtime.js';
import type { AgentRuntime } from './agent-registry.js';

export function buildProfileSaddle(
  pr: ProfileRuntime,
  cwd: string,
  workspaceRoot?: string,
  model?: { provider: string; modelId: string },
  thinkingLevel?: string | null,
  memoryBlock?: string,
): SessionSaddle {
  return {
    tools: pr.profile.agent.tools,
    skillsDir: join(pr.dir, 'agent', 'skills'),
    cwd,
    systemPrompt: memoryBlock
      ? `${pr.profile.agent.prompts.system}\n\n${memoryBlock}`
      : pr.profile.agent.prompts.system,
    workspaceRoot,
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

export function buildAgentSaddle(
  agent: AgentRuntime,
  cwd: string,
  workspaceRoot?: string,
  model?: { provider: string; modelId: string },
  thinkingLevel?: string | null,
  memoryBlock?: string,
): SessionSaddle {
  return {
    tools: agent.tools,
    skillsDir: agent.skillsDir,
    cwd,
    systemPrompt: memoryBlock
      ? `${agent.systemPrompt}\n\n${memoryBlock}`
      : agent.systemPrompt,
    workspaceRoot,
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}
