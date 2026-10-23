import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createReleaseManifest } from '../scripts/create-release-manifest.mjs';

describe('createReleaseManifest', () => {
  it('writes reproducible artifact metadata and SHA256SUMS', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sparkii-release-'));
    const out = join(root, 'out');
    mkdirSync(out);
    const artifactPath = join(out, 'Sparkii-0.1.0-win-x64.exe');
    writeFileSync(artifactPath, 'installer');

    const manifest = await createReleaseManifest({
      artifactPath,
      outputDir: out,
      version: '0.1.0',
      commit: 'abc123',
      builtAt: '2026-10-23T00:00:00.000Z',
      dirty: true,
    });

    expect(manifest).toEqual({
      schemaVersion: 1,
      product: 'Sparkii',
      version: '0.1.0',
      platform: 'win-x64',
      commit: 'abc123',
      builtAt: '2026-10-23T00:00:00.000Z',
      worktreeDirty: true,
      unsigned: true,
      artifact: 'Sparkii-0.1.0-win-x64.exe',
      bytes: 9,
      sha256: '9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c',
    });
    expect(JSON.parse(readFileSync(join(out, 'release-manifest.json'), 'utf8'))).toEqual(manifest);
    expect(readFileSync(join(out, 'SHA256SUMS.txt'), 'utf8')).toBe(
      '9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c  Sparkii-0.1.0-win-x64.exe\n',
    );
  });
});
