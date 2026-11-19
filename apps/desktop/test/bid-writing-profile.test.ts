/**
 * Real profile-loading test for the bid-writing agent.
 *
 * The surface unit tests mock the preload API, so they can never catch a
 * profile that is missing files the platform loader requires at startup (e.g.
 * `agent/tools.yaml`, `agent/workflow.yaml`, `agent/knowledge/corpus.json`).
 * This test runs the REAL `loadProfile` against the real profile directory, so
 * a missing/!invalid file fails here instead of at Electron launch.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadProfile } from '@sparkii/config';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(HERE, '..', 'agents', 'bid-writing');

describe('bid-writing profile — real platform loader', () => {
  it('satisfies every file loadProfile requires and resolves correctly', async () => {
    const p = await loadProfile(PROFILE_DIR, { allowUnsigned: true });

    // manifest
    expect(p.manifest.name).toBe('bid-writing');
    expect(p.manifest.surface?.type).toBe('custom');

    // agent/tools.yaml must match the capabilities declared in the manifest
    expect(p.agent.tools).toEqual([
      'read', 'write', 'edit', 'delete', 'move', 'knowledge.search', 'report.export',
    ]);

    // agent/skills/** — all four skills present with frontmatter descriptions
    expect(p.agent.skills.map((s) => s.name).sort()).toEqual([
      'chapter_draft', 'diagram', 'outline', 'requirement_check',
    ]);
    expect(p.agent.skills.every((s) => Boolean(s.description))).toBe(true);

    // agent/prompts/system.md + agent/workflow.yaml + corpus.json all load
    expect(p.agent.prompts.system).toBeTruthy();
    expect(p.agent.workflow).toBeTruthy();
    expect(Array.isArray(p.agent.knowledge)).toBe(true);

    // ui/theme.yaml → tokens file actually resolves
    expect(p.ui.theme.file).toBe('theme/tokens.json');
    expect(p.ui.pages.home).toBeTruthy();

    // security policy parses
    expect(Array.isArray(p.security.roles)).toBe(true);
  });
});
