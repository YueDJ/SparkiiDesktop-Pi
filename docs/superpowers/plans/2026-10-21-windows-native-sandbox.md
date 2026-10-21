# M4 Windows Native Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`. Steps use checkbox syntax.

**Goal:** Establish a native Windows execution adapter that proves workspace write, outside-write denial, credential denial, no network, no host IPC, private scratch, and process-tree cancellation before Standard Shell execution is enabled.

**Architecture:** Platform-neutral `WorkspaceSandboxAdapter` and `ProcessController` contracts live in `packages/approval`. A Windows adapter uses an AppContainer/restricted-token helper plus Job Objects, ACL grants, environment scrubbing, and explicit capability probes. If any required assertion is unavailable, the adapter reports `unavailable` or `partial` and Shell remains denied.

**Tech Stack:** Windows AppContainer APIs, Job Objects, Node.js child processes, PowerShell/C# helper for native calls, Vitest

**Spec:** `docs/superpowers/specs/2026-10-21-agent-approval-boundary-design.md`

## Global Constraints

- A string allowlist is not a sandbox.
- Standard Shell starts only when the probe proves every required boundary.
- Children inherit isolation and cannot survive task cancellation.
- Scratch is private to one task.
- Outside writes, home credentials, localhost, host services, named pipes, COM automation, reparse escapes, DOS devices, 8.3 aliases, ADS, volume GUIDs, UNC aliases, and hardlink escapes are adversarial tests.

## Task 1: Platform contracts and fail-closed status

- [ ] Add tests to `packages/approval/test/platform-security-contracts.test.ts` for `available`, `partial`, and `unavailable` capability reports and a contractual non-bypassable failure when process isolation is absent.
- [ ] Implement `WorkspaceSandboxAdapter`, `PlatformSecurityProbe`, `NetworkIsolationProbe`, and `ProcessController` interfaces with typed limitations.
- [ ] Add `ProcessController.terminateTree()` idempotence tests.
- [ ] Commit: `feat(approval): define sandbox platform contracts`.

## Task 2: Windows path identity hardening

- [ ] Add failing Windows tests for separators, case, extended prefixes, UNC, volume GUID, DOS devices, ADS colons, junctions, symlinks, hardlinks, 8.3 names, and volume aliases in `apps/desktop/test/windows-platform.test.ts`.
- [ ] Implement canonical identity using native realpath plus file IDs and link-count inspection; reject paths that cannot be proven.
- [ ] Create an adversarial fixture script that constructs aliases only under a temporary directory.
- [ ] Re-run tests and commit: `feat(security): harden Windows object identity`.

## Task 3: Native sandbox helper spike

- [ ] Add `apps/desktop/native/windows-sandbox/README.md`, helper source, and a probe test that starts a child only when the helper reports a verified AppContainer/restricted-token profile.
- [ ] Launch the helper with a suspended process, assign a Job Object with kill-on-close, grant AppContainer SID access only to workspace, scratch, and minimum read-execute runtime directories, then resume.
- [ ] Scrub API keys, knowledge tokens, provider credentials, user profile variables, and shell startup injection variables from the environment.
- [ ] Implement process-tree termination and close all handles.
- [ ] Commit: `feat(security): add Windows native sandbox helper`.

## Task 4: Adversarial prototype matrix

- [ ] Implement `apps/desktop/test/windows-sandbox-spike.test.ts` with real filesystem/process probes, skipped only when the native helper reports unavailable.
- [ ] Verify workspace write and scratch write succeed; workspace-outside write, home secret read, direct TCP, localhost TCP, named pipe connect, and host automation fail.
- [ ] Verify a grandchild process is gone after tree termination, one task cannot read another task's scratch, and all path aliases fail closed.
- [ ] Record exact observed results in `.superpowers/sdd/2026-10-21-agent-approval-platform-implementation/windows-sandbox-report.md`.
- [ ] Commit: `test(security): verify Windows sandbox boundaries`.

## Task 5: Shell integration gate

- [ ] Add tests proving `process.exec` is `deny` unless the platform probe is `available` for filesystem, network, IPC, scratch, and process-tree control.
- [ ] Wire Bash execution to `WorkspaceSandboxAdapter`; remove unconstrained `spawn`.
- [ ] Keep Shell `deny` with an explicit capability limitation if any matrix row is unavailable.
- [ ] Re-run all M4 tests and commit: `feat(desktop): run shell only in verified Windows sandbox`.

## Acceptance

- The prototype report contains observed pass/fail data for every required row.
- Standard Shell cannot start when any mandatory isolation proof is absent.
- No allowlist, command prefix, cwd setting, or environment flag is presented as a sandbox substitute.
- If AppContainer cannot satisfy a trust-anchor or host-IPC invariant, Shell remains disabled and the limitation is explicit.
