import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATTACHMENTS_DIR, buildAttachmentPrompt, stageAttachments } from '../electron/main/attachments.js';

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

async function tmp(name: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), name));
  dirs.push(d);
  return d;
}

describe('stageAttachments', () => {
  it('does not create the workspace when there are no attachments', async () => {
    const ws = join(await tmp('ws-'), 'missing');
    const out = await stageAttachments(ws, []);
    expect(out).toEqual([]);
    expect(existsSync(ws)).toBe(false);
  });

  it('copies an external file into the attachments dir with a relative ref', async () => {
    const src = join(await tmp('src-'), 'report.pdf');
    await writeFile(src, 'pdf-bytes');
    const ws = join(await tmp('ws-'), 'workspace');
    const out = await stageAttachments(ws, [{ path: src, name: 'report.pdf' }]);
    expect(out).toHaveLength(1);
    expect(out[0].ref).toBe(`${ATTACHMENTS_DIR}/report.pdf`);
    expect(await readFile(out[0].absolutePath, 'utf8')).toBe('pdf-bytes');
  });

  it('deduplicates same-named attachments with a -N suffix', async () => {
    const src1 = join(await tmp('src1-'), 'a.txt');
    const src2 = join(await tmp('src2-'), 'a.txt');
    await writeFile(src1, 'one');
    await writeFile(src2, 'two');
    const ws = join(await tmp('ws-'), 'workspace');
    const out = await stageAttachments(ws, [
      { path: src1, name: 'a.txt' },
      { path: src2, name: 'a.txt' },
    ]);
    expect(out.map((r) => r.ref)).toEqual([
      `${ATTACHMENTS_DIR}/a.txt`,
      `${ATTACHMENTS_DIR}/a-1.txt`,
    ]);
    expect(await readFile(out[1].absolutePath, 'utf8')).toBe('two');
  });

  it('references an in-workspace file without copying', async () => {
    const ws = join(await tmp('ws-'), 'workspace');
    await mkdir(ws, { recursive: true });
    const target = join(ws, 'notes.md');
    await writeFile(target, 'inside');
    const out = await stageAttachments(ws, [{ path: target, name: 'notes.md' }]);
    expect(out[0].ref).toBe('notes.md');
    expect(out[0].absolutePath).toBe(target);
    expect(existsSync(join(ws, ATTACHMENTS_DIR, 'notes.md'))).toBe(false);
  });

  it('throws when the source file is missing', async () => {
    const ws = join(await tmp('ws-'), 'workspace');
    await expect(stageAttachments(ws, [{ path: join(ws, 'nope.pdf'), name: 'nope.pdf' }]))
      .rejects.toThrow();
  });
});

describe('buildAttachmentPrompt', () => {
  it('returns text unchanged when there are no refs', () => {
    expect(buildAttachmentPrompt('hi', [])).toBe('hi');
  });

  it('puts the reference block first and keeps user text last', () => {
    const out = buildAttachmentPrompt('回答我', [
      { ref: `${ATTACHMENTS_DIR}/a.pdf`, absolutePath: '/ws/.sparkii-attachments/a.pdf' },
    ]);
    expect(out).toContain(`- ${ATTACHMENTS_DIR}/a.pdf`);
    expect(out.endsWith('回答我')).toBe(true);
  });
});
