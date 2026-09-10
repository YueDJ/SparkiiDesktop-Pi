import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DocumentParseClient,
  encodeLine,
  splitLines,
} from '../electron/main/document-parse-rpc.js';

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-document-parse.mjs');

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
  children.length = 0;
});

function captureWrites(stdin: PassThrough): () => string {
  let captured = '';
  stdin.on('data', (chunk: Buffer | string) => {
    captured += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  });
  return () => captured;
}

function readRequestId(written: string): string {
  const line = written.split('\n').find((item) => item.trim().length > 0);
  if (!line) throw new Error('expected a request line on stdin');
  const frame = JSON.parse(line) as { id: string };
  return frame.id;
}

describe('encodeLine', () => {
  it('ends with a newline and parses back', () => {
    const frame = { id: '1', method: 'shutdown' as const };
    const line = encodeLine(frame);
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual(frame);
  });
});

describe('splitLines', () => {
  it('leaves an incomplete trailing fragment in rest', () => {
    const { frames, rest } = splitLines('{"id":"1","method":"shutdown"}\n{"id":"2"');
    expect(frames).toEqual([{ id: '1', method: 'shutdown' }]);
    expect(rest).toBe('{"id":"2"');
  });
});

describe('DocumentParseClient', () => {
  it('handles chunked JSON across incomplete writes', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const written = captureWrites(stdin);
    const client = new DocumentParseClient({ stdin, stdout });

    const progress: Array<{ page: number; total: number }> = [];
    const pending = client.parse(
      { path: 'C:/docs/a.pdf', modules: ['baseline', 'seal'] },
      (p) => {
        progress.push(p);
      },
    );

    const id = readRequestId(written());
    const progressLine = JSON.stringify({
      id,
      method: 'progress',
      params: { page: 3, total: 12 },
    });
    const resultLine = JSON.stringify({
      id,
      result: { markdown: '# ok', pages: [{ page: 1, score: 0.91 }] },
    });
    const first = `{"id":"${id}","meth`;
    expect(progressLine.startsWith(first)).toBe(true);

    stdout.write(first);
    stdout.write(`${progressLine.slice(first.length)}\n${resultLine}\n`);

    const result = await pending;
    expect(progress).toEqual([{ page: 3, total: 12 }]);
    expect(result.markdown).toBe('# ok');
    expect(result.pages[0]).toEqual({ page: 1, score: 0.91 });
  });

  it('round-trips with the fake parse process', async () => {
    const child = spawn(process.execPath, [fixturePath], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    if (!child.stdin || !child.stdout) throw new Error('expected piped stdio');

    const client = new DocumentParseClient({ stdin: child.stdin, stdout: child.stdout });
    const progress: Array<{ page: number; total: number }> = [];
    const result = await client.parse(
      { path: 'C:/docs/contract.pdf', modules: ['baseline'] },
      (p) => {
        progress.push(p);
      },
    );

    expect(progress).toEqual([{ page: 1, total: 1 }]);
    expect(result.markdown).toContain('# fake');
    expect(result.markdown).toContain('contract.pdf');
    expect(result.pages[0]?.score).toBe(0.91);

    await client.shutdown();
    const code = await new Promise<number | null>((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(child.exitCode);
        return;
      }
      child.once('error', reject);
      child.once('exit', (exitCode) => resolve(exitCode));
    });
    expect(code).toBe(0);
  });

  it('rejects parse on an error frame', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const written = captureWrites(stdin);
    const client = new DocumentParseClient({ stdin, stdout });

    const pending = client.parse({ path: 'C:/docs/a.pdf', modules: ['baseline'] });
    const id = readRequestId(written());
    stdout.write(
      `${JSON.stringify({ id, error: { code: 'PARSE_FAILED', message: 'corrupt pdf' } })}\n`,
    );

    await expect(pending).rejects.toMatchObject({
      message: 'corrupt pdf',
      code: 'PARSE_FAILED',
    });
  });
});
