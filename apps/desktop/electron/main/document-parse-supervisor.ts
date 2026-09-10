import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { DocumentParseClient, type ParseResult } from './document-parse-rpc.js';
import { killProcessTree } from './document-parse-kill.js';
import { resolveDocumentParsePaths } from './document-parse-layout.js';

export const DOCUMENT_PARSE_STOPPED = '文档解析已停止。';
export const DOCUMENT_PARSE_SPAWN_FAILED = '内存不足或文档解析无法启动，请到设置 → 文档解析查看。';

export type DocumentParseStatus = 'stopped' | 'starting' | 'parsing' | 'idle' | 'resident';

export interface DocumentParseWaiting {
  sessionId: string;
  agentDisplayName: string;
  fileName: string;
}

export interface DocumentParseSnapshot {
  status: DocumentParseStatus;
  fileName?: string;
  agentDisplayName?: string;
  page?: number;
  total?: number;
  idleRemainingSec?: number;
  waiting: DocumentParseWaiting[];
  circuitOpen?: boolean;
}

export interface DocumentParseJob {
  sessionId: string;
  agentDisplayName: string;
  fileName: string;
  path: string;
  modules: string[];
}

type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildProcess;

type KillTreeFn = (
  child: { pid?: number; kill?: (sig?: NodeJS.Signals) => boolean },
) => Promise<void>;

export type DocumentParseSupervisorDeps = {
  spawn?: SpawnFn;
  killTree?: KillTreeFn;
  appendLog?: (chunk: string) => void;
  env?: NodeJS.ProcessEnv;
};

type InternalJob = DocumentParseJob & {
  resolve: (result: ParseResult) => void;
  reject: (error: Error) => void;
  abort: () => void;
  abortPromise: Promise<void>;
  aborted: boolean;
  settled: boolean;
};

const CIRCUIT_THRESHOLD = 3;
const DEFAULT_IDLE_MINUTES = 5;
const MAX_IDLE_MINUTES = 60;

function chunkToString(chunk: Buffer | string): string {
  return typeof chunk === 'string' ? chunk : chunk.toString('utf8');
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`document-parse exited before spawn (${code ?? signal ?? 'unknown'})`));
    };
    const cleanup = (): void => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

export class DocumentParseSupervisor {
  private readonly spawnFn: SpawnFn;
  private readonly killTreeFn: KillTreeFn;
  private readonly appendLog: (chunk: string) => void;
  private readonly env: NodeJS.ProcessEnv;

  private status: DocumentParseStatus = 'stopped';
  private child: ChildProcess | null = null;
  private client: DocumentParseClient | null = null;
  private current: InternalJob | null = null;
  private queue: InternalJob[] = [];
  private keepResident = false;
  private idleMinutes = DEFAULT_IDLE_MINUTES;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleDeadline: number | null = null;
  private idleGen = 0;
  private spawnFailCount = 0;
  private circuitOpenFlag = false;
  private quitting = false;
  private pumping = false;
  private page: number | undefined;
  private total: number | undefined;
  private readonly listeners = new Set<(snap: DocumentParseSnapshot) => void>();

  constructor(deps: DocumentParseSupervisorDeps = {}) {
    this.spawnFn = deps.spawn ?? (nodeSpawn as SpawnFn);
    this.killTreeFn = deps.killTree ?? ((child) => killProcessTree(child));
    this.appendLog = deps.appendLog ?? (() => {});
    this.env = deps.env ?? process.env;
  }

  enqueueParse(job: DocumentParseJob): Promise<ParseResult> {
    if (this.quitting) {
      return Promise.reject(new Error(DOCUMENT_PARSE_STOPPED));
    }
    if (this.circuitOpenFlag) {
      return Promise.reject(new Error(DOCUMENT_PARSE_SPAWN_FAILED));
    }

    const internal = this.createJob(job);
    this.clearIdleTimer();
    this.queue.push(internal);
    this.notify();
    void this.pump();
    return internal.promise;
  }

  async stopCurrent(): Promise<void> {
    if (!this.current) return;
    this.failJob(this.current, DOCUMENT_PARSE_STOPPED);
    this.current = null;
    await this.destroyChild();
    this.notify();
    void this.pump();
  }

  async release(): Promise<void> {
    if (this.current) {
      this.failJob(this.current, DOCUMENT_PARSE_STOPPED);
      this.current = null;
    }
    this.clearIdleTimer();
    await this.destroyChild();
    if (this.queue.length === 0) {
      this.status = 'stopped';
      this.notify();
      return;
    }
    this.notify();
    void this.pump();
  }

