import { z } from 'zod';

export type SurfaceType = 'chat' | 'workflow' | 'dashboard' | 'custom';

export interface AgentSurfaceDescriptor {
  type: SurfaceType;
  entry?: string;
}

export interface AgentCapabilitiesDescriptor {
  entry?: string;
  tools?: string[];
}

export interface ModelRequirement {
  requires: string[];
  prefers?: string[];
}

export interface AgentManifest {
  id: string;
  displayName?: string;
  version: string;
  sortOrder?: number;
  surface: AgentSurfaceDescriptor;
  capabilities: AgentCapabilitiesDescriptor;
  workflow?: string;
  skills?: string;
  prompts?: string;
  security?: { roles?: string; approval?: string };
  modelRequirements?: ModelRequirement;
}

const surfaceSchema = z.object({
  type: z.enum(['chat', 'workflow', 'dashboard', 'custom']),
  entry: z.string().optional(),
});

const capabilitiesSchema = z.object({
  entry: z.string().optional(),
  tools: z.array(z.string()).optional(),
});

const modelRequirementSchema = z.object({
  requires: z.array(z.string()).min(1),
  prefers: z.array(z.string()).optional(),
});

export const agentManifestSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  sortOrder: z.number().optional(),
  surface: surfaceSchema,
  capabilities: capabilitiesSchema,
  workflow: z.string().optional(),
  skills: z.string().optional(),
  prompts: z.string().optional(),
  security: z.object({
    roles: z.string().optional(),
    approval: z.string().optional(),
  }).optional(),
  modelRequirements: modelRequirementSchema.optional(),
});

export function parseAgentManifest(raw: unknown): AgentManifest {
  return agentManifestSchema.parse(raw);
}
