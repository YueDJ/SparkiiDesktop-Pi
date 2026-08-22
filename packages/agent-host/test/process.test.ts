import { describe, it, expect } from 'vitest';
import { PiProcessSupervisor } from '../src/process.js';

describe('PiProcessSupervisor', () => {
  it('spawns and stops a child', async () => {
    const sup = new PiProcessSupervisor({ bin: process.execPath, args: ['-e', 'process.stdin.resume()'] });
    const client = await sup.start();
    expect(client).toBeTruthy();
    await sup.stop();
  });
});
