# R8 Privacy Fence Independent Review — Round 7 Final

Task-id: `R8-REPAIR-MEMORY`  
Review domain: `R8-REVIEW-PRIVACY-FENCE`  
Review date: 2026-11-26  
Repository root: `C:\Users\YDJ\Desktop\SparkiiDesktop-Pi`  
Review target: the current dirty worktree, not an earlier review or APPROVE claim.

## Verdict

APPROVE

Blocking finding count: 0

No concrete privacy-fence bypass was identified in the reviewed chains. In particular, the latest seven-field journal identity, absent-completed-journal handling, performance batching, dynamic pending-key redaction, structural-ID rejection, and canonical episode ingress did not weaken the fail-closed boundary. This verdict is limited to the scope and limitations below.

## Scope and method

Read-only source and test review covered:

- Complete `apps/desktop/electron/main/memory/{service,store,truth-path,truth-batch,privacy-redactions,extraction,consolidation,ops,tools,types,material,settings}.ts` chains (the shared redaction registry is at `apps/desktop/electron/main/privacy-redactions.ts`).
- Complete relevant chains in `apps/desktop/electron/main/{ipc,runtime,logger,chat-session-store,error-store}.ts` and `apps/desktop/electron/main/security/task-lifecycle.ts`.
- Complete `packages/approval/src/{audit,gate,proposal,executor}.ts`, `packages/approval/src/security/task-grant-registry.ts`, and `packages/agent-host/src/pi-runtime-pool.ts`.
- Relevant IPC deletion/opening/replacement ranges, task/admission lifecycle, runtime leases/generations, and `.sparkii` canonical-path fencing.
- R7/R8 memory regressions, truth-batch tests, canonical fence tests, redaction-registry tests, IPC/task-lifecycle tests, Pi pool tests, and Audit/Gate/Logger/ErrorStore/ChatSessionStore privacy tests.
- Current diffs for memory fencing changes, including whether batching removed per-read or per-mutation checks.

No source, test, configuration, old evidence, dependency, CI, or Git state was changed. No full suite or typecheck was run. No focused reproduction was necessary because the source and existing side-effect tests were sufficient for the questions reviewed.

## Findings

### Blocking findings

None.

### Non-blocking observations

1. `MemoryService.saveSettings()` writes settings directly (`apps/desktop/electron/main/memory/service.ts:250-252`) rather than explicitly calling `store.assertReadAvailable()`. This does not create a plaintext-memory read path: settings are not a memory-read API, and the write still goes through the fenced atomic writer in `apps/desktop/electron/main/memory/settings.ts:30-47,172-176`.
2. IPC deletion tests predominantly use fake memory services/supervisors. They prove sequencing and stale-binding protection at the IPC boundary, but are not a full production Electron/Pi end-to-end erasure test. The underlying real-store and runtime-pool tests cover the adjacent side effects separately.
3. The adjacent Pi path key is not DPAPI-backed. This was explicitly disclosed and is not treated as a blocker in this review.

## Evidence assessment

### 1. Startup order, automatic resume, and fail-closed reads

- `MemoryService` fences the truth root, loads the persistent privacy write-block, loads pending privacy journals, and registers all pending privacy sinks before truth-batch recovery (`apps/desktop/electron/main/memory/service.ts:120-131`).
- Carrier cleanup is attempted before index construction when truth recovery is blocked (`service.ts:132,176-183`).
- Settings and `MemoryStore` construction occur only after privacy journals/sinks and truth recovery (`service.ts:135-147`).
- Pending privacy deletion is automatically resumed after store construction (`service.ts:147,230-239`).
- Store reads call `assertAvailable()`, which checks both the truth write-block and pending-privacy warnings unless the caller is the explicitly scoped cleanup operation (`apps/desktop/electron/main/memory/store.ts:424-444`). Public row/list/search/reconciliation paths use that fence, including `store.ts:496-499,543-545,611-613,693-701,964-967`.
- Truth recovery failures enter a persistent write-block/unrecoverable path rather than silently continuing (`apps/desktop/electron/main/memory/truth-batch.ts:236-247,264-327`); `assertTruthAvailable()` turns that block into a read failure (`truth-batch.ts:294-297`).

