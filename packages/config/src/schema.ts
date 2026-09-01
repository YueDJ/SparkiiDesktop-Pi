import { z } from 'zod';
import type { ProfileManifest } from './types.js';

const modelTarget = z.object({ provider: z.string().min(1), modelId: z.string().min(1) });
export const manifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  displayName: z.string().optional(),
  sortOrder: z.number().optional(),
  extends: z.string().optional(),
  surface: z.object({
    type: z.enum(['chat', 'workflow', 'dashboard', 'custom']),
    entry: z.string().optional(),
  }).optional(),
  capabilities: z.object({
    entry: z.string().optional(),
    tools: z.array(z.string()).optional(),
  }).optional(),
  modelRequirements: z.object({
    requires: z.array(z.string()),
    prefers: z.array(z.string()).optional(),
  }).optional(),
  modelRouting: z.object({
    tasks: z.record(z.string(), z.array(modelTarget)),
  }),
  integrity: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
});

export function parseProfileManifest(raw: unknown): ProfileManifest {
  return manifestSchema.parse(raw);
}
