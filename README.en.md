# Sparkii Desktop

> A locally-deployed, auditable AI desktop workbench — first use case: a contract review agent
>
> English · [简体中文](./README.md)

**Status:** pilot (v0.1.0, private repo) · **Platform:** Windows-first (NSIS / MSIX)

## Overview

Sparkii Desktop is an AI desktop workbench designed around three principles: **controlled**, **auditable**, and **privately deployable**. The agent kernel (Pi) is embedded in the app as a windowless child process — no separate runtime installation is required. Every write operation follows a **propose–execute separation**: it is gated by human approval and fully audited. **A denied write never happens.**

The repository is currently in the pilot phase with a built-in `contract-review` profile that demonstrates the full loop:

Upload contract → parse document → search regulations → extract clauses → compare risks → generate report → human review → approved export → audit trail

## Key Features

- **Embedded agent runtime**: the Pi kernel (`@earendil-works/pi-coding-agent`) ships inside the installer; no external pi / Node / pnpm required, and no terminal windows appear during launch or runtime.
- **Multi-agent isolation**: a bounded Pi process pool (default 4, tunable via `SPARKII_MAX_AGENTS`); each agent gets its own session; crashed child processes recover automatically with exponential backoff.
- **Approval gate + audit**: the LLM can only propose writes; a deterministic executor on the Main side runs them only after human approval. SQLite audit records are exportable — denial means no write.
- **Profile-driven configurability**: pages, workflows, skills, theme, permissions, and model routing are all declarative, with Ed25519 signed integrity checks.
- **Native skill loading**: follows the Pi SKILL.md standard — directory injection plus on-demand reading of skill bodies and references/assets via the built-in `read` tool.
- **Private / offline delivery**: data stays on the machine, delivered as a single installer, no exit telemetry. Model providers are pluggable (the pilot uses deepseek; local/cloud endpoints can be wired per profile).

## Contract Review Flow

The `contract-review` profile orchestrates these steps with a linear workflow:

1. **Parse document** `document.read` — read and parse a local contract (PDF / Word / Excel / text)
2. **Search regulations** `knowledge.search` — retrieve relevant clauses from a local BM25-indexed regulation corpus
3. **Extract clauses** `clause_extract` (skill) — extract subject matter, amount, payment, liability, dispute resolution, and other key clauses
4. **Compare risks** `risk_compare` (skill) — compare each clause against regulatory grounds, with risk levels and advice
5. **Generate report** `report` (llm) — organize findings into a structured review report
6. **Human review** — the reviewer inspects the report
7. **Approved export** `report.export` — a write operation; only after approval does the Main-side executor export the Word report
8. **Audit trail** — the whole run is recorded in an exportable audit log

```
Upload contract → load → search → extract → compare → report → human review → export (approval) → audit
```

## Architecture

Process model: Renderer ↔ Main and Main ↔ Pi Runtime are isolated layer by layer; security and compliance capabilities live in the Main control layer.

```text
┌───────────────────────────────────────────────┐
│ Renderer (React, sandboxed)                   │
│ Page composer · Chat workbench · Approval UI ·│
│ Audit view                                    │
└───────────────▲───────────────────────────────┘
                │ Electron IPC (typed, contextBridge)
┌───────────────┴───────────────────────────────┐
│ Electron Main (control layer)                 │
│ Config · Sessions · Model router · Approval · │
│ Audit · RBAC · PiRuntimePool (bounded)        │
└───────────────▲───────────────────────────────┘
                │ Structured messages (utilityProcess / fork)
┌───────────────┴───────────────────────────────┐
│ Pi Runtime child (Node, windowless, embedded) │
│ AgentSession · Skills · Read tools · Proposals│
└───────────────────────────────────────────────┘
```

Monorepo layout (pnpm workspace):

| Path / package | Responsibility |
| --- | --- |
| `apps/desktop` | Electron app: main-process assembly, typed IPC, React renderer |
| `packages/config` | Profile schema (zod), loading, validation, signature integrity |
| `packages/model-router` | Task-based model selection with fallback (chat / extract / report / default) |
| `packages/connectors` | Pure connector logic: document parsing, knowledge search, report export |
| `packages/identity` | Local accounts + RBAC (reserved `IdentityProvider` interface) |
| `packages/approval` | Approval gate + audit (SQLite WAL) + deterministic executor |
| `packages/agent-host` | Embedded Pi runtime: process pool, transports, workflow runner |
| `packages/theme` | Design tokens / skin system |
| `profiles/contract-review` | Pilot profile: manifest / agent / ui / security |