Assessment: restored plaintext cannot become visible through the normal memory index/read path while privacy cleanup or truth recovery remains incomplete.

### 2. Journal crash states, temp promotion, absent completion, and identity replacement

- Journal names are SHA-256(sessionId), not plaintext session IDs (`apps/desktop/electron/main/memory/service.ts:888-890`).
- Startup accepts only the exact journal/temp naming forms, verifies the temp identity/content, promotes via a verified rename, and restores pending context only afterward (`service.ts:1091-1137`).
- Persistence writes a unique `wx` temp, verifies it, renames with identity/content checks, and updates in-memory state only after successful rename (`service.ts:1140-1170`).
- Failed temp persistence is zeroed before removal; inability to clean it safely persists a privacy write-block (`service.ts:1162-1169,1222-1229`).
- `clearPendingPrivacy()` accepts an absent final journal, allowing crash completion after journal removal, but rejects an existing journal whose seven-field identity differs from the recorded identity (`service.ts:1172-1188`).
- Zero/remove requires a regular single-link file, compares expected identity, rechecks path and descriptor identity, truncates/overwrites with zeros, fsyncs, reads back all zeros, and removes through `removeTruthPathVerified()` (`service.ts:952-1088`).
- Pi carrier cleanup similarly requires an absolute, fenced, regular single-link file, compares seven identity fields immediately before removal, uses `force: false`, and confirms absence before deleting the Chat row (`service.ts:186-218`).

Assessment: crash-before-rename, crash-after-rename, crash-after-carrier/truth cleanup, and crash-after-journal removal have distinct safe outcomes. Missing completed journal is not confused with an existing replaced journal.

### 3. Performance batching and seven-field truth identity

- `truthFileIdentity()` includes `dev`, `ino`, `mode`, `nlink`, `size`, `mtimeMs`, and `ctimeMs` (`apps/desktop/electron/main/memory/truth-path.ts:115-122`).
- Batched path inspection queues all path-chain checks and performs one attribute-probe flush, but then obtains two consecutive per-file stats probes and compares each file's full identity (`truth-path.ts:163-180,187-207`).
- Verified reads inspect twice before opening/reading and revalidate afterward (`truth-path.ts:272-288`).
- Rename and remove verify expected identity and post-operation state (`truth-path.ts:352-397`).
- The store does not treat a batch fence as a read capability: every scope file is probed again at its actual read boundary (`apps/desktop/electron/main/memory/store.ts:590-592`).
- `withReadFence()` avoids repeated root-block checks only inside an already-fenced operation; it does not bypass verified per-file reads (`store.ts:432-440`).
- Settings writes retain parent/target checks, temp fsync, pre-rename double inspection, and post-rename identity/content verification (`apps/desktop/electron/main/memory/settings.ts:30-47`).

Assessment: batching reduces duplicate ancestor/attribute probes but does not remove identity comparison, read-boundary revalidation, or mutation-boundary fencing.

### 4. Persistent non-plaintext redaction registry and ingress fencing

- Registry patterns contain SHA-256 fingerprints and lengths, not plaintext; character fingerprints support safe marker selection (`apps/desktop/electron/main/privacy-redactions.ts:20-27,114-152`).
- Original, JSON-escaped, multiline, and physical-line variants are registered (`privacy-redactions.ts:114-138`).
- The initialization tombstone makes later registry deletion fail closed in both the current process and a new process (`privacy-redactions.ts:53-79`).
- Registry files must be regular, single-link, mode-safe files; malformed/missing initialized registries are rejected (`privacy-redactions.ts:67-96`).
- Output is checked again after longest/non-overlapping replacement (`privacy-redactions.ts:198-216`), including physical-newline spanning checks (`privacy-redactions.ts:175-180`).
- Memory entries, excerpts, pending operations, dynamic keys, episodes, and episode topics pass through this registry before truth/index writes (`apps/desktop/electron/main/memory/store.ts:1058-1142,1234-1309`).
- Top-level structural fields are preserved only when valid, and their values are rejected if they contain registered patterns; nested look-alike structural fields and dynamic keys are redacted (`store.ts:1243-1294`; `apps/desktop/electron/main/memory/types.ts` structural validators).
- Future `addMemoriesBatch` episode input and direct episode append/summary updates are redacted before persistence (`store.ts:1098-1142`).