  async failAll(): Promise<void> {
    const jobs = [...(this.current ? [this.current] : []), ...this.queue];
    this.queue = [];
    this.current = null;
    for (const job of jobs) this.failJob(job, DOCUMENT_PARSE_STOPPED);
    this.clearIdleTimer();
    await this.destroyChild();
    this.status = 'stopped';
    this.page = undefined;
    this.total = undefined;
    this.notify();
  }

  async failSession(sessionId: string): Promise<void> {
    const kept: InternalJob[] = [];
    for (const job of this.queue) {
      if (job.sessionId === sessionId) this.failJob(job, DOCUMENT_PARSE_STOPPED);
      else kept.push(job);
    }
    this.queue = kept;
    this.notify();
    if (this.current?.sessionId === sessionId) {
      await this.stopCurrent();
    }
  }

  async beginQuit(): Promise<void> {
    if (this.quitting) return;
    this.quitting = true;
    await this.failAll();
  }

  snapshot(): DocumentParseSnapshot {
    const waiting = this.queue.map((job) => ({
      sessionId: job.sessionId,
      agentDisplayName: job.agentDisplayName,
      fileName: job.fileName,
    }));
    const snap: DocumentParseSnapshot = {
      status: this.status,
      waiting,
    };
    if (this.current && (this.status === 'parsing' || this.status === 'starting')) {
      snap.fileName = this.current.fileName;
      snap.agentDisplayName = this.current.agentDisplayName;
    }
    if (this.status === 'parsing') {
      if (this.page != null) snap.page = this.page;
      if (this.total != null) snap.total = this.total;
    }
    if (this.status === 'idle' && this.idleDeadline != null) {
      snap.idleRemainingSec = Math.max(0, Math.ceil((this.idleDeadline - Date.now()) / 1000));
    }
    if (this.circuitOpenFlag) snap.circuitOpen = true;
    return snap;
  }

