import type { Runtime } from './runtime.js';
import type { Logger } from './logger.js';

export function attachRecovery(_rt: Runtime, _logger: Logger): void {
  // 池化后单个 supervisor 的自动重启不再适用，留待 PiRuntimePool 层实现。
}
