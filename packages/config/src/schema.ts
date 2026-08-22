import { z } from 'zod';
import type { ProfileManifest } from './types.js';

const modelTarget = z.object({ provider: z.string().min(1), modelId: z.string().min(1) });
export const manifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  extends: z.string().optional(),
  modelRouting: z.object({
    tasks: z.record(z.string(), z.array(modelTarget)),
  }),
  integrity: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
});

export function parseProfileManifest(raw: unknown): ProfileManifest {
  return manifestSchema.parse(raw);
}
