# M3 Structured Workspace Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`. Steps use checkbox syntax.

**Goal:** Execute ordinary workspace create, modify, delete, and move operations under Main-verified identities without creating Proposals or approval JSONL.

**Architecture:** `WorkspaceExecutor` accepts only Main-normalized `SecurityAction` values and a live Task Grant. It re-inspects the root, parents, and target immediately before each filesystem mutation, writes through same-directory temporary files, and records platform audit events.

**Tech Stack:** TypeScript, Node.js filesystem promises, Vitest, Electron Main

**Spec:** `docs/superpowers/specs/2026-10-21-agent-approval-boundary-design.md`

## Global Constraints

- Workspace root itself, its parent, home, drive root, system roots, control roots, and trust anchors are never ordinary CRUD targets.
- Every mutation rechecks the target and parent chain.
- Snapshot availability never affects the decision.
- Deletion and move are first-class platform tools; ordinary use does not depend on Shell.
- Audit receives `action.allowed` and `action.executed`, but no approval JSONL rows for ALLOW actions.

## Task 1: Executor contracts and precondition checks

- [ ] Create `apps/desktop/test/workspace-executor.test.ts` with fake-path-probe tests for admitted root, changed root identity, target escape, workspace-root delete, home delete, control-data delete, and trust-anchor access.
- [ ] Run the focused test; confirm `WorkspaceExecutor` is missing.
- [ ] Create `apps/desktop/electron/main/security/workspace-executor.ts` with `execute(action, grant)` and one operation method per descriptor.
- [ ] Make every operation call `assertLiveTarget()` before and after acquiring the destination parent identity.
- [ ] Re-run the test; verify denial leaves no filesystem change.
- [ ] Commit: `feat(security): add identity-checked workspace executor`.

## Task 2: Atomic file write and edit

- [ ] Add tests that write to a missing target uses a same-directory temp file, edit replaces exact content, a target symlink is denied, and a failed rename leaves the original unchanged.
- [ ] Run tests and confirm expected red state.
- [ ] Implement `writeFileAtomic()` using mode `wx`, flush-close, and rename/replace semantics only inside the admitted workspace.
- [ ] Implement edit as read-verify-content-hash then atomic replacement.
- [ ] Re-run focused tests.
- [ ] Commit: `feat(security): execute workspace writes atomically`.

## Task 3: Delete and move

- [ ] Add tests for file delete, ordinary subdirectory recursive delete, move within workspace, cross-workspace move denial, trust-anchor descendant denial, and target replacement between normalization and execution.
- [ ] Run tests and confirm failures.
- [ ] Implement `delete` and `move` using precomputed identities and parent handles. Return the exact removed/moved item list for audit.
- [ ] Re-run tests.
- [ ] Commit: `feat(security): add structured delete and move`.

## Task 4: Runtime schemas and executor migration

- [ ] Add `workspace-tools.ts` tests proving `delete` requires an explicit target and `move` requires source/destination.
- [ ] Implement Pi tool definitions for `delete` and `move`.
- [ ] Route `edit`, `write`, `delete`, and `move` from Main to `WorkspaceExecutor`; remove the old direct `writeFile` handlers from the Standard path.
- [ ] Add an integration test that executes a runtime ALLOW action and asserts zero Proposal creation, zero approval rows, and two audit records.
- [ ] Re-run `packages/agent-host/test/coding-tools.test.ts`, `packages/agent-host/test/workspace-tools.test.ts`, `apps/desktop/test/workspace-executor.test.ts`, `apps/desktop/test/general-executor.test.ts`, and `apps/desktop/test/ipc.test.ts`.
- [ ] Commit: `feat(desktop): execute structured workspace CRUD without proposals`.

## Acceptance

- Create, edit, move, rename, and delete ordinary workspace items complete directly.
- No approval event or Proposal exists for those actions.
- Root deletion, protected ancestor access, symlink/junction escape, target swap, and trust-anchor access fail closed with no partial write.
