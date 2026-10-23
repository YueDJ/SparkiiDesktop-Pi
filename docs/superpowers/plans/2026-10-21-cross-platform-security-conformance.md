# M6 Cross-platform Security Conformance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`. Steps use checkbox syntax.

**Goal:** Add platform-neutral adapter contracts and conformance tests for Windows, macOS, and Debian/Ubuntu without claiming unverified production support.

**Architecture:** Platform adapters expose path identity, sandbox execution, process control, network isolation, and capability reports. A shared conformance suite runs the same security cases against fake macOS/Linux adapters and the real Windows adapter where available.

**Tech Stack:** TypeScript, Vitest, platform-neutral policy

**Spec:** `docs/superpowers/specs/2026-10-21-agent-approval-boundary-design.md`

## Global Constraints

- New platforms implement adapters; they do not change Policy, Task Grant, approval UI, or Agent packages.
- Unavailable isolation must produce `deny`, never an unconstrained fallback.
- Capability probes report versions and limitations, not just a boolean.
- macOS Seatbelt and Debian/Ubuntu Bubblewrap/Landlock are future implementations, not claimed complete here.

## Task 1: Adapter registry

- [ ] Add failing tests for configured adapter selection, unknown platform failure, duplicate adapter rejection, and no OS conditionals in policy.
- [ ] Implement `PlatformAdapterRegistry` in `packages/approval`.
- [ ] Commit: `feat(approval): add platform adapter registry`.

## Task 2: Shared conformance suite

- [ ] Add `packages/approval/test/platform-conformance.test.ts` covering workspace escape, critical targets, scratch isolation, network denial, IPC denial, and process-tree cancel.
- [ ] Add fake macOS and Linux adapters with deliberately unsupported capabilities to prove fail-closed behavior.
- [ ] Run the same suite against Windows when its probe is `available`.
- [ ] Commit: `test(approval): add cross-platform security conformance`.

## Acceptance

- The same Action produces the same policy decision across platform fixtures when security capabilities match.
- Missing platform capabilities produce `deny` consistently.
- macOS/Linux status is documented as contract-only until native adapters pass production probes.
