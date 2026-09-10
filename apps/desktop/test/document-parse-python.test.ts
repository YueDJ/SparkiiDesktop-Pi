import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const pythonPath = join(repoRoot, 'packages/document-parse');

function resolvePython(): string | undefined {
  for (const cmd of ['python3', 'python']) {
    const result = spawnSync(cmd, ['-c', 'import sys; print(sys.version)'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (result.status === 0) return cmd;
  }
  return undefined;
}

const pythonBin = resolvePython();
const hasPython = Boolean(pythonBin);

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
  children.length = 0;
});

function waitExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
}

it.skipIf(!hasPython)('FAKE python -m sparkii_document_parse emits JSON only then exits 0', async () => {
  const child = spawn(pythonBin!, ['-u', '-m', 'sparkii_document_parse'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SPARKII_DOCUMENT_PARSE_FAKE: '1',
      PYTHONPATH: [pythonPath, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
      PYTHONUNBUFFERED: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  if (!child.stdin || !child.stdout) throw new Error('expected piped stdio');

  let stdoutText = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutText += chunk;
  });
  let stderrText = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrText += chunk;
  });

  const parseLine = JSON.stringify({
    id: '1',
    method: 'parse',
    params: { path: 'C:/docs/contract.pdf', modules: ['baseline'] },
  });
  const shutdownLine = JSON.stringify({ id: '2', method: 'shutdown' });
  child.stdin.write(`${parseLine}\n${shutdownLine}\n`);
  child.stdin.end();

  const code = await waitExit(child);
  expect(code).toBe(0);

  const lines = stdoutText.split('\n').filter((line) => line.trim().length > 0);
  expect(lines.length).toBeGreaterThanOrEqual(2);
  const frames = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(frames[0]).toEqual({ id: '1', method: 'progress', params: { page: 1, total: 1 } });
  const resultFrame = frames[1] as { id: string; result: { markdown: string; pages: Array<{ page: number; score: number }> } };
  expect(resultFrame.id).toBe('1');
  expect(resultFrame.result.markdown).toContain('contract.pdf');
  expect(resultFrame.result.pages).toEqual([{ page: 1, score: 0.91 }]);
  expect(stdoutText).not.toMatch(/Paddle|paddleocr|Traceback/i);
  expect(stderrText).not.toMatch(/Traceback/);
});