  subscribe(cb: (snap: DocumentParseSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  setKeepResident(v: boolean): void {
    this.keepResident = v;
    if (this.status === 'idle' && v) {
      this.clearIdleTimer();
      this.status = 'resident';
      this.notify();
      return;
    }
    if (this.status === 'resident' && !v) {
      this.status = 'idle';
      this.armIdleTimer();
      this.notify();
    }
  }

  setIdleMinutes(n: number): void {
    this.idleMinutes = n <= 0 ? 0 : Math.min(MAX_IDLE_MINUTES, Math.max(1, n));
    if (this.status === 'idle') this.armIdleTimer();
  }

  clearCircuit(): void {
    this.spawnFailCount = 0;
    this.circuitOpenFlag = false;
    this.notify();
  }

  private createJob(job: DocumentParseJob): InternalJob & { promise: Promise<ParseResult> } {
    let abort!: () => void;
    const abortPromise = new Promise<void>((resolve) => {
      abort = resolve;
    });
    let resolve!: (result: ParseResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<ParseResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Avoid unhandled rejection if the caller has not attached yet.
    promise.catch(() => {});
    return {
      ...job,
      resolve,
      reject,
      abort,
      abortPromise,
      aborted: false,
      settled: false,
      promise,
    };
  }

  private failJob(job: InternalJob, message: string): void {
    job.aborted = true;
    job.abort();
    if (!job.settled) {
      job.settled = true;
      job.reject(new Error(message));
    }
  }

  private notify(): void {
    const snap = this.snapshot();
    for (const cb of this.listeners) cb(snap);
  }

  private resolveBin(): string {
    return this.env.SPARKII_DOCUMENT_PARSE_BIN || resolveDocumentParsePaths(this.env).exe;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.quitting && !this.current) {
        const job = this.queue.shift();
        if (!job) break;
        this.current = job;
        this.notify();
        try {
          await this.runJob(job);
        } finally {
          if (this.current === job) this.current = null;
        }
      }
      if (!this.quitting && !this.current) {
        this.enterIdleOrStopped();
      }
    } finally {
      this.pumping = false;
    }
  }

  private async runJob(job: InternalJob): Promise<void> {
    this.clearIdleTimer();
    this.page = undefined;
    this.total = undefined;
    try {
      if (this.circuitOpenFlag) {
        this.failJob(job, DOCUMENT_PARSE_SPAWN_FAILED);
        return;
      }
      await this.ensureProcess(job);
      if (job.aborted || this.quitting) return;
      this.status = 'parsing';
      this.notify();
      const client = this.client;
      if (!client) {
        this.failJob(job, DOCUMENT_PARSE_SPAWN_FAILED);
        return;
      }
      const result = await Promise.race([
        client.parse({ path: job.path, modules: job.modules }, (progress) => {
          if (this.current !== job) return;
          this.page = progress.page;
          this.total = progress.total;
          this.notify();
        }),
        job.abortPromise.then(() => {
          throw new Error('aborted');
        }),
      ]);
      if (job.aborted) return;
      job.settled = true;
      job.resolve(result);
    } catch {
      if (job.aborted) return;
      this.failJob(job, DOCUMENT_PARSE_SPAWN_FAILED);
      await this.destroyChild();
    }
  }

  private async ensureProcess(job: InternalJob): Promise<void> {
    if (this.child && this.client) return;
    this.status = 'starting';
    this.notify();
    const bin = this.resolveBin();
    let child: ChildProcess;
    try {
      child = this.spawnFn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      this.noteSpawnFailure();
      this.failJob(job, DOCUMENT_PARSE_SPAWN_FAILED);
      throw new Error(DOCUMENT_PARSE_SPAWN_FAILED);
    }
    this.child = child;

    try {
      await Promise.race([
        waitForSpawn(child),
        job.abortPromise.then(() => {
          throw new Error('aborted');
        }),
      ]);
    } catch {
      if (job.aborted) {
        return;
      }
      this.noteSpawnFailure();
      if (this.child === child) this.child = null;
      this.client = null;
      this.failJob(job, DOCUMENT_PARSE_SPAWN_FAILED);
      throw new Error(DOCUMENT_PARSE_SPAWN_FAILED);
    }

    if (job.aborted) return;
    if (!child.stdin || !child.stdout) {
      this.noteSpawnFailure();
      this.failJob(job, DOCUMENT_PARSE_SPAWN_FAILED);
      throw new Error(DOCUMENT_PARSE_SPAWN_FAILED);
    }

    this.spawnFailCount = 0;
    this.client = new DocumentParseClient({ stdin: child.stdin, stdout: child.stdout });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      this.appendLog(chunkToString(chunk));
    });
    child.on('exit', () => this.onChildGone(child));
    child.on('error', () => this.onChildGone(child));
  }

  private onChildGone(child: ChildProcess): void {
    if (this.child !== child) return;
    this.child = null;
    this.client = null;
    if (this.current && !this.current.aborted && this.status === 'parsing') {
      this.failJob(this.current, DOCUMENT_PARSE_SPAWN_FAILED);
      this.current = null;
    }
    if (this.status !== 'starting') {
      this.status = 'stopped';
      this.notify();
    }
  }

  private noteSpawnFailure(): void {
    this.spawnFailCount += 1;
    if (this.spawnFailCount >= CIRCUIT_THRESHOLD) {
      this.circuitOpenFlag = true;
    }
    this.status = 'stopped';
    this.notify();
  }

  private async destroyChild(): Promise<void> {
    const child = this.child;
    this.client = null;
    this.child = null;
    if (!child) return;
    await this.killTreeFn(child);
  }

  private enterIdleOrStopped(): void {
    this.page = undefined;
    this.total = undefined;
    if (!this.child) {
      this.status = 'stopped';
      this.notify();
      return;
    }
    if (this.keepResident) {
      this.status = 'resident';
      this.notify();
      return;
    }
    this.status = 'idle';
    this.armIdleTimer();
    this.notify();
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.idleMinutes <= 0 || this.keepResident || !this.child) return;
    const ms = this.idleMinutes * 60 * 1000;
    this.idleDeadline = Date.now() + ms;
    const gen = this.idleGen;
    this.idleTimer = setTimeout(() => {
      if (this.idleGen !== gen) return;
      void this.onIdleTimeout();
    }, ms);
  }

  private clearIdleTimer(): void {
    this.idleGen += 1;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.idleDeadline = null;
  }

  private async onIdleTimeout(): Promise<void> {
    if (this.current || this.queue.length > 0) return;
    if (this.keepResident) return;
    if (this.status !== 'idle') return;
    await this.destroyChild();
    this.status = 'stopped';
    this.notify();
  }
}

let singleton: DocumentParseSupervisor | null = null;

export function createDocumentParseSupervisor(deps: DocumentParseSupervisorDeps = {}): DocumentParseSupervisor {
  return new DocumentParseSupervisor(deps);
}

export function getDocumentParseSupervisor(): DocumentParseSupervisor {
  singleton ??= createDocumentParseSupervisor();
  return singleton;
}

export function resetDocumentParseSupervisorForTests(): void {
  singleton = null;
}
