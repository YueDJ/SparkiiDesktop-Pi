import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { ProposalRequest } from '@sparkii/approval';

export interface ProposalDecision { approved: boolean; proposalId: string; status: string; result?: unknown }

export class ControlServer {
  private server?: Server;
  private token = randomBytes(32).toString('hex');
  constructor(private opts: { onProposal: (req: ProposalRequest & { requestId: string }) => Promise<ProposalDecision> }) {}

  async start(): Promise<{ url: string; token: string }> {
    this.server = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/propose') { res.writeHead(404); res.end(); return; }
      if (req.headers.authorization !== `Bearer ${this.token}`) { res.writeHead(401); res.end('unauthorized'); return; }
      const body = await new Promise<string>((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(d)); });
      const decision = await this.opts.onProposal(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(decision));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address() as { port: number };
    return { url: `http://127.0.0.1:${addr.port}`, token: this.token };
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
