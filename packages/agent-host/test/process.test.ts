import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiProcessSupervisor } from '../src/process.js';

describe('PiProcessSupervisor', () => {
  it('spawns and stops a child', async () => {
    const sup = new PiProcessSupervisor({ bin: process.execPath, args: ['-e', 'process.stdin.resume()'] });
    const client = await sup.start();
    expect(client).toBeTruthy();
    await sup.stop();
  });
  it.skipIf(process.platform !== 'win32')('stops the whole process tree on Windows', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'pi-tree-')), 'grandchild.pid');
    const grandchildScript =
      `require('node:fs').writeFileSync(process.env.SPARKII_TREE_MARKER, String(process.pid));setInterval(() => {}, 1000);`;
    const sup = new PiProcessSupervisor({
      bin: process.execPath,
      args: [
        '-e',
        `const { spawn } = require('node:child_process');` +
        `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore', env: { ...process.env, SPARKII_TREE_MARKER: ${JSON.stringify(marker)} } });` +
        `process.stdin.resume();`,
      ],
    });
    await sup.start();
    let grandPid: number | null = null;
    for (let i = 0; i < 40 && !grandPid; i++) {
      try { grandPid = Number(readFileSync(marker, 'utf8')); } catch { await new Promise((r) => setTimeout(r, 50)); }
    }
    expect(grandPid).toBeTruthy();
    await sup.stop();
    let alive = true;
    for (let i = 0; i < 40; i++) {
      try { process.kill(grandPid as number, 0); await new Promise((r) => setTimeout(r, 50)); }
      catch { alive = false; break; }
    }
    expect(alive).toBe(false);
  });
});
