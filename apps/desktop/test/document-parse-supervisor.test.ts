import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeLine, splitLines } from '../electron/main/document-parse-rpc.js';
import {
  createDocumentParseSupervisor,
  getDocumentParseSupervisor,
  resetDocumentParseSupervisorForTests,
  type DocumentParseSupervisor,
  type DocumentParseSupervisorDeps,
} from '../electron/main/document-parse-supervisor.js';

const STOPPED = '文档解析已停止。';
const SPAWN_FAILED = '内存不足或文档解析无法启动，请到设置 → 文档解析查看。';
const IDLE_MS = 5 * 60 * 1000;

type ParseRequest = { id: string; path: string; modules: string[] };

class FakeParseChild extends EventEmitter {
  pid: number;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  readonly parked: ParseRequest[] = [];
  private rest = '';

  constructor(opts: { pid: number; autoSpawn?: boolean }) {
    super();
    this.pid = opts.pid;
    const origWrite = this.stdin.write.bind(this.stdin);
    this.stdin.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
      this.consume(chunk);
      return origWrite(chunk as string | Buffer, encoding as BufferEncoding, cb as ((error?: Error | null) => void));
    }) as typeof this.stdin.write;
    if (opts.autoSpawn !== false) {
      queueMicrotask(() => this.emit('spawn'));
    }
    this.on('exit', () => {
      this.parked.length = 0;
    });
  }

  private consume(chunk: unknown): void {
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const split = splitLines(this.rest + text);
    this.rest = split.rest;
    for (const frame of split.frames) {
      if (!frame || typeof frame !== 'object') continue;
      const rec = frame as { id?: string; method?: string; params?: { path?: string; modules?: string[] } };
      if (rec.method === 'parse' && typeof rec.id === 'string') {
        this.parked.push({
          id: rec.id,
          path: rec.params?.path ?? '',
          modules: rec.params?.modules ?? [],
        });
      }
    }
  }

  emitSpawn(): void {
    this.emit('spawn');
  }

  failSpawn(err: Error = new Error('ENOENT')): void {
    this.emit('error', err);
  }

  reply(result: { markdown: string; pages: Array<{ page: number; score: number }> } = {
    markdown: '# ok',
    pages: [{ page: 1, score: 0.91 }],
  }): void {
    const req = this.parked.shift();
    if (!req) throw new Error('FakeParseChild.reply: no parked parse request');
    this.stdout.emit('data', encodeLine({ id: req.id, method: 'progress', params: { page: 1, total: 1 } }));
    this.stdout.emit('data', encodeLine({ id: req.id, result }));
  }

  replyError(code: string, message: string): void {
    const req = this.parked.shift();
    if (!req) throw new Error('FakeParseChild.replyError: no parked parse request');
    this.stdout.emit('data', encodeLine({ id: req.id, error: { code, message } }));
  }

  kill(_sig?: NodeJS.Signals): boolean {
    this.killed = true;
    this.emit('exit', 1);
    return true;
  }
}

