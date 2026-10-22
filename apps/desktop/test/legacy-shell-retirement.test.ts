import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), 'utf8');
}

const PRODUCT_PATHS = [
  'apps/desktop/src',
  'apps/desktop/electron',
  'apps/desktop/agents',
];

function sourcesUnder(dir: string, extensions: string[]): Array<{ path: string; text: string }> {
  const walk = (current: string, out: Array<{ path: string; text: string }>) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (extensions.some((extension) => full.endsWith(extension))) {
        out.push({ path: full, text: readFileSync(full, 'utf8') });
      }
    }
    return out;
  };
  return walk(resolve(process.cwd(), dir), []);
}

describe('legacy direct-spawn shell path is retired', () => {
  it('removes the direct spawn/bash-prefix executor', () => {
    expect(existsSync(join(
      process.cwd(),
      'apps',
      'desktop',
      'electron',
      'main',
      'general-executor.ts',
    ))).toBe(false);
    expect(existsSync(join(
      process.cwd(),
      'apps',
      'desktop',
      'test',
      'general-executor.test.ts',
    ))).toBe(false);
  });

  it('leaves no reference to the retired executor or its prefix whitelist', () => {
    for (const file of sourcesUnder('apps/desktop/electron', ['.ts', '.tsx'])) {
      expect(file.text, file.path).not.toMatch(/registerGeneralExecutor|general-executor/);
      expect(file.text, file.path).not.toMatch(/isReadOnlyBashCommand|READ_ONLY_PREFIXES/);
    }
  });

  it('runs process.exec only through the host adapter in the main path', () => {
    const ipc = source('apps/desktop/electron/main/ipc.ts');
    expect(ipc).toContain('hostShell.run(');
    expect(ipc).not.toMatch(/security\.sandbox\.run|researchSandbox\.run/);
    expect(ipc).not.toMatch(/sandboxReport/);
    const runtime = source('apps/desktop/electron/main/runtime.ts');
    expect(runtime).toContain('createHostShellAdapter');
    // AppContainer stays available as research code but is never probed on start-up.
    expect(runtime).not.toMatch(/researchSandbox\.probe|sandboxReport\s*=/);
  });

  it('keeps the AppContainer prototype out of the platform readiness decision', () => {
    const runtime = source('apps/desktop/electron/main/runtime.ts');
    expect(runtime).toMatch(/process\.exec'?\s*&&\s*hostShellReport\.status === 'available'/);
    expect(source('apps/desktop/electron/main/ipc.ts'))
      .not.toContain('sandboxCapabilityDecision');
  });
});

describe('product copy states host semantics', () => {
  const banned = [/沙箱内命令/, /无网络/, /Full access/i, /\byolo\b/];

  it('ships no misleading sandbox or full-access wording', () => {
    for (const dir of PRODUCT_PATHS) {
      for (const file of sourcesUnder(dir, ['.ts', '.tsx', '.yaml', '.md', '.css'])) {
        for (const pattern of banned) {
          expect(pattern.test(file.text), `${file.path} matches ${pattern}`).toBe(false);
        }
      }
    }
  });

  it('states the host boundary where shell capability is surfaced', () => {
    const status = source('apps/desktop/src/trust/TaskCapabilityStatus.tsx');
    expect(status).toContain('Host Git Bash');
    expect(status).toContain('宿主执行，非沙箱');
    expect(status).toContain('网络由宿主进程决定');
  });
});
