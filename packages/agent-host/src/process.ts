import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PiRpcClient } from './rpc-client.js';

export class PiProcessSupervisor {
  private child?: ChildProcessWithoutNullStreams;
  private client?: PiRpcClient;
  private exitCbs = new Set<(code: number | null) => void>();
  constructor(private opts: { bin?: string; args?: string[] } = {}) {}

  async start(): Promise<PiRpcClient> {
    if (this.client) return this.client;
    const bin = this.opts.bin ?? process.env.PI_BIN ?? 'pi';
    const args = this.opts.args ?? ['--mode', 'rpc'];
    this.child = /\.(cmd|bat)$/i.test(bin)
      ? spawn('cmd.exe', ['/d', '/s', '/c', [bin, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')], { stdio: ['pipe', 'pipe', 'inherit'] })
      : spawn(bin, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    this.client = new PiRpcClient(this.child.stdin, this.child.stdout);
    this.child.on('exit', (code) => {
      this.client = undefined;
      this.exitCbs.forEach((cb) => cb(code));
    });
    return this.client;
  }

  async stop(): Promise<void> {
    if (!this.child || this.child.killed) return;
    const pid = this.child.pid;
    if (process.platform === 'win32' && pid) {
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        killer.on('exit', () => resolve());
        killer.on('error', () => { this.child?.kill(); resolve(); });
      });
    } else {
      this.child.kill();
    }
  }

  onExit(cb: (code: number | null) => void): () => void {
    this.exitCbs.add(cb);
    return () => this.exitCbs.delete(cb);
  }
}
