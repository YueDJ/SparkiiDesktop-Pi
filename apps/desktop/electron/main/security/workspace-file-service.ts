/**
 * Generic workspace file service (platform capability, NO agent/business specifics).
 *
 * Exposes a small set of typed operations over a session's fixed workspace.
 * Every mutation is fenced by Workspace Admission (canonical path identity),
 * audited, and fails closed. It is the main-process counterpart to the renderer
 * P1 IPC channels and is usable by any agent — no per-agent branching.
 *
 * Security contract (approval-boundary design §4.3.1 / §9, product design R1):
 *  1. resolve the target workspace from the session record (single source of truth);
 *  2. admit the workspace root through `admitWorkspace` (protected roots, reparse
 *     points, canonical identity) — inability to prove the boundary fails closed;
 *  3. verify every target path is inside the canonical workspace root AND is not a
 *     reparse point / hard-link alias / trust anchor;
 *  4. perform the operation atomically where applicable;
 *  5. write an audit event (allow or deny) traceable to sessionId → project path;
 *  6. never throw raw success on any rejected operation.
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { AuditStore } from '@sparkii/approval';
import type { ChatSessionStore } from '../chat-session-store.js';
import { isPathInside, isPlatformReservedPath } from '@sparkii/agent-host';
import { admitWorkspace } from '@sparkii/approval';
import type { RuntimeSecurity } from '../runtime.js';
import {
  collectWorkspaceTree,
  WorkspaceTreeFenceError,
} from './workspace-tree-fence.js';

export type WorkspaceFileOp =
  | 'read'
  | 'readBytes'
  | 'write'
  | 'writeBytes'
  | 'list'
  | 'mkdir'
  | 'delete'
  | 'rename'
  | 'move';

export interface WorkspaceFileRequest {
  sessionId: string;
  /** Workspace-relative path. Must be inside the session's fixed workspace. */
  path: string;
  /** UTF-8 content, required for write. */
  content?: string;
  /** Base64 binary content, required for writeBytes (e.g. PNG). */
  bytesBase64?: string;
  /** Destination (workspace-relative) for rename/move. */
  to?: string;
}

export type WorkspaceFileErrorCode =
  | 'DENIED' | 'INVALID' | 'IO_FAILED' | 'NO_SESSION' | 'NO_WORKSPACE';

interface WorkspaceFileDenied {
  ok: false;
  code: WorkspaceFileErrorCode;
  reason: string;
}

export type WorkspaceFileResult =
  | { ok: true; op: WorkspaceFileOp; path: string; content?: string; bytesBase64?: string; entries?: string[] }
  | WorkspaceFileDenied;

export interface WorkspaceFileServiceDeps {
  chatSessions: ChatSessionStore;
  audit: AuditStore;
  security: RuntimeSecurity | undefined;
  subjectUserId: string;
}

interface ResolvedContext {
  workspaceRoot: string;
  canonicalRoot: string;
  profileId: string;
}

function workspaceRelative(path: string): string | null {
  const value = String(path ?? '');
  if (!value) return null;
  if (value.includes('\0')) return null;
  return value;
}

function deny(
  deps: WorkspaceFileServiceDeps,
  req: WorkspaceFileRequest,
  op: WorkspaceFileOp,
  code: WorkspaceFileErrorCode,
  reason: string,
  ctx?: ResolvedContext,
): WorkspaceFileDenied {
  // Fail closed AND leave a trace — a rejected write is still an audited event.
  void deps.audit.append({
    actor: deps.subjectUserId,
    action: `workspace-file.${op}`,
    resource: req.path,
    decision: 'failed',
    ruleId: `workspace-file.${code.toLowerCase()}`,
    payloadSummary: JSON.stringify({ reason, sessionId: req.sessionId, projectPath: ctx?.workspaceRoot }),
    sessionId: req.sessionId,
  }).catch(() => {});
  return { ok: false, code, reason };
}