function job(over: Partial<{
  sessionId: string;
  agentDisplayName: string;
  fileName: string;
  path: string;
  modules: string[];
}> = {}) {
  return {
    sessionId: 's1',
    agentDisplayName: '合同审核智能体',
    fileName: 'scan.pdf',
    path: 'C:/docs/scan.pdf',
    modules: ['baseline'],
    ...over,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (pred()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${label}`);
}

function setup(opts?: { autoSpawn?: boolean }) {
  const children: FakeParseChild[] = [];
  let nextPid = 1000;
  const spawn = vi.fn((_bin: string, _args: string[], _stdio?: unknown) => {
    const child = new FakeParseChild({ pid: nextPid, autoSpawn: opts?.autoSpawn ?? true });
    nextPid += 1;
    children.push(child);
    return child;
  });
  const killTree = vi.fn(async (child: { emit?: (event: string, ...args: unknown[]) => boolean }) => {
    child.emit?.('exit', 0);
  });
  const appendLog = vi.fn();
  const supervisor = createDocumentParseSupervisor({
    spawn: spawn as unknown as DocumentParseSupervisorDeps['spawn'],
    killTree: killTree as unknown as DocumentParseSupervisorDeps['killTree'],
    appendLog,
    env: { SPARKII_DOCUMENT_PARSE_BIN: '/fake/sparkii-document-parse.exe' },
  });
  return { supervisor, spawn, killTree, appendLog, children };
}

async function startParse(
  supervisor: DocumentParseSupervisor,
  children: FakeParseChild[],
  parseJob: ReturnType<typeof job>,
) {
  const pending = supervisor.enqueueParse(parseJob);
  await waitUntil(() => children.some((c) => c.parked.length > 0), 'parked parse request');
  return { pending };
}

describe('getDocumentParseSupervisor', () => {
  afterEach(() => {
    resetDocumentParseSupervisorForTests();
    vi.useRealTimers();
  });

  it('returns the same module singleton', () => {
    expect(getDocumentParseSupervisor()).toBe(getDocumentParseSupervisor());
  });
});

describe('DocumentParseSupervisor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    resetDocumentParseSupervisorForTests();
  });

  it('spawns once on first enqueue and reuses the pid for a second job', async () => {
    const { supervisor, spawn, children } = setup();
    const { pending: first } = await startParse(supervisor, children, job({ fileName: 'a.pdf', path: 'C:/a.pdf' }));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      '/fake/sparkii-document-parse.exe',
      [],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    expect(children[0]?.pid).toBe(1000);

    const queued = supervisor.enqueueParse(job({ sessionId: 's2', fileName: 'b.pdf', path: 'C:/b.pdf' }));
    expect(supervisor.snapshot().waiting).toEqual([
      { sessionId: 's2', agentDisplayName: '合同审核智能体', fileName: 'b.pdf' },
    ]);

    children[0]!.reply({ markdown: '# a', pages: [{ page: 1, score: 0.9 }] });
    await expect(first).resolves.toEqual({ markdown: '# a', pages: [{ page: 1, score: 0.9 }] });
    await waitUntil(() => children[0]!.parked.length > 0, 'second parse on same child');
    expect(spawn).toHaveBeenCalledTimes(1);

    children[0]!.reply({ markdown: '# b', pages: [{ page: 1, score: 0.8 }] });
    await expect(queued).resolves.toEqual({ markdown: '# b', pages: [{ page: 1, score: 0.8 }] });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('reuses the same pid after the first job completes while the process is still idle', async () => {
    const { supervisor, spawn, children, killTree } = setup();
    const { pending: first } = await startParse(supervisor, children, job());
    children[0]!.reply();
    await first;
    await flush();
    expect(supervisor.snapshot().status).toBe('idle');
    expect(killTree).not.toHaveBeenCalled();

    const second = supervisor.enqueueParse(job({ fileName: 'next.pdf', path: 'C:/next.pdf' }));
    await waitUntil(() => children[0]!.parked.length > 0, 'reuse idle child');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(children[0]!.pid).toBe(1000);
    children[0]!.reply({ markdown: '# next', pages: [{ page: 1, score: 0.7 }] });
    await expect(second).resolves.toMatchObject({ markdown: '# next' });
  });

  it('kills the process tree after 5 idle minutes', async () => {
    const { supervisor, killTree, children } = setup();
    const { pending } = await startParse(supervisor, children, job());
    children[0]!.reply();
    await pending;
    await flush();
    expect(supervisor.snapshot().status).toBe('idle');
    expect(killTree).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(IDLE_MS);
    await flush();
    expect(killTree).toHaveBeenCalledTimes(1);
    expect(supervisor.snapshot().status).toBe('stopped');
  });

  it('does not idle-kill while a job is parsing', async () => {
    const { supervisor, killTree, children } = setup();
    const { pending } = await startParse(supervisor, children, job());
    expect(supervisor.snapshot().status).toBe('parsing');
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    await flush();
    expect(killTree).not.toHaveBeenCalled();
    children[0]!.reply();
    await pending;
  });

  it('does not idle-kill when keepResident is true', async () => {
    const { supervisor, killTree, children } = setup();
    supervisor.setKeepResident(true);
    const { pending } = await startParse(supervisor, children, job());
    children[0]!.reply();
    await pending;
    await flush();
    expect(supervisor.snapshot().status).toBe('resident');
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    await flush();
    expect(killTree).not.toHaveBeenCalled();
    expect(supervisor.snapshot().status).toBe('resident');
  });

  it('clears the idle timeout when a new job arrives during the grace period', async () => {
    const { supervisor, killTree, children } = setup();
    const { pending: first } = await startParse(supervisor, children, job());
    children[0]!.reply();
    await first;
    await flush();
    expect(supervisor.snapshot().status).toBe('idle');

    const second = supervisor.enqueueParse(job({ fileName: 'late.pdf' }));
    await waitUntil(() => children[0]!.parked.length > 0, 'job during idle grace');
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    await flush();
    expect(killTree).not.toHaveBeenCalled();
    children[0]!.reply();
    await second;
  });

  it('does not immediately kill when idleMinutes is 0', async () => {
    const { supervisor, killTree, children } = setup();
    supervisor.setIdleMinutes(0);
    const { pending } = await startParse(supervisor, children, job());
    children[0]!.reply();
    await pending;
    await flush();
    expect(supervisor.snapshot().status).toBe('idle');
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(killTree).not.toHaveBeenCalled();
    expect(supervisor.snapshot().status).toBe('idle');
  });

  it('failAll rejects queued promises with 文档解析已停止。', async () => {
    const { supervisor, children } = setup();
    const { pending: current } = await startParse(supervisor, children, job({ sessionId: 'A', fileName: 'a.pdf' }));
    const queued = supervisor.enqueueParse(job({ sessionId: 'B', fileName: 'b.pdf' }));
    await failAllAndExpect(supervisor, current, queued);
  });

  it("failSession('A') fails A's in-flight and queued jobs and keeps B", async () => {
    const { supervisor, children } = setup();
    const { pending: aCurrent } = await startParse(supervisor, children, job({ sessionId: 'A', fileName: 'a1.pdf' }));
    const aQueued = supervisor.enqueueParse(job({ sessionId: 'A', fileName: 'a2.pdf' }));
    const bQueued = supervisor.enqueueParse(job({ sessionId: 'B', fileName: 'b.pdf', path: 'C:/b.pdf' }));
    expect(supervisor.snapshot().waiting).toHaveLength(2);

    await supervisor.failSession('A');
    await expect(aCurrent).rejects.toThrow(STOPPED);
    await expect(aQueued).rejects.toThrow(STOPPED);

    await waitUntil(() => children.some((c) => c.parked.length > 0), 'B starts after failSession');
    const active = children.find((c) => c.parked.length > 0)!;
    active.reply({ markdown: '# b', pages: [{ page: 1, score: 0.88 }] });
    await expect(bQueued).resolves.toMatchObject({ markdown: '# b' });
  });

  it("failSession('A') keeps B's in-flight job", async () => {
    const { supervisor, children } = setup();
    const { pending: bCurrent } = await startParse(supervisor, children, job({ sessionId: 'B', fileName: 'b.pdf' }));
    const aQueued = supervisor.enqueueParse(job({ sessionId: 'A', fileName: 'a.pdf' }));
    await supervisor.failSession('A');
    await expect(aQueued).rejects.toThrow(STOPPED);
    children[0]!.reply({ markdown: '# b', pages: [{ page: 1, score: 0.5 }] });
    await expect(bCurrent).resolves.toMatchObject({ markdown: '# b' });
  });

  it('stopCurrent fails the current job and still runs the next queued job', async () => {
    const { supervisor, children, spawn } = setup();
    const { pending: current } = await startParse(supervisor, children, job({ sessionId: 'A', fileName: 'a.pdf' }));
    const next = supervisor.enqueueParse(job({ sessionId: 'B', fileName: 'b.pdf', path: 'C:/b.pdf' }));

    await supervisor.stopCurrent();
    await expect(current).rejects.toThrow(STOPPED);

    await waitUntil(() => children.some((c) => c.parked.length > 0), 'next job after stopCurrent');
    const active = children.find((c) => c.parked.length > 0)!;
    active.reply({ markdown: '# next', pages: [{ page: 1, score: 0.6 }] });
    await expect(next).resolves.toMatchObject({ markdown: '# next' });
    expect(spawn.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('opens the circuit after three consecutive spawn failures and does not spawn a fourth time', async () => {
    const { supervisor, spawn, children } = setup({ autoSpawn: false });
    spawn.mockImplementation(() => {
      const child = new FakeParseChild({ pid: 1000 + children.length, autoSpawn: false });
      children.push(child);
      queueMicrotask(() => child.failSpawn(new Error('ENOENT')));
      return child;
    });

    await expect(supervisor.enqueueParse(job({ fileName: '1.pdf' }))).rejects.toThrow(SPAWN_FAILED);
    await expect(supervisor.enqueueParse(job({ fileName: '2.pdf' }))).rejects.toThrow(SPAWN_FAILED);
    await expect(supervisor.enqueueParse(job({ fileName: '3.pdf' }))).rejects.toThrow(SPAWN_FAILED);
    expect(supervisor.snapshot().circuitOpen).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(3);

    await expect(supervisor.enqueueParse(job({ fileName: '4.pdf' }))).rejects.toThrow(SPAWN_FAILED);
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('beginQuit rejects all waiters and killTree once; a second beginQuit does not kill again', async () => {
    const { supervisor, killTree, children } = setup();
    const { pending: current } = await startParse(supervisor, children, job({ sessionId: 'A' }));
    const queued = supervisor.enqueueParse(job({ sessionId: 'B' }));

    await supervisor.beginQuit();
    await expect(current).rejects.toThrow(STOPPED);
    await expect(queued).rejects.toThrow(STOPPED);
    expect(killTree).toHaveBeenCalledTimes(1);

    await supervisor.beginQuit();
    expect(killTree).toHaveBeenCalledTimes(1);
  });

  it('stopCurrent during starting cancels load without hanging', async () => {
    const { supervisor, children, killTree } = setup({ autoSpawn: false });
    const pending = supervisor.enqueueParse(job());
    await waitUntil(() => supervisor.snapshot().status === 'starting', 'starting status');
    expect(children).toHaveLength(1);
    expect(children[0]!.parked).toHaveLength(0);

    await supervisor.stopCurrent();
    await expect(pending).rejects.toThrow(STOPPED);
    expect(killTree).toHaveBeenCalled();
    expect(supervisor.snapshot().status).toBe('stopped');
  });

  it('exposes parsing progress on the snapshot', async () => {
    const { supervisor, children } = setup();
    const { pending } = await startParse(supervisor, children, job());
    const snap = supervisor.snapshot();
    expect(snap.status).toBe('parsing');
    expect(snap.fileName).toBe('scan.pdf');
    expect(snap.agentDisplayName).toBe('合同审核智能体');
    children[0]!.reply();
    await pending;
  });

  it('does not mark stopped if a new job starts while idle kill is in flight', async () => {
    const { supervisor, children, killTree } = setup();
    const { pending } = await startParse(supervisor, children, job());
    children[0]!.reply();
    await pending;
    await flush();
    expect(supervisor.snapshot().status).toBe('idle');

    let releaseKill!: () => void;
    const hung = new Promise<void>((resolve) => {
      releaseKill = resolve;
    });
    killTree.mockImplementation(async (child: { emit?: (event: string, ...args: unknown[]) => boolean }) => {
      await hung;
      child.emit?.('exit', 0);
    });

    vi.advanceTimersByTime(IDLE_MS);
    expect(killTree).toHaveBeenCalledTimes(1);

    const second = supervisor.enqueueParse(job({ fileName: 'during-kill.pdf', path: 'C:/during-kill.pdf' }));
    await waitUntil(() => children.some((c) => c.parked.length > 0), 'job during hanging idle kill');
    expect(supervisor.snapshot().status).toBe('parsing');

    releaseKill();
    await flush();
    expect(supervisor.snapshot().status).toBe('parsing');
    expect(supervisor.snapshot().status).not.toBe('stopped');
    const active = children.find((c) => c.parked.length > 0)!;
    active.reply({ markdown: '# late', pages: [{ page: 1, score: 0.5 }] });
    await expect(second).resolves.toMatchObject({ markdown: '# late' });
  });

  it('pumps a job enqueued from an idle snapshot subscriber', async () => {
    const { supervisor, children } = setup();
    const { pending: first } = await startParse(supervisor, children, job({ fileName: 'one.pdf' }));
    let second: Promise<{ markdown: string; pages: Array<{ page: number; score: number }> }> | undefined;
    let startedSecond = false;
    const unsub = supervisor.subscribe((snap) => {
      if (snap.status !== 'idle' || startedSecond) return;
      startedSecond = true;
      second = supervisor.enqueueParse(job({ fileName: 'two.pdf', path: 'C:/two.pdf' }));
    });
    children[0]!.reply({ markdown: '# one', pages: [{ page: 1, score: 0.9 }] });
    await first;
    await waitUntil(
      () => second != null && children.some((c) => c.parked.length > 0),
      'subscribe-enqueued job',
    );
    const active = children.find((c) => c.parked.length > 0)!;
    active.reply({ markdown: '# two', pages: [{ page: 1, score: 0.8 }] });
    await expect(second).resolves.toMatchObject({ markdown: '# two' });
    unsub();
  });

  it('rejects PARSE_FAILED with the rpc message, not spawn failure', async () => {
    const { supervisor, children } = setup();
    const { pending } = await startParse(supervisor, children, job());
    children[0]!.replyError('PARSE_FAILED', 'x');
    await expect(pending).rejects.toMatchObject({ message: 'x' });
    expect(supervisor.snapshot().circuitOpen).toBeUndefined();
  });

  it('does not count PARSE_FAILED toward the spawn circuit', async () => {
    const { supervisor, spawn, children } = setup();
    const { pending: parseFail } = await startParse(supervisor, children, job({ fileName: 'bad.pdf' }));
    children[0]!.replyError('PARSE_FAILED', 'corrupt');
    await expect(parseFail).rejects.toThrow('corrupt');
    expect(supervisor.snapshot().circuitOpen).toBeUndefined();

    await supervisor.release();
    await flush();

    spawn.mockImplementation(() => {
      const child = new FakeParseChild({ pid: 1000 + children.length, autoSpawn: false });
      children.push(child);
      queueMicrotask(() => child.failSpawn(new Error('ENOENT')));
      return child;
    });

    await expect(supervisor.enqueueParse(job({ fileName: '1.pdf' }))).rejects.toThrow(SPAWN_FAILED);
    await expect(supervisor.enqueueParse(job({ fileName: '2.pdf' }))).rejects.toThrow(SPAWN_FAILED);
    expect(supervisor.snapshot().circuitOpen).toBeUndefined();
    await expect(supervisor.enqueueParse(job({ fileName: '3.pdf' }))).rejects.toThrow(SPAWN_FAILED);
    expect(supervisor.snapshot().circuitOpen).toBe(true);
  });
});

async function failAllAndExpect(
  supervisor: DocumentParseSupervisor,
  current: Promise<unknown>,
  queued: Promise<unknown>,
): Promise<void> {
  const currentSettled = current.then(
    () => 'resolved',
    (err: Error) => err.message,
  );
  const queuedSettled = queued.then(
    () => 'resolved',
    (err: Error) => err.message,
  );
  await supervisor.failAll();
  expect(await queuedSettled).toBe(STOPPED);
  expect(await currentSettled).toBe(STOPPED);
}
