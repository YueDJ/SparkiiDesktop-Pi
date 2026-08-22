import type { Runtime } from './runtime.js';
import type { Logger } from './logger.js';

export function attachRecovery(rt: Runtime, logger: Logger): void {
  let attempts = 0;
  rt.supervisor.onExit(async (code) => {
    if (code === 0) return;
    const delay = Math.min(1000 * 2 ** attempts, 30_000);
    attempts += 1;
    await logger.log({ level: 'error', msg: 'pi process exited', ctx: { code, retryInMs: delay } });
    setTimeout(async () => {
      const c = await rt.supervisor.start();
      await c.send({ type: 'set_auto_retry', enabled: true });
      await c.send({ type: 'set_auto_compaction', enabled: true });
      const sessionFile = process.env.SPARKII_SESSION_FILE;
      if (sessionFile) await c.send({ type: 'switch_session', sessionPath: sessionFile });
    }, delay);
  });
}