Assessment: current and future memory writes cannot reintroduce a registered secret through the reviewed ingress paths; structural identifiers are not used as a redaction bypass.

### 5. Preflight before irreversible global cleanup

- Privacy preflight discovers registry, supplied, and recoverable/indexed project workspaces (`apps/desktop/electron/main/memory/store.ts:656-657,675-692,1474-1488`).
- Corrupt truth and identity conflicts abort before mutation (`store.ts:1480-1488`).
- Only trusted registered/recoverable project refs are included in global cleanup (`store.ts:1413-1428`).
- The operation re-runs preflight, registers the complete deleted/survivor corpus, removes source-matching entries, redacts survivors and canonical episodes/extraction state, commits truth in one batch, then reconciles and compacts the derived database (`store.ts:1497-1551`).
- MemoryService persists the recovery journal and registers Chat/Memory/Gate/Audit/Error/Logger sinks before destructive truth cleanup (`apps/desktop/electron/main/memory/service.ts:1202-1261`).
- Cleanup continues across independent sinks so one registration/cleanup failure does not prevent the other sinks from being protected; the journal remains pending and reads stay fenced (`service.ts:1231-1257`).

Assessment: preflight failures leave truth, journals, Audit, Logger, and Chat unchanged; partial cleanup remains retryable and non-readable.

### 6. Audit, Gate, ErrorStore, Logger, and Chat current/future writes

- Audit redacts every text column before insert and redacts query filters/results and JSONL export (`packages/approval/src/audit.ts:280-335,382-385`). History cleanup persists the registry before transactional scrubbing and WAL/VACUUM cleanup (`audit.ts:338-379`).
- Gate submit/decide reject or mark privacy-redacted proposals, re-fetch canonical state after awaited audit work, and use object-identity compare-and-swap for approved payload replacement (`packages/approval/src/gate.ts:52-110`). Cleanup retains a block until invalidation listeners finish (`gate.ts:224-273`).
- Executor refuses non-approved or privacy-redacted proposals (`packages/approval/src/executor.ts:10-13`); IPC revalidates canonical approved proposals and task ownership before execution (`apps/desktop/electron/main/ipc.ts:3165-3328`).
- ErrorStore redacts id/message/source on append and read, and scrubs all rows transactionally (`apps/desktop/electron/main/error-store.ts:55-109`).
- Logger redacts structured values and rejects unsafe dynamic keys/output, including malformed historical lines and multiline carriers; session cleanup, prompt-log cleanup, and export all use the registry (`apps/desktop/electron/main/logger.ts:126-216`).
- ChatSessionStore redacts current create/update/list/get paths, encrypts the raw Pi carrier path in a BLOB, permits raw-path access only for explicit privacy cleanup, and transactionally removes the target row while preserving survivor raw mappings by raw row ID (`apps/desktop/electron/main/chat-session-store.ts:169-229,244-326`).
- Runtime constructs Audit/Gate/Chat/Error before MemoryService and wires cleanup-only raw Pi access plus Chat privacy deletion (`apps/desktop/electron/main/runtime.ts:201-230`).

Assessment: no reviewed current/future sink write bypass was found.

### 7. IPC active task/extraction/Pi teardown and same-ID replacement safety

