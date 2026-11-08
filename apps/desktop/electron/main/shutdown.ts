/**
 * 升级关机协议（设计稿 §7.7 / 接口契约 §5.1）。
 *
 * 调用方有两个：main/index.ts（主 Agent，在「更新专用」before-quit 中调用）
 * 与 B 关 update/installer.ts（G7，runInstallTransaction 中调用）。
 * 本模块只用结构化的 ShutdownHooks，不 import electron/main/update/*，
 * 避免与 G3 的 update 模块形成循环依赖。
 *
 * 顺序严格固定（§7.7 步骤 2–5 + 整 data\ 一致性快照）：
 *   abortPendingApprovals → stopPool → stopDocumentParse → disposeReviewer → closeStores → snapshotData
 * 任一步抛错必须中止后续步骤并向上抛出（fail closed，绝不能在失败后继续安装）。
 */

/** 每一步的名称与时间戳，供单测断言顺序。 */
export interface ShutdownStep {
  name: string;
  at: number;
}

export interface ShutdownHooks {
  /** ① 审批门显式过期；返回被过期的待审批提案数量。未清空前不得返回成功（§7.7 步骤 2）。 */
  abortPendingApprovals(reason: string): Promise<number>;
  /** ② pool.stopAll()：复用既有方法，不新增 stop()（§0.7 P0-1）。 */
  stopPool(): Promise<void>;
  /** ③ documentParseSupervisor.beginQuit()。 */
  stopDocumentParse(): Promise<void>;
  /** ④ reviewer.dispose()。 */
  disposeReviewer(): Promise<void>;
  /** ⑤ 三个 SQLite store 固定关闭顺序：audit → chatSessions → errors（由调用方实现，见 closeStores() 适配代码）。 */
  closeStores(): Promise<void>;
  /** ⑥ 整 data\ 一致性快照：必须先关库再备份（§7.8）。A 关可 no-op，B 关由 G7 实现。 */
  snapshotData(): Promise<void>;
  now(): number;
}

/** §7.7 步骤 2 的审计原因；与 gate.abortPendingForQuit 的 decisionBy 对齐。 */
const ABORT_REASON = 'update-install';

interface Step {
  name: string;
  run(hooks: ShutdownHooks): Promise<unknown>;
}

/** 顺序写死，不得调整（§7.7）。 */
const STEPS: readonly Step[] = [
  { name: 'abortPendingApprovals', run: (h) => h.abortPendingApprovals(ABORT_REASON) },
  { name: 'stopPool', run: (h) => h.stopPool() },
  { name: 'stopDocumentParse', run: (h) => h.stopDocumentParse() },
  { name: 'disposeReviewer', run: (h) => h.disposeReviewer() },
  { name: 'closeStores', run: (h) => h.closeStores() },
  { name: 'snapshotData', run: (h) => h.snapshotData() },
];

/**
 * 严格按 §7.7 顺序执行；返回每一步的名称与时间戳，供单测断言顺序。
 * 不吞异常：任一步 reject 即中止后续步骤并把异常抛给调用方（fail closed，不继续安装）。
 */
export async function runShutdownSequence(hooks: ShutdownHooks): Promise<ShutdownStep[]> {
  const steps: ShutdownStep[] = [];
  for (const step of STEPS) {
    await step.run(hooks); // 抛错即中止后续，并向上抛出
    steps.push({ name: step.name, at: hooks.now() });
  }
  return steps;
}
