# M5 Capability Gateway and Approval UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`. Steps use checkbox syntax.

**Goal:** Route approved external effects through a Main-side frozen-payload gateway, expose task capability status and revocation, and migrate runtime/UI/audit JSONL away from workspace Operation approvals.

**Architecture:** The gateway validates live Task Grant, action fingerprint, normalized targets, payload hash, and a scoped lease before invoking a connector. `ASK` creates the existing Proposal; `ALLOW` creates no Proposal. Renderer receives typed capability status and displays it through the platform surface.

**Tech Stack:** TypeScript, Electron IPC, React 19, Vitest, Testing Library, SQLite audit

**Spec:** `docs/superpowers/specs/2026-10-21-agent-approval-boundary-design.md`

## Global Constraints

- Existing contract review, procurement review, knowledge Q&A, and workflow human review remain independent.
- `autoApprove` applies only to capabilities that would otherwise be `ask`.
- Hard deny, trust anchors, credentials, and critical targets are never auto-approved.
- Gateway leases are task-scoped and revoked with the task.
- Historical approval rows are read unchanged.

## Task 1: Gateway lease semantics

- [ ] Add `packages/approval/test/capability-gateway.test.ts` and a Main injection test for valid execution, changed payload hash, changed target identity, expired grant, revoked task, and missing lease.
- [ ] Implement `CapabilityGateway.issueLease()`, `executeFrozen()`, and `revokeTask()`.
- [ ] Make all external writes use the gateway; leave read-only connector reads on their existing Main path.
- [ ] Commit: `feat(approval): add frozen capability gateway leases`.

## Task 2: Proposal and audit migration

- [ ] Add tests proving Standard `allow` records `action.allowed` and `action.executed`, `ask` records Proposal events, and ordinary workspace operations never emit approval JSONL rows.
- [ ] Extend `AuditEvent` with task/action/rule/capability/payload-hash/platform fields in a backward-compatible migration.
- [ ] Update runtime timeline application so old approval rows remain visible and no new workspace CRUD rows are synthesized.
- [ ] Commit: `feat(approval): migrate audit and timeline semantics`.

## Task 3: Approval actions and capability status

- [ ] Add UI tests for “reject / once / task”, high-risk double confirm, status text `workspace writable · sandboxed command · no network · external systems unauthorized`, and revoke.
- [ ] Add typed IPC `getTaskCapabilities()` and `revokeTaskCapabilities()`.
- [ ] Render capability status in the shared chat surface and tool cards; show auto-approved reason from Main.
- [ ] Keep the inbox/claim protocol; only `ask` Proposals enter it.
- [ ] Commit: `feat(desktop): expose task capabilities and scoped approvals`.

## Task 4: Profile migration and workflow regression

- [ ] Add loader tests mapping `requireApproval`, `autoApprove`, timeout, and high-risk confirmation into `PlatformProfilePolicy`.
- [ ] Prove `autoApprove` cannot override critical targets or platform-unready states.
- [ ] Run contract, procurement, knowledge, and workflow tests.
- [ ] Commit: `feat(config): migrate agent approval policies`.

## Acceptance

- External writes cannot bypass the gateway or execute after payload/target changes.
- Standard workspace CRUD emits no approval JSONL.
- Capability approval UI shows only Main-derived targets and impact.
- Business human-review flows still require their original actions.