- Privacy memory deletion is serialized per session through a tombstone and deletion promise; it awaits runtime stop before memory mutation and retains the tombstone when pending privacy cleanup failed (`apps/desktop/electron/main/ipc.ts:812-817,2779-2801`).
- Runtime stop increments the opening epoch, sets the stopping/tombstone gate, captures and cancels in-flight acquisition, awaits it, ends the active admission, stops document parsing, persists the latest carrier path, releases the exact lease, and cancels extraction (`ipc.ts:2803-2866`).
- New/reopened sessions are rejected while stopping/deleting, and opening is rechecked after every await (`ipc.ts:1204-1269`).
- Runtime requests validate client, binding lease, and session generation (`ipc.ts:574-657,1154-1202`). Prompt and terminal-event paths validate task/admission/lease/prompt identity before affecting replacement state (`ipc.ts:1287-1373,2177-2261`).
- TaskLifecycle creates pending admissions before factory awaits, rechecks before commit, distinguishes cancelled/committed admissions, and scopes end/revoke to the captured admission (`apps/desktop/electron/main/security/task-lifecycle.ts:51-108,110-147,181-290`).
- TaskGrantRegistry forbids task-ID reuse and revokes the prior same-session grant on replacement (`packages/approval/src/security/task-grant-registry.ts:30-48,61-80`).
- PiRuntimePool rotates a lease on every bind, requires strictly increasing session generations for session-changing commands, filters events by client/lease/generation, and retires uncertain or cancelled openings (`packages/agent-host/src/pi-runtime-pool.ts:192-215,250-273,408-445,544-600`).

Assessment: stale completion, old release, cancelled acquisition, and same-ID replacement cannot target the replacement through the reviewed paths. Destructive memory cleanup waits for runtime quiescence.

### 8. `.sparkii` path fencing

- Project truth is fixed to `<workspace>/.sparkii/memory.json` (`apps/desktop/electron/main/memory/settings.ts:136-139`).
- Truth paths reject non-absolute paths, symlinks/reparse points, hardlinked files, and unstable identities (`apps/desktop/electron/main/memory/truth-path.ts:44-86,115-122,187-207`).
- Truth-batch targets are allowlisted and project targets require explicit authorization (`apps/desktop/electron/main/memory/truth-batch.ts:146-185`).
- Generic workspace IPC and WorkspaceExecutor tests use real junctions/hardlinks and assert the canonical memory file remains unchanged (`apps/desktop/test/memory-fence-canonical.test.ts:77-144`).

Assessment: direct canonical, alias, and hardlink access to `.sparkii/memory.json` is denied in the reviewed paths.

## Do the tests assert real side effects?

Yes, for the core privacy and persistence paths.

- `apps/desktop/test/memory-r8-regression.test.ts` uses real temporary files and real MemoryService/Audit/Gate/Chat/Error/Logger stores. It asserts actual JSONL bytes, DB/WAL bytes, exports, registry contents, journal temp contents, carrier existence, restart behavior, and fail-closed reads. Examples: zero-readback and external-victim preservation at lines 277-304 and 542-579; automatic temp promotion at 607-624; sink/carrier restart at 329-474; identity replacement at 505-519 and 1108-1154; preflight no-mutation at 991-1025.
- `apps/desktop/test/memory-round7-regression.test.ts` asserts real truth/SQLite/audit/logger/chat side effects and physical carrier deletion (lines 122-239), plus dynamic keys, structural IDs, and future episode ingress (lines 827-1013).
- `apps/desktop/test/memory-truth-batch.test.ts` performs actual file mutation/restoration and checks rollback, committed-journal behavior, backup retention, identity replacement, and path fencing.
- `apps/desktop/test/privacy-redactions.test.ts` reads the real registry/tombstone and verifies plaintext absence, fail-closed deletion, unsafe-link rejection, marker rotation, and output verification.
- `apps/desktop/test/memory-fence-canonical.test.ts` uses real junctions/hardlinks and checks target bytes remain unchanged.
- Audit/Gate/Logger/ErrorStore/ChatSessionStore tests use real temporary persistent stores and, where relevant, reopen them to verify future-write fencing and residue removal.

