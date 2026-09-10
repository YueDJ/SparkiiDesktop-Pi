export type RpcFrame =
  | { id: string; method: 'parse'; params: { path: string; modules: string[] } }
  | { id: string; method: 'shutdown' }
  | { id: string; method: 'progress'; params: { page: number; total: number } }
  | { id: string; result: { markdown: string; pages: Array<{ page: number; score: number }> } }
  | { id: string; error: { code: string; message: string } };

export type ParseParams = { path: string; modules: string[] };
export type ParseResult = { markdown: string; pages: Array<{ page: number; score: number }> };
export type ParseProgress = { page: number; total: number };

export type RpcStreams = {
  stdin: { write: (chunk: string) => unknown };
  stdout: { on: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown };
};

export function encodeLine(frame: RpcFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export function splitLines(buffer: string): { frames: unknown[]; rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  const frames: unknown[] = [];
  for (const line of parts) {
    if (line.trim().length === 0) continue;
    try {
      frames.push(JSON.parse(line));
    } catch {
      // Malformed complete lines are skipped so one bad frame cannot crash the client.
    }
  }
  return { frames, rest };
}

function chunkToString(chunk: Buffer | string): string {
  return typeof chunk === 'string' ? chunk : chunk.toString('utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

class ParseRpcError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ParseRpcError';
    this.code = code;
  }
}

type PendingParse = {
  resolve: (result: ParseResult) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: ParseProgress) => void;
};

export class DocumentParseClient {
  private rest = '';
  private seq = 0;
  private readonly stdin: RpcStreams['stdin'];
  private readonly pending = new Map<string, PendingParse>();

  constructor(streams: RpcStreams) {
    this.stdin = streams.stdin;
    streams.stdout.on('data', (chunk) => {
      const split = splitLines(this.rest + chunkToString(chunk));
      this.rest = split.rest;
      for (const frame of split.frames) {
        this.dispatch(frame);
      }
    });
  }

  parse(
    params: ParseParams,
    onProgress?: (progress: ParseProgress) => void,
  ): Promise<ParseResult> {
    const id = this.nextId();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.stdin.write(encodeLine({ id, method: 'parse', params }));
    });
  }

  shutdown(): Promise<void> {
    const id = this.nextId();
    this.stdin.write(encodeLine({ id, method: 'shutdown' }));
    return Promise.resolve();
  }

  private nextId(): string {
    this.seq += 1;
    return String(this.seq);
  }

  private dispatch(frame: unknown): void {
    if (!isRecord(frame) || typeof frame.id !== 'string') return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;

    if (frame.method === 'progress' && isRecord(frame.params)) {
      const page = frame.params.page;
      const total = frame.params.total;
      if (typeof page === 'number' && typeof total === 'number') {
        pending.onProgress?.({ page, total });
      }
      return;
    }

    if (isRecord(frame.result) && typeof frame.result.markdown === 'string' && Array.isArray(frame.result.pages)) {
      this.pending.delete(frame.id);
      pending.resolve({
        markdown: frame.result.markdown,
        pages: frame.result.pages as ParseResult['pages'],
      });
      return;
    }

    if (isRecord(frame.error)) {
      this.pending.delete(frame.id);
      const message = typeof frame.error.message === 'string' ? frame.error.message : 'document parse failed';
      const code = typeof frame.error.code === 'string' ? frame.error.code : 'PARSE_FAILED';
      pending.reject(new ParseRpcError(code, message));
    }
  }
}
