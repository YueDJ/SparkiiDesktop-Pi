import { parseReviewerDecision, type ReviewerDecision, type ShellReviewInput } from '@sparkii/approval';
import type { Logger } from '../logger.js';
import {
  REVIEWER_COMMAND_SUMMARY_LIMIT,
  REVIEWER_LOG_EVENTS,
  SHELL_REVIEWER_POLICY_VERSION,
  SHELL_REVIEWER_SYSTEM_PROMPT,
  redactReviewerCommand,
} from './reviewer-policy.js';

export interface ReviewerClient {
  send(command: unknown): Promise<{ success: boolean; data?: unknown; error?: string }>;
  stop(): Promise<void>;
}

export interface ShellReviewerOptions {
  provider: string;
  modelId: string;
  timeoutMs: number;
  idleMs: number;
  keyFor(provider: string): Promise<string | null>;
  logger: Pick<Logger, 'log'>;
  makeClient(): Promise<ReviewerClient>;
}

class ReviewerCanceled extends Error {
  constructor() {
    super('Reviewer canceled');
  }
}

/**
 * One hidden, tool-less Pi worker for the whole platform. It is owned by Main,
 * never appears in the Agent list or the user runtime pool, and processes
 * reviews strictly one at a time.
 *
 * Reusing the process is not reusing context: every review is a separate
 * single-turn `complete` call carrying only the current request.
 */
export function createPiShellReviewer(options: ShellReviewerOptions) {
  let client: ReviewerClient | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let currentTaskId: string | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let startFailures = 0;
  let disposed = false;
  const cancelledTasks = new Set<string>();

  const log = (entry: {
    level: 'debug' | 'info' | 'warn' | 'error';
    msg: string;
    ctx?: Record<string, unknown>;
  }) => options.logger.log(entry).catch(() => {});

  const stopIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const reset = async (reason: string): Promise<void> => {
    stopIdleTimer();
    const current = client;
    client = null;
    currentTaskId = null;
    if (!current) return;
    await current.stop().catch(() => {});
    await log({
      level: 'info',
      msg: REVIEWER_LOG_EVENTS.stopped,
      ctx: { provider: options.provider, model: options.modelId, reason },
    });
  };

  const ensure = async (): Promise<ReviewerClient> => {
    if (disposed) throw new ReviewerCanceled();
    if (client) {
      await log({
        level: 'debug',
        msg: REVIEWER_LOG_EVENTS.reused,
        ctx: { provider: options.provider, model: options.modelId },
      });
      return client;
    }
    const key = await options.keyFor(options.provider);
    if (!key) {
      await log({
        level: 'error',
        msg: REVIEWER_LOG_EVENTS.authFailed,
        ctx: { provider: options.provider },
      });
      throw new Error('Reviewer provider API key is missing');
    }
    let created: ReviewerClient;
    try {
      created = await options.makeClient();
    } catch (error) {
      startFailures += 1;
      await log({
        level: 'error',
        msg: REVIEWER_LOG_EVENTS.startFailed,
        ctx: {
          provider: options.provider,
          model: options.modelId,
          consecutiveStartFailures: startFailures,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
    startFailures = 0;
    client = created;
    try {
      await client.send({ type: 'set_api_key', provider: options.provider, apiKey: key });
    } catch (error) {
      await reset('start-key-rejected');
      throw error;
    }
    await log({
      level: 'info',
      msg: REVIEWER_LOG_EVENTS.started,
      ctx: {
        provider: options.provider,
        model: options.modelId,
        policyVersion: SHELL_REVIEWER_POLICY_VERSION,
      },
    });
    return client;
  };

  return {
    review(input: ShellReviewInput): Promise<ReviewerDecision> {
      const run = async (): Promise<ReviewerDecision> => {
        stopIdleTimer();
        if (cancelledTasks.delete(input.taskId)) throw new ReviewerCanceled();
        const started = Date.now();
        const worker = await ensure();
        currentTaskId = input.taskId;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const response = await Promise.race([
            worker.send({
              type: 'complete',
              provider: options.provider,
              modelId: options.modelId,
              system: SHELL_REVIEWER_SYSTEM_PROMPT,
              text: JSON.stringify(input),
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Reviewer timed out')), options.timeoutMs);
            }),
          ]);
          if (cancelledTasks.delete(input.taskId)) throw new ReviewerCanceled();
          if (!response.success) throw new Error(response.error ?? 'Reviewer request failed');
          const reviewed = parseReviewerDecision(String(response.data ?? ''));
          await log({
            level: 'debug',
            msg: REVIEWER_LOG_EVENTS.completed,
            ctx: {
              sessionId: input.sessionId,
              taskId: input.taskId,
              actionId: input.actionId,
              provider: options.provider,
              model: options.modelId,
              policyVersion: SHELL_REVIEWER_POLICY_VERSION,
              payloadHash: input.payloadHash,
              durationMs: Date.now() - started,
              commandSummary: redactReviewerCommand(input.command)
                .slice(0, REVIEWER_COMMAND_SUMMARY_LIMIT),
              cwd: input.cwd,
              evidenceCount: input.recentEvidence.length,
              decision: reviewed.decision,
              risk: reviewed.risk,
            },
          });
          idleTimer = setTimeout(() => void reset('idle'), options.idleMs);
          return reviewed;
        } catch (error) {
          if (error instanceof ReviewerCanceled) {
            await log({
              level: 'warn',
              msg: REVIEWER_LOG_EVENTS.canceled,
              ctx: { taskId: input.taskId, sessionId: input.sessionId },
            });
            throw error;
          }
          const timedOut = error instanceof Error && /timed out/.test(error.message);
          await log({
            level: 'warn',
            msg: timedOut ? REVIEWER_LOG_EVENTS.timeout : REVIEWER_LOG_EVENTS.failed,
            ctx: {
              taskId: input.taskId,
              sessionId: input.sessionId,
              actionId: input.actionId,
              policyVersion: SHELL_REVIEWER_POLICY_VERSION,
              error: error instanceof Error ? error.message : String(error),
            },
          });
          await reset(timedOut ? 'timeout' : 'failed');
          throw error;
        } finally {
          if (timer) clearTimeout(timer);
          if (currentTaskId === input.taskId) currentTaskId = null;
        }
      };
      const result = queue.then(run, run);
      queue = result.then(() => undefined, () => undefined);
      return result;
    },

    async cancel(taskId: string): Promise<void> {
      cancelledTasks.add(taskId);
      if (currentTaskId === taskId) await reset('task-revoked');
    },

    async dispose(): Promise<void> {
      disposed = true;
      await reset('disposed');
    },
  };
}

export type ShellReviewer = ReturnType<typeof createPiShellReviewer>;