Important qualification: `apps/desktop/test/ipc.test.ts:4937-5305` primarily uses fake memory/supervisor objects. Those tests assert real call ordering, acquisition cancellation, lease selection, and absence of destructive calls, but do not by themselves prove production carrier erasure. `packages/agent-host/test/pi-runtime-pool.test.ts` uses fake supervisors to exercise the real pool state machine; it is not a real Pi child-process integration test. These are coverage limitations, not observed bypasses.

## Source SHA-256 values read

Hashes identify the exact worktree bytes reviewed. Paths are repository-relative to the root stated above.

| Source | SHA-256 |
|---|---|
| `apps/desktop/electron/main/memory/service.ts` | `5004c17675f15cedf003289c7a16ffb2a928cecbf468e3192e41a250bd1494af` |
| `apps/desktop/electron/main/memory/store.ts` | `f5ba9565427e6428451d3b06078b2e9b3b01a033d1609954134518f1071adc64` |
| `apps/desktop/electron/main/memory/truth-path.ts` | `95e121a4f14d817eded458f1888c242d17b88fb219c56676efdfafe30820a0ab` |
| `apps/desktop/electron/main/memory/truth-batch.ts` | `25e7eb9eda1ce66d92893c36aa35454873dc4345f33ceceb2b2e15fb58e7914d` |
| `apps/desktop/electron/main/memory/extraction.ts` | `ea2d7edc548712a4a008603f33e513d96865bf92741bbee9a6cf46be1cae9b3b` |
| `apps/desktop/electron/main/memory/consolidation.ts` | `e8bd8993c3b7dcaa5301f7cd0890a39beccf029421530d8d759b1f7550bf8657` |
| `apps/desktop/electron/main/memory/ops.ts` | `12732f5ce11e61dc060f5f89f1a1f7506a7567a2d5fe423b04ad3834cc667a63` |
| `apps/desktop/electron/main/memory/tools.ts` | `f96c5663a8bee479caa6094950f5705f846baf0de91a27cda76e588586152449` |
| `apps/desktop/electron/main/memory/types.ts` | `0280737f5573b3326b1e96dba74ea0bcd4f95df75b6b0ac58ab528d672ef9f45` |
| `apps/desktop/electron/main/memory/material.ts` | `84b5fee184944d2cfe6adf78f763ab953f01c50080979d4c6fd5e8ffab479773` |
| `apps/desktop/electron/main/memory/settings.ts` | `07b0891ab016420a4548f41ced326d278d3d3c6817ba6f1cc9bd59234f34bf52` |
| `apps/desktop/electron/main/ipc.ts` | `15ab2b42d3ed56dce164856d90e0458397c60223be502b3c9e2d8d23b379cab2` |
| `apps/desktop/electron/main/runtime.ts` | `a1ea5b4e31e6a8527dcabc3f239f6fa81c1294eb57b86b7d39af1588a897f242` |
| `apps/desktop/electron/main/logger.ts` | `26f2b3ad83584e5e7d5ade06723d7d00bcbf5c047913fcb9310f2f9f6231c71d` |
| `apps/desktop/electron/main/chat-session-store.ts` | `691e037476b482b025f82c6502e94ce1f7f1a3d9edbc933f479a672b811a7b62` |
| `apps/desktop/electron/main/error-store.ts` | `1f69d2d61a25fa2f5a84eab0b709cb0ef88b34f025b43e6a819d993a24ff7e97` |
| `apps/desktop/electron/main/privacy-redactions.ts` | `9b6b388cc75300fe3a369c1d24dfee1f68b8c9b461ce1e4c6c2f4b0d31c31a71` |
| `apps/desktop/electron/main/security/task-lifecycle.ts` | `51320a59598465af312e22e3647b3505fb8a48fbd3b476088a54740aa320f7d0` |
| `packages/approval/src/audit.ts` | `02ee441e45639583d81af96a273f68e9e165e6994a9855cd74e2fda73b7c9783` |
| `packages/approval/src/gate.ts` | `0c53f5e35a41850c8c61f66a6fbe478d8d5c535e71c6b8d42f5d8dc0a461ba6b` |
| `packages/approval/src/proposal.ts` | `35cec3efc8feb416a6d613a2070a23907a1f7075f55166fefa36311dcfe2cf00` |
| `packages/approval/src/executor.ts` | `dc25cff779e4389c4774f1183d5a0ea80c49c6ca2bb25404e2fbf8962b21669b` |
| `packages/approval/src/security/task-grant-registry.ts` | `be0d6cbf1eaf799584267e2bc4dafb8e8514ef65b7ad866718bb41af67e8cc5b` |
| `packages/agent-host/src/pi-runtime-pool.ts` | `2b763a29877eee6008754917bf1bb129bdcf575417ffe6826ea077086be29375` |

