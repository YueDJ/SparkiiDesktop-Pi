/**
 * P10 — generic workspace-root relocation (platform capability, NO agent/business branch).
 *
 * Moves a session's fixed workspace root to a user-chosen empty directory while
 * keeping sessionId stable — so chat history, knowledge bindings and the
 * in-workspace T1 index all follow automatically. Implements plan §5.1 steps 1–12
 * in strict order; step 13 (the IPC return) is done by the caller.
 *
 * Failure contract (arch-review MUST-FIX 1):
 *  - copy first, delete source LAST; every failure path before step 11 only
 *    removes the newly created target copy (source stays intact);
 *  - a failed source deletion at step 11 keeps BOTH copies + warns + audits —
 *    NEVER delete the only surviving copy;
 *  - the session-record batch update is a SINGLE transaction.
 *
 * Dependencies are injected so the whole flow is unit-testable without Electron.
 */
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { admitWorkspace } from '@sparkii/approval';
import type {
  ProtectedRoot,
  WorkspacePathProbe,
} from '@sparkii/approval';

export interface RelocateAuditEvent {
  actor: string;
  action: string;
  resource: string;
  decision: string;
  ruleId: string;
  payloadSummary?: string;
  sessionId?: string;
}

export interface WorkspaceRelocationDeps {
  /** Look up the session record that owns the workspace being moved. */
  getSession(sessionId: string): { workspacePath: string } | undefined;
  /** Find every session id referencing a workspace path (F8 — shared roots). */
  sessionsByWorkspace(workspacePath: string): Array<{ id: string; profileId: string; open: boolean }>;
  /** Single-transaction batch update of every session record pointing at oldPath. */
  updateWorkspacePathInTransaction(
    oldPath: string,
    newPath: string,
    workspaceKind: 'auto' | 'user',
  ): void;
  /** True when the session has no active Grant and no streaming turn. */
  isIdle(sessionId: string): boolean;
  /** Rebind the Pi tool's view of workspaceRoot for an open session. */
  configureSession(sessionId: string, profileId: string): Promise<void>;
  /** Filesystem object identity probe (canonical/reparse/hard-link aware). */
  pathProbe: WorkspacePathProbe;
  protectedRoots: ProtectedRoot[];
  audit: (event: RelocateAuditEvent) => Promise<unknown> | unknown;
  actor: string;
  /** Overridable for tests; defaults to the real fs helpers above. */
  fs?: {
    cp: typeof cp;
    mkdir: typeof mkdir;
    readdir: typeof readdir;
    rm: typeof rm;
    stat: typeof stat;
  };
  now?: () => number;
}

export type RelocateResult =
  | { ok: true; workspacePath: string }
  | { ok: false; code: RelocateErrorCode; reason: string; keptBothCopies?: boolean };

export type RelocateErrorCode =
  | 'NO_SESSION'
  | 'INVALID_PATH'
  | 'SAME_PATH'
  | 'SOURCE_MISSING'
  | 'NESTED_PATH'
  | 'ADMISSION_FAILED'
  | 'NOT_IDLE'
  | 'TARGET_NOT_EMPTY'
  | 'COPY_FAILED'
  | 'RECONCILE_FAILED'
  | 'TRANSACTION_FAILED'
  | 'REBIND_FAILED'
  | 'VERIFY_FAILED'
  | 'SOURCE_REMOVE_FAILED';

export interface RelocateRequest {
  sessionId: string;
  newPath: string;
  workspaceKind?: 'auto' | 'user';
}

function isCaseInsensitiveEqual(a: string, b: string): boolean {
  const normalize = (p: string) => resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}

/** True when target equals source or is nested under it (either direction). */
function isSameOrNested(source: string, target: string): boolean {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, '') + sep;
  const s = norm(source);
  const t = norm(target);
  return s === t || s.startsWith(t) || t.startsWith(s);
}

async function directoryStats(
  fs: NonNullable<WorkspaceRelocationDeps['fs']>,
  dir: string,
): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = resolve(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        files += 1;
        const info = await fs.stat(full);
        bytes += info.size;
      }
    }
  }
  await walk(dir);
  return { files, bytes };
}