## Security & Compliance Design

- **Propose–execute separation**: there are no executable write primitives inside the Pi Runtime. Write/high-risk tools only emit a proposal with parameters frozen at proposal time (payloadHash); the Main-side `ConnectorExecutor` runs only when the authoritative approval state is "approved" — denial means no execution.
- **Approval gate**: policy comes from the profile (`requireApproval` / `timeoutMs` / `highRiskDoubleConfirm`); RBAC decides who may approve.
- **Audit**: append-only SQLite (WAL); each write attempt produces exactly one record; exportable as JSONL with actor / sessionId / profileId / decision / execution result, so approvals trace back to a specific agent.
- **Profile integrity**: Ed25519 signature verification, fail closed; unsigned profiles load only in development mode.
- **Secret protection**: encrypted at rest via Electron `safeStorage` (Windows DPAPI) — never plaintext, never exposed to the renderer.
- **Renderer sandbox**: `contextIsolation` + `sandbox`, no Node access, no credential access.
- **Data locality**: per-user data directories; no exit telemetry unless explicitly enabled.

## Quick Start

Requirements: Node.js ≥ 22, pnpm ≥ 9. Local `pnpm install` / `start.cmd` on Windows uses the better-sqlite3 package prebuild and does not need Visual Studio; packaging still needs a C++ toolchain.

```bash
pnpm install
pnpm test          # unit / contract tests
pnpm lint          # ESLint
pnpm typecheck     # repo-wide type checking
pnpm build         # build all packages
```

The app entry point is `apps/desktop/electron/main/index.ts`; in development, connect the Vite dev server via the `VITE_DEV_SERVER_URL` env var. On first run the app seeds a local demo account `admin / admin123` (development/demo only).

End-to-end acceptance (real model calls, 120s+ approval wait):

```bash
pnpm --filter @sparkii/desktop build:main
pnpm --filter @sparkii/desktop exec playwright test
```

Skip live-LLM cases when no model is available: `SPARKII_SKIP_LLM=1 pnpm --filter @sparkii/desktop exec playwright test`.

## Development Guide

Key environment variables:

| Variable | Description |
| --- | --- |
| `SPARKII_MAX_AGENTS` | Agent process pool size (default 4) |
| `SPARKII_PROFILE_DIR` | Override the profile directory |
| `SPARKII_DATA_DIR` | Override the data directory (audit, accounts, logs) |
| `SPARKII_PI_USE_FORK` | When `1`, use `child_process.fork` (fallback transport) |
| `SPARKII_SKIP_LLM` | When `1`, skip real-model E2E cases |

Testing principles: behavior contracts over snapshots; security invariants have the highest priority; LLM-dependent tests are skipped when no API key is available.

## Profile Configuration

A profile is a versioned, declarative directory that drives application behavior and appearance:

```text
profiles/contract-review/
  manifest.yaml          # metadata + model routing (task → candidate chain)
  agent/
    tools.yaml           # available tools
    workflow.yaml        # linear workflow orchestration
    skills/              # standard SKILL.md packages (progressive disclosure)
    knowledge/corpus.json# regulation corpus
  ui/
    pages/home.json      # JSON-driven page schema
    theme/tokens.json    # design tokens
  security/
    roles.yaml           # roles → pages / tools / approvable items
    approval.yaml        # approval policy
```

Pages are driven by a widget registry + JSON schema; a profile can never execute arbitrary code in the renderer. Skills follow the Pi SKILL.md standard and are read on demand via the `read` tool, including references/assets.

## Packaging & Delivery

```bash
pnpm --filter @sparkii/desktop dist
```

Artifacts land in `apps/desktop/out/`: an NSIS installer (`.exe`) and MSIX (`.appx`). The Pi Runtime and profile resources ship inside the installer — no dependency on pi / pnpm / Node on the target machine's PATH.

## Roadmap & Current Boundaries

Still a pilot; the following directions are either interface-reserved or planned:

- Multiple profiles in parallel; per-agent profile binding
- Hard isolation for the Pi Runtime (Windows restricted token / container / micro-VM; interfaces reserved)
- Audit hardening: central collection, hash-chain / appended signatures (compliance direction)
- Identity: SSO / LDAP / AD (via the reserved `IdentityProvider` interface)
- Connector expansion: ERP / MES / DCS, external data sources, local tools (interfaces reserved)
- Offline model weights delivery (Ollama / vLLM runtime packaging)
- macOS DMG / Linux AppImage packaging polish