## Test SHA-256 values read

| Test | SHA-256 |
|---|---|
| `apps/desktop/test/memory-r8-regression.test.ts` | `da6705f0f0ba26b6a5824f2e344cada7d18901784978a7ca07aa8c1851c93256` |
| `apps/desktop/test/memory-round7-regression.test.ts` | `afa505f6e1952eb5cc3234a04c6e547c520afd51a3ae36e27c519a02c5c491d6` |
| `apps/desktop/test/memory-truth-batch.test.ts` | `e9c76269fbce76ff2ec3c6f6a7da1c58a079f439d3a86536418bb8fe26e78915` |
| `apps/desktop/test/memory-fence-canonical.test.ts` | `3be362d295aef4cf4347361d76d72bb36436fd4ee4163bcff25685018fdbd4f6` |
| `apps/desktop/test/memory-fence.test.ts` | `70d7134583bff9a32da4ea34bbfdec932a46eb7318eb371b7038a81e60b785f6` |
| `apps/desktop/test/privacy-redactions.test.ts` | `671264c57cc37f57bf59c8819639a4119241e463b20cc195d250d666813686fc` |
| `apps/desktop/test/ipc.test.ts` | `54c88acee4347b5ef7bd11a4ce2c89c626379ecb2017a3d8e054be8b2f0bae31` |
| `apps/desktop/test/task-lifecycle.test.ts` | `73d35238468736de49534c1d1d41cf9f9915d2f4eecc38603f7eed80fa43b68d` |
| `apps/desktop/test/logger.test.ts` | `458ad63859547959243b18be82faeecc49f7cc0621b7edd6679f55f9a9c939c0` |
| `apps/desktop/test/error-store.test.ts` | `df5d4a9a2c27d68336564eff0a2f9435d6e7f58e74bb2eec582471374ec145ce` |
| `apps/desktop/test/chat-session-store.test.ts` | `ff7368f890f8710dc6ea318429fffe71b013a777738ac105b81a5c1ff8255518` |
| `packages/approval/test/audit.test.ts` | `c2461dc59b6893c6282a6f0530e31b3b4a5d23563f672899f647ecf6dd5a0c9e` |
| `packages/approval/test/gate.test.ts` | `e0d2cf2ee60faed1e69ba197b5c2ad1d946f9fffba267c7a4d6f44606e84d9b1` |
| `packages/agent-host/test/pi-runtime-pool.test.ts` | `be73f227c6d8a308d090bb2309f304bd1b61de1891db7d62ffa95d693501d502` |

## Limitations

- This was a static independent review. Tests were inspected but not executed, as requested; the main agent owns full-suite/typecheck validation.
- No power-loss simulation, cross-process concurrent `dataDir` mutation, real Pi child-process integration, or hostile local attacker race was performed.
- The following disclosed conditions were not treated as automatic blockers: Windows TOCTOU, Windows symlink EPERM, recursive hardlink aliases outside `.sparkii`, the non-DPAPI adjacent Pi key, absence of a cross-process `dataDir` lock, and lack of power-loss-grade fsync.
- Fake-supervisor IPC/Pi tests do not replace production end-to-end validation. Real-store tests do provide concrete file/DB/restart side-effect assertions for the core privacy paths.
- Source hashes apply to the reviewed worktree snapshot. Subsequent edits require re-review of the affected chains.
- This APPROVE does not extend to unrelated architecture/security domains.