export function createWorkspaceFileService(deps: WorkspaceFileServiceDeps) {
  /**
   * Resolve + admit the session's workspace and return canonical boundaries.
   * Never trust a renderer-supplied workspace path — always derive from session.
   */
  const resolveContext = async (
    req: WorkspaceFileRequest,
    op: WorkspaceFileOp,
  ): Promise<ResolvedContext | Extract<WorkspaceFileResult, { ok: false }>> => {
    const rec = deps.chatSessions.get(req.sessionId);
    if (!rec) return deny(deps, req, op, 'NO_SESSION', 'session not found');
    const workspaceRoot = String(rec.workspacePath ?? '').trim();
    if (!workspaceRoot) return deny(deps, req, op, 'NO_WORKSPACE', 'session workspace missing');
    const security = deps.security;
    if (!security) return deny(deps, req, op, 'DENIED', 'security layer unavailable');

    const admission = await admitWorkspace({
      target: workspaceRoot,
      protectedRoots: security.protectedRoots,
      probe: security.pathProbe,
    });
    if (!admission.ok || !admission.canonicalPath) {
      return deny(deps, req, op, 'DENIED', admission.reason ?? 'workspace admission failed');
    }
    return {
      workspaceRoot: resolve(workspaceRoot),
      canonicalRoot: resolve(admission.canonicalPath),
      profileId: rec.profileId,
    };
  };

  /**
   * Verify a target path is inside the admitted workspace and not a link/alias.
   * `allowMissing` permits creating a path that does not exist yet (write/mkdir).
   */
  const verifyTarget = async (
    req: WorkspaceFileRequest,
    op: WorkspaceFileOp,
    ctx: ResolvedContext,
    rel: string,
    allowMissing: boolean,
  ): Promise<string | Extract<WorkspaceFileResult, { ok: false }>> => {
    const security = deps.security!;
    const absolute = resolve(ctx.workspaceRoot, rel);
    // Lexical check first (catches .., absolute escapes) against canonical root.
    if (!isPathInside(ctx.canonicalRoot, absolute)) {
      return deny(deps, req, op, 'DENIED', 'target escaped the workspace', ctx);
    }
    const inspected = await security.pathProbe.inspect(absolute);
    if (isPlatformReservedPath(inspected.canonicalPath)) {
      return deny(deps, req, op, 'DENIED', '.sparkii 是平台保留目录', ctx);
    }
    let component = absolute;
    while (component !== ctx.workspaceRoot && isPathInside(ctx.workspaceRoot, component)) {
      const info = await security.pathProbe.inspect(component);
      if (info.isReparsePoint) {
        return deny(deps, req, op, 'DENIED', 'target path component is a reparse point', ctx);
      }
      component = dirname(component);
    }
    if (inspected.isReparsePoint) {
      return deny(deps, req, op, 'DENIED', 'target is a reparse point', ctx);
    }
    if (inspected.exists && !inspected.isDirectory) {
      const { lstat } = await import('node:fs/promises');
      const info = await lstat(inspected.canonicalPath, { bigint: true });
      if (info.nlink > 1n) {
        return deny(deps, req, op, 'DENIED', 'target is a hard-link alias', ctx);
      }
    }
    if (!inspected.exists && !allowMissing) {
      return deny(deps, req, op, 'INVALID', 'target does not exist', ctx);
    }
    // Canonical identity must still be inside the root (defeats symlink parents).
    if (!isPathInside(ctx.canonicalRoot, resolve(inspected.canonicalPath))) {
      return deny(deps, req, op, 'DENIED', 'canonical target escaped the workspace', ctx);
    }
    return inspected.canonicalPath;
  };

  const fenceTree = (target: string) => collectWorkspaceTree(
    target,
    async (path) => (await deps.security!.pathProbe.inspect(path)).isReparsePoint,
  );

  const auditOk = async (req: WorkspaceFileRequest, op: WorkspaceFileOp, ctx: ResolvedContext) => {
    await deps.audit.append({
      actor: deps.subjectUserId,
      action: `workspace-file.${op}`,
      resource: req.path,
      decision: 'allowed',
      ruleId: 'workspace-file.allowed',
      payloadSummary: JSON.stringify({ sessionId: req.sessionId, projectPath: ctx.workspaceRoot }),
      sessionId: req.sessionId,
    }).catch(() => {});
  };

  return {
    async execute(op: WorkspaceFileOp, req: WorkspaceFileRequest): Promise<WorkspaceFileResult> {
      const rel = workspaceRelative(req.path);
      if (rel === null) return deny(deps, req, op, 'INVALID', 'invalid path');
      if (isPlatformReservedPath(rel)) {
        return deny(deps, req, op, 'DENIED', '.sparkii 是平台保留目录，只能通过记忆设置访问');
      }

      const ctxOrErr = await resolveContext(req, op);
      if ('ok' in ctxOrErr && ctxOrErr.ok === false) return ctxOrErr;
      const ctx = ctxOrErr as ResolvedContext;

      try {
        switch (op) {
          case 'read': {
            const target = await verifyTarget(req, op, ctx, rel, false);
            if (typeof target !== 'string') return target;
            const info = await stat(target);
            if (!info.isFile()) return deny(deps, req, op, 'INVALID', 'not a file', ctx);
            const content = await readFile(target, 'utf8');
            await auditOk(req, op, ctx);
            return { ok: true, op, path: rel, content };
          }
          case 'readBytes': {
            const target = await verifyTarget(req, op, ctx, rel, false);
            if (typeof target !== 'string') return target;
            const info = await stat(target);
            if (!info.isFile()) return deny(deps, req, op, 'INVALID', 'not a file', ctx);
            const bytes = await readFile(target);
            await auditOk(req, op, ctx);
            return { ok: true, op, path: rel, bytesBase64: bytes.toString('base64') };
          }
          case 'write': {
            if (typeof req.content !== 'string') return deny(deps, req, op, 'INVALID', 'content required', ctx);
            const target = await verifyTarget(req, op, ctx, rel, true);
            if (typeof target !== 'string') return target;
            await mkdir(dirname(target), { recursive: true });
            // Atomic replace via temp file in the same directory.
            const temp = join(dirname(target), `.${Math.random().toString(36).slice(2)}.tmp`);
            await writeFile(temp, req.content, 'utf8');
            await rename(temp, target);
            await auditOk(req, op, ctx);
            return { ok: true, op, path: rel };
          }
          case 'writeBytes': {
            if (typeof req.bytesBase64 !== 'string') return deny(deps, req, op, 'INVALID', 'bytesBase64 required', ctx);
            const target = await verifyTarget(req, op, ctx, rel, true);
            if (typeof target !== 'string') return target;
            const bytes = Buffer.from(req.bytesBase64, 'base64');
            await mkdir(dirname(target), { recursive: true });
            const temp = join(dirname(target), `.${Math.random().toString(36).slice(2)}.tmp`);
            await writeFile(temp, bytes);
            await rename(temp, target);
            await auditOk(req, op, ctx);
            return { ok: true, op, path: rel };
          }
          case 'mkdir': {
            const target = await verifyTarget(req, op, ctx, rel, true);
            if (typeof target !== 'string') return target;
            await mkdir(target, { recursive: true });
            await auditOk(req, op, ctx);
            return { ok: true, op, path: rel };
          }
          case 'list': {
            const target = await verifyTarget(req, op, ctx, rel, false);
            if (typeof target !== 'string') return target;
            const info = await stat(target);
            if (!info.isDirectory()) return deny(deps, req, op, 'INVALID', 'not a directory', ctx);
            const entries = (await readdir(target)).filter((entry) => entry.toLowerCase() !== '.sparkii');
            await auditOk(req, op, ctx);
            return { ok: true, op, path: rel, entries };
          }
          case 'delete': {
            const target = await verifyTarget(req, op, ctx, rel, false);
            if (typeof target !== 'string') return target;
            if (resolve(target) === ctx.canonicalRoot) {
              return deny(deps, req, op, 'DENIED', 'workspace root cannot be deleted', ctx);
            }
            await fenceTree(target);
            await rm(target, { recursive: true, force: false });
            await auditOk(req, op, ctx);
            return { ok: true, op, path: rel };
          }
          case 'rename':
          case 'move': {
            const from = await verifyTarget(req, op, ctx, rel, false);
            if (typeof from !== 'string') return from;
            const toRel = typeof req.to === 'string' ? workspaceRelative(req.to) : null;
            if (toRel === null) return deny(deps, req, op, 'INVALID', 'invalid destination', ctx);
            const to = await verifyTarget(req, op, ctx, toRel, true);
            if (typeof to !== 'string') return to;
            if (resolve(from) === ctx.canonicalRoot || resolve(to) === ctx.canonicalRoot) {
              return deny(deps, req, op, 'DENIED', 'workspace root cannot be moved', ctx);
            }
            await fenceTree(from);
            await mkdir(dirname(to), { recursive: true });
            await rename(from, to);
            await auditOk(req, op, ctx);
            return { ok: true, op, path: toRel };
          }
          default:
            return deny(deps, req, op, 'INVALID', 'unsupported operation', ctx);
        }
      } catch (error) {
        if (error instanceof WorkspaceTreeFenceError) {
          return deny(deps, req, op, 'DENIED', error.message, ctx);
        }
        return deny(
          deps, req, op, 'IO_FAILED',
          error instanceof Error ? error.message : String(error),
          ctx,
        );
      }
    },
  };
}

export type WorkspaceFileService = ReturnType<typeof createWorkspaceFileService>;