export async function relocateWorkspace(
  req: RelocateRequest,
  deps: WorkspaceRelocationDeps,
): Promise<RelocateResult> {
  const fs = deps.fs ?? { cp, mkdir, readdir, rm, stat };
  const sessionId = String(req?.sessionId ?? '');
  const newPathRaw = String(req?.newPath ?? '');
  const workspaceKind = req.workspaceKind ?? 'user';
  const now = deps.now ?? (() => Date.now());

  const audit = async (
    decision: string,
    ruleId: string,
    reason: string,
  ): Promise<void> => {
    try {
      await deps.audit({
        actor: deps.actor,
        action: 'workspace.relocate',
        resource: newPathRaw,
        decision,
        ruleId,
        payloadSummary: JSON.stringify({
          sessionId, newPath: newPathRaw, reason, at: now(),
        }),
        sessionId,
      });
    } catch { /* audit must never change the operation result */ }
  };

  // ── 1. 基础校验 ────────────────────────────────────────────────────────
  const rec = deps.getSession(sessionId);
  if (!rec) return fail('NO_SESSION', 'session not found');
  const oldPath = String(rec.workspacePath ?? '').trim();
  if (!isAbsolute(newPathRaw) || !oldPath) {
    await audit('failed', 'relocate.invalid-path', 'path must be absolute');
    return fail('INVALID_PATH', 'newPath must be an absolute path');
  }
  if (isCaseInsensitiveEqual(oldPath, newPathRaw)) {
    await audit('failed', 'relocate.same-path', 'source and target are identical');
    return fail('SAME_PATH', 'source and target are the same path');
  }
  const sourceDir = resolve(oldPath);
  const targetDir = resolve(newPathRaw);

  const sourceInfo = await deps.pathProbe.inspect(sourceDir).catch(() => null);
  if (!sourceInfo || sourceInfo.exists === false || !sourceInfo.isDirectory) {
    await audit('failed', 'relocate.source-missing', 'source workspace missing');
    return fail('SOURCE_MISSING', 'source workspace is missing or not a directory');
  }

  // ── 2. 循环嵌套校验（双向） ─────────────────────────────────────────────
  if (await deps.pathProbe.isSameOrDescendant(sourceDir, targetDir)
    || await deps.pathProbe.isSameOrDescendant(targetDir, sourceDir)) {
    await audit('failed', 'relocate.nested-path', 'target nests with source');
    return fail('NESTED_PATH', 'target must not be the source or its parent/child');
  }
  // Lexical backstop (independent of probe impl) — prevents recursive cp.
  if (isSameOrNested(sourceDir, targetDir)) {
    await audit('failed', 'relocate.nested-path', 'target lexically nests with source');
    return fail('NESTED_PATH', 'target must not be the source or its parent/child');
  }

  // ── 3. 准入校验（admitWorkspace + 显式 reparse/硬链接 + canonical） ───────
  const targetAdmission = await admitWorkspace({
    target: targetDir,
    protectedRoots: deps.protectedRoots,
    probe: deps.pathProbe,
  });
  if (!targetAdmission.ok) {
    await audit('failed', targetAdmission.ruleId ?? 'relocate.admission', targetAdmission.reason ?? 'target admission failed');
    return fail('ADMISSION_FAILED', targetAdmission.reason ?? 'target admission failed');
  }
  const targetInfo = await deps.pathProbe.inspect(targetDir);
  if (targetInfo.isReparsePoint || (targetInfo.exists !== false && (targetInfo.linkCount ?? 1) > 1)) {
    await audit('failed', 'relocate.reparse-target', 'target is a reparse point or hard-link alias');
    return fail('ADMISSION_FAILED', 'target is a reparse point or hard-link alias');
  }
  const canonicalTarget = resolve(targetInfo.canonicalPath);
  const canonicalSource = resolve(sourceInfo.canonicalPath);
  if (isSameOrNested(canonicalSource, canonicalTarget)) {
    await audit('failed', 'relocate.canonical-nested', 'canonical target nests with source');
    return fail('NESTED_PATH', 'canonical target must not nest with source');
  }

  // ── 4. idle 校验（不做主动 end 制造空闲） ────────────────────────────────
  const affected = deps.sessionsByWorkspace(oldPath);
  if (affected.some((s) => !deps.isIdle(s.id))) {
    await audit('failed', 'relocate.not-idle', 'a session sharing this workspace is busy');
    return fail('NOT_IDLE', 'workspace has an active task or streaming turn');
  }

  // ── 5. 平台侧空目录校验 ────────────────────────────────────────────────
  if (targetInfo.exists === false) {
    try {
      await fs.mkdir(targetDir, { recursive: true });
    } catch (e) {
      await audit('failed', 'relocate.mkdir-failed', String(e));
      return fail('TARGET_NOT_EMPTY', `cannot create target directory: ${String(e)}`);
    }
  } else {
    const entries = await fs.readdir(targetDir).catch(() => null);
    if (entries === null || entries.length > 0) {
      await audit('failed', 'relocate.target-not-empty', 'target directory is not empty');
      return fail('TARGET_NOT_EMPTY', 'target directory must exist and be empty');
    }
  }

  const cleanupTarget = async (): Promise<void> => {
    await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
  };

  // ── 6. 复制到目标（fs.cp，跨盘天然规避 EXDEV） ──────────────────────────
  try {
    await fs.cp(sourceDir, targetDir, { recursive: true });
  } catch (e) {
    await cleanupTarget();
    await audit('failed', 'relocate.copy-failed', String(e));
    return fail('COPY_FAILED', `copy failed: ${String(e)}`);
  }

  // ── 7. 副本对账（文件数 + 总字节数） ─────────────────────────────────────
  try {
    const [src, dst] = await Promise.all([
      directoryStats(fs, sourceDir),
      directoryStats(fs, targetDir),
    ]);
    if (src.files !== dst.files || src.bytes !== dst.bytes) {
      await cleanupTarget();
      await audit('failed', 'relocate.reconcile-mismatch', `src=${JSON.stringify(src)} dst=${JSON.stringify(dst)}`);
      return fail('RECONCILE_FAILED', 'copy reconciliation failed (file count/bytes differ)');
    }
  } catch (e) {
    await cleanupTarget();
    await audit('failed', 'relocate.reconcile-failed', String(e));
    return fail('RECONCILE_FAILED', `reconciliation error: ${String(e)}`);
  }

  // ── 8. 批量更新 session record（单事务） ────────────────────────────────
  try {
    deps.updateWorkspacePathInTransaction(oldPath, targetDir, workspaceKind);
  } catch (e) {
    await cleanupTarget();
    await audit('failed', 'relocate.transaction-failed', String(e));
    return fail('TRANSACTION_FAILED', `session record update failed: ${String(e)}`);
  }

  // ── 9. 重绑 saddle（让工具看到新的 workspaceRoot） ───────────────────────
  try {
    for (const s of affected) {
      if (s.open) await deps.configureSession(s.id, s.profileId);
    }
  } catch (e) {
    // 重绑失败：session record 已指向新路径，副本完整，保留双份不删源。
    await audit('failed', 'relocate.rebind-failed', String(e));
    return {
      ok: false,
      code: 'REBIND_FAILED',
      reason: `saddle rebind failed: ${String(e)}; source kept as fallback`,
      keptBothCopies: true,
    };
  }

  // ── 10. 验证 ───────────────────────────────────────────────────────────
  const stillOld = deps.sessionsByWorkspace(oldPath);
  if (stillOld.length > 0) {
    await audit('failed', 'relocate.verify-failed', 'some sessions still reference the old path');
    return {
      ok: false,
      code: 'VERIFY_FAILED',
      reason: 'verification failed: stale session records remain; source kept',
      keptBothCopies: true,
    };
  }
  const targetAfter = await deps.pathProbe.inspect(targetDir).catch(() => null);
  if (!targetAfter || targetAfter.exists === false) {
    await audit('failed', 'relocate.verify-failed', 'target missing after update');
    return {
      ok: false,
      code: 'VERIFY_FAILED',
      reason: 'verification failed: target copy missing; source kept',
      keptBothCopies: true,
    };
  }

  // ── 11. 末位删源（失败保留双份 + 告警 + 审计） ──────────────────────────
  try {
    await fs.rm(sourceDir, { recursive: true, force: true });
  } catch (e) {
    await audit('failed', 'relocate.source-remove-failed', String(e));
    return {
      ok: false,
      code: 'SOURCE_REMOVE_FAILED',
      reason: `source deletion failed: ${String(e)}; both copies kept (target is authoritative)`,
      keptBothCopies: true,
    };
  }

  // ── 12. 审计（allowed） ────────────────────────────────────────────────
  await audit('allowed', 'workspace-file.allowed', `relocated to ${targetDir}`);
  // ── 13. 返回由调用方 handler 完成 ────────────────────────────────────────
  return { ok: true, workspacePath: targetDir };

  function fail(code: RelocateErrorCode, reason: string): RelocateResult {
    return { ok: false, code, reason };
  }
}
