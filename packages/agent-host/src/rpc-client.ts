import type { Writable, Readable } from 'node:stream';
import type { RpcCommand, RpcResponse, NormalizedEvent } from './types.js';

export type { RpcCommand, RpcResponse, NormalizedEvent } from './types.js';

export function normalizeEvent(raw: unknown): NormalizedEvent {
  if (raw && typeof raw === 'object' && typeof (raw as { type?: unknown }).type === 'string') {
    return { ...(raw as NormalizedEvent) };
  }
  return { type: 'unknown', raw };
}

export class PiRpcClient {
  private pending = new Map<string, (r: RpcResponse) => void>();
  private listeners = new Set<(e: NormalizedEvent) => void>();
  private buffer = '';

  constructor(private stdin: Writable, stdout: Readable) {
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => this.consume(chunk));
  }

  send(cmd: RpcCommand, id?: string): Promise<RpcResponse> {
    const line = JSON.stringify({ ...cmd, ...(id ? { id } : {}) });
    this.stdin.write(line + '\n');
    return new Promise((resolve) => {
      if (!id) { this.pending.set('__noid__', resolve); return; }
      this.pending.set(id, resolve);
    });
  }

  onEvent(cb: (e: NormalizedEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  close(): void { this.stdin.end(); }

  private consume(chunk: string) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      if (obj.type === 'response') {
        const key = obj.id ?? '__noid__';
        const resolve = this.pending.get(key);
        if (resolve) { this.pending.delete(key); resolve(obj); }
      } else {
        this.listeners.forEach((cb) => cb(normalizeEvent(obj)));
      }
    }
  }
}
