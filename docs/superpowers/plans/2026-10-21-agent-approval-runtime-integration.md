# M2 Runtime Approval Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the coding-tool proposal-first path with an untrusted `RuntimeActionRequest` protocol whose security semantics are recomputed by Main.

**Architecture:** Runtime sends only tool intent, arguments, and correlation IDs. Main uses a trusted action registry and platform path probe to produce `SecurityAction`, evaluates the Task Grant, routes `allow` to the execution plane, and creates a Proposal only for `ask`. Task lifecycle events revoke grants and in-flight work.

**Tech Stack:** TypeScript, Node.js 22, Electron 44, Pi SDK 1.0.2, Vitest

**Spec:** `docs/superpowers/specs/2026-10-21-agent-approval-boundary-design.md`

## Global Constraints

- Runtime-provided `toolName`, risk, summary, resource scope, and target identity are untrusted hints.
- A Standard workspace action must not call `ApprovalGate.submit()`.
- Hard deny precedes Task Grant, `requireApproval`, and `autoApprove`.
- Task revoke blocks new actions and invokes process/network/gateway cancellation.
- Agent packages contain no authorization decision branch.
- The legacy proposal transport remains only for genuinely requested capabilities and connector writes.

## Files and ownership

- `packages/agent-host/src/runtime-actions.ts`: transport-safe raw action and result types.
- `packages/agent-host/src/pi-runtime-transport.ts`: action envelopes while retaining proposal envelopes for `ASK`.
- `packages/agent-host/src/coding-tools.ts`: request actions rather than propose-first writes.
- `packages/agent-host/src/tool-registry.ts`: bind tools to the action requester.
- `apps/desktop/electron/main/security/action-normalizer.ts`: trusted descriptors and recomputation.
- `apps/desktop/electron/main/security/task-grant-factory.ts`: admission-backed grants and scratch identity.
- `apps/desktop/electron/main/security/profile-policy.ts`: normalize legacy approval YAML.
- `apps/desktop/electron/main/security/task-lifecycle.ts`: start/end/revoke orchestration.
- `apps/desktop/electron/main/workflow.ts`: action router that invokes policy and execution.
- `apps/desktop/electron/main/ipc.ts`: task start/end/abort/workspace-switch hooks.

## Task 1: Action transport contract

**Interfaces**
- Produces `RuntimeActionRequest { requestId, toolCallId, toolName, args }`.
- Produces `ActionExecutionResult { requestId, status: 'allowed'|'asked'|'denied'|'executed'|'failed', decision, result?, error? }`.
- Produces `runtimeActionEnvelope()` and `actionResultEnvelope()`.

- [ ] Write failing tests in `packages/agent-host/test/runtime-actions.test.ts` proving exact envelope directions and rejection of missing correlation IDs.
- [ ] Run `pnpm exec vitest run packages/agent-host/test/runtime-actions.test.ts`; confirm failure is the missing module.
- [ ] Add the transport types and envelope constructors. Do not add policy fields to the raw request.
- [ ] Re-run the focused test; expect all cases to pass.
- [ ] Commit: `feat(agent-host): add runtime action transport`.

## Task 2: Trusted normalizer

**Interfaces**
- Produces `ActionNormalizer.normalize(input: NormalizeActionInput): Promise<SecurityAction>`.
- Consumes a trusted descriptor with `capability`, `risk`, `resourceSelector`, `externalEffect`, and preview builder.
- Consumes `WorkspacePathProbe` from `packages/approval`.

- [ ] Write `apps/desktop/test/action-normalizer.test.ts` with tests that forge risk `read`, summary `safe`, tool name casing, and resource scope while the trusted descriptor still produces `fs.write`, `write`, and `workspace`.
- [ ] Add a missing-target test proving the canonical parent chain is inspected.
- [ ] Run the test and confirm the normalizer does not exist.
- [ ] Implement a descriptor registry for `write`, `edit`, `delete`, `move`, `bash`, `read`, `report.export`, and connector writes. Resolve paths through the probe and use `hashPayload` for the payload hash.
- [ ] Re-run the test and verify the normalized action contains only Main-derived fields.
- [ ] Commit: `feat(security): normalize runtime actions in main`.

## Task 3: Grant factory and profile migration

**Interfaces**
- Produces `createTaskGrant({ taskId, sessionId, agentId, profileId, mode, workspace, probe, scratchRoot, now })`.
- Produces `normalizeProfilePolicy(policy, platformCapabilities): PlatformProfilePolicy`.

- [ ] Write failing tests in `apps/desktop/test/task-grant-factory.test.ts` for rejected workspace admission, separate scratch, Standard defaults, and unique task IDs.
- [ ] Write failing tests in `apps/desktop/test/profile-policy.test.ts` proving `requireApproval` narrows and `autoApprove` cannot introduce unknown capabilities or remove platform hard denies.
- [ ] Run both tests and inspect expected failures.
- [ ] Implement the factory so no grant is returned when admission fails. Normalize YAML at load time rather than consulting it in Agent code.
- [ ] Re-run both tests and the config tests.
- [ ] Commit: `feat(security): create admitted task grants and profile policy`.

## Task 4: Runtime tools request actions

**Interfaces**
- Changes `CodingToolsContext.propose` to `requestAction(request: RuntimeActionRequest): Promise<ActionExecutionResult>`.
- Tool definitions still use Pi-native schemas and execute through the action requester.

- [ ] Rewrite tests in `packages/agent-host/test/coding-tools.test.ts` so Standard writes expect no `approval_required`/`approval_resolved` entries and receive an executed result.
- [ ] Add tests that an `ask` result records exactly one capability exception row but no file-level approval rows.
- [ ] Run the test file; confirm failures are the removed proposal assumptions.
- [ ] Change bash/edit/write to send raw action intents. Preserve `toolCallId` correlation and output streaming. Denied actions return an explicit not-executed tool result.
- [ ] Add `packages/agent-host/test/workspace-tools.test.ts` covering structured `delete` and `move` schemas.
- [ ] Re-run coding and tool-registry tests.
- [ ] Commit: `refactor(agent-host): route coding tools through runtime actions`.

## Task 5: Main router and lifecycle

**Interfaces**
- Produces `routeRuntimeAction(request, context)` in Main.
- Produces `TaskLifecycle.start/end/revoke/assertActive`.
- `ActionExecutionResult.decision` always echoes the Main `PolicyOutcome`.

- [ ] Write `apps/desktop/test/runtime-action-router.test.ts` for workspace ALLOW with zero `gate.submit`, external ASK with one submit, critical DENY with zero submit, and forged fields not affecting the outcome.
- [ ] Write `apps/desktop/test/task-lifecycle.test.ts` proving revoke rejects new actions and calls every registered cancellation callback exactly once.
- [ ] Run both tests; confirm failure.
- [ ] Implement the router and lifecycle. Wire prompt creation, `agent_end`, abort, session deletion, runtime release, and workspace changes to the lifecycle.
- [ ] Run focused tests plus `pnpm exec vitest run apps/desktop/test/ipc.test.ts apps/desktop/test/workflow-broker.test.ts`.
- [ ] Commit: `feat(desktop): enforce task grants in runtime action routing`.

## Acceptance

- A forged Runtime risk or summary has no effect on policy.
- Standard workspace writes reach the executor without a Proposal.
- Out-of-bound and external actions still use the Proposal/Gateway path.
- Revoked tasks cannot create actions and their cancellation callbacks run once.
- Existing workflow human steps and business tool behavior remain unchanged.
