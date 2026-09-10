import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRuntimeRoot } from './runtime-layout.js';

export interface DocumentParsePaths {
  root: string;
  exe: string;
  ready: string;
  models: string;
}

export function resolveDocumentParsePaths(env: NodeJS.ProcessEnv = process.env): DocumentParsePaths {
  const root = join(resolveRuntimeRoot(env), 'document-parse');
  return {
    root,
    exe: join(root, 'bin', 'sparkii-document-parse.exe'),
    ready: join(root, 'models', 'baseline', 'READY'),
    models: join(root, 'models'),
  };
}

/** True when the exe or baseline READY sentinel is missing. Ensure/extract is Task 9. */
export function needsDocumentParse(env: NodeJS.ProcessEnv = process.env): boolean {
  const paths = resolveDocumentParsePaths(env);
  return !existsSync(paths.exe) || !existsSync(paths.ready);
}
