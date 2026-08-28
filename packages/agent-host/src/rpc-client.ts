import type { Writable, Readable } from 'node:stream';
import type { RpcCommand, RpcResponse, NormalizedEvent } from './types.js';

export type { RpcCommand, RpcResponse, NormalizedEvent } from './types.js';

export function normalizeEvent(raw: any): NormalizedEvent {
  const messageText = (message: any): string => {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((block: any) => block?.text ?? '')
        .join('');
    }
    return typeof message?.text === 'string' ? message.text : '';
  };

  switch (raw.type) {
    case 'message_update': {
      const aev = raw.assistantMessageEvent;
      if (aev?.type === 'text_delta') return { type: 'message', role: 'assistant', delta: aev.delta };
      if (aev?.type === 'thinking_delta') return { type: 'message', role: 'assistant', thinkingDelta: aev.delta };
      if (raw.role != null) return { type: 'message', role: raw.role, delta: raw.textDelta ?? raw.text };
      return { type: 'unknown', raw };
    }
    case 'message_end': {
      const role = raw.message?.role ?? raw.role;
      const content = raw.message?.content ?? raw.content;
      const blocks = Array.isArray(content) ? content as Array<{ type?: string; text?: string; thinking?: string }> : [];
      const text = Array.isArray(content)
        ? (blocks.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('') || undefined)
        : raw.text;
      const thinking = blocks.filter((c) => c.type === 'thinking').map((c) => c.thinking ?? '').join('') || undefined;
      return { type: 'message', role, text, thinking };
    }
    case 'tool_call': return { type: 'tool_call', toolName: raw.toolName, input: raw.input };
    case 'tool_result': return { type: 'tool_result', toolName: raw.toolName, result: raw.result };
    case 'agent_start': return { type: 'agent_start' };
    case 'agent_end': return { type: 'agent_end' };
    case 'compaction_start': return { type: 'compaction_start' };
    case 'compaction_end': return { type: 'compaction_end' };
    case "tool_execution_start":
      return { type: "tool_call", toolName: raw.toolName, input: raw.input ?? raw.params };
    case "tool_execution_end":
      return { type: "tool_result", toolName: raw.toolName, result: raw.result ?? raw.details };
    case "queue_update":
      return {
        type: "queue_update",
        steering: Array.isArray(raw.steering) ? raw.steering : [],
        followUp: Array.isArray(raw.followUp) ? raw.followUp : [],
      };
    case "entry_appended": {
      const message = raw.entry?.message;
      if (message?.role === 'user') {
        return { type: 'message', role: 'user', text: messageText(message) };
      }
      return { type: 'unknown', raw };
    }
    default: return { type: 'unknown', raw };
  }
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
