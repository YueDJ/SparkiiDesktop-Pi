# R8-REVIEW-TRUTH-RECOVERY Round7 Final Architecture Review

- Task ID: `R8-REPAIR-MEMORY`
- Review domain: `R8-REVIEW-TRUTH-RECOVERY`
- Review date: 2026-11-26
- Repository: `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi`
- Base HEAD: `101487d3f612764766cc024d4b28dbf846a926cf`
- Object reviewed: the current dirty worktree, including untracked truth-recovery sources and regression tests
- Review mode: independent read-only static architecture review

## Verdict

**APPROVE**

**Blocking finding count: 0**

The five Round6 findings were independently re-checked against the current implementations and regression assertions. Each has a concrete closing implementation. The current performance refactor preserves fresh path-attribute checks at the actual read/write/copy/rename/remove boundaries, retains full file-identity comparisons, and retains post-read/post-write content verification. No missing, skipped, or stale check was found that rises above the explicitly disclosed Windows TOCTOU and durability boundaries.

## Independent re-check of Round6 findings

The Round6 report was used only as a checklist of old findings. Its verdict and reasoning were not treated as authority.

| Old finding | Current result | Concrete evidence |
|---|---|---|
| B1: rollback after committed-journal rename | Closed | `settings.ts:58-59` invokes `onRenamed` immediately after `renameSync`; `truth-batch.ts:429-434` sets `committed = true` in that callback before any post-rename verification. The catch path at `truth-batch.ts:439-463` never calls `restore()` when `committed` is true. Persistent confirmation failure writes a block at `truth-batch.ts:446-449`. Regression: `memory-truth-batch.test.ts:136-184` covers once-only and persistent post-rename probe failures and asserts committed truth survives restart recovery. |
| B2: stale source at verified-copy boundary | Closed | `truth-path.ts:319-329` performs a fresh destination double inspection and then a fresh source double inspection immediately before `copyFileSync`. Post-copy destination content and source identity are verified at `truth-path.ts:331-344`. Regressions: `memory-truth-batch.test.ts:186-270` cover production recovery and direct copy replacement, asserting destination bytes remain unchanged and external bytes are not copied. |
| B3: corrupt DB/journal zeroing from stale `lstat` | Closed | `store.ts:1338-1388` now performs two fresh fences plus double `lstat`, no-follow open, handle `fstat` identity comparison, same-length zeroing, `fsync`, same-handle zero readback, post-close path identity verification, and verified removal. `compact()` routes both corrupt artifacts and `-journal` through this helper at `store.ts:1400-1409`. Regression: `memory-r8-regression.test.ts:855-897` injects an external hardlink after a fresh probe for both artifact classes and asserts the external bytes survive. |
| B4: privacy journal rename without post-rename fresh probe/content check | Closed | `service.ts:1059-1094` performs fresh source/destination inspections before rename, two fresh destination inspections after rename, dev/ino/mode/nlink/size comparison, source-disappearance verification, and verified content readback. `persistPendingPrivacy()` supplies the exact expected payload at `service.ts:1158-1163`. Regressions: `memory-r8-regression.test.ts:899-959` cover post-rename content corruption and reparse conversion before any memory registration or truth cleanup. |
| B5: agents/proposals enumeration before directory fence | Closed | Constructor fencing now occurs at `store.ts:268-274`, before `hasTruthFiles()` can run. Enumeration uses `readTruthDirectoryVerified()` at `store.ts:548-550` and `store.ts:582-587`; that helper fences twice, enumerates, and rechecks directory identity at `truth-path.ts:259-265`. Regressions: `memory-r8-regression.test.ts:961-989` cover pre-existing junctions and mocked non-symlink reparse directories for list/search/rebuild and assert external names do not reach events. |

## Architecture assessment

### 1. Truth batch journal, backup, and write-block state machine

- Journal parsing rejects invalid versions, malformed file entries, non-boolean commit markers, empty uncommitted journals, and committed journals that retain rollback items: `truth-batch.ts:196-207`.
- Target authorization is restricted to the four central truth files, direct-child JSON files under fenced agents/proposals directories, and explicitly or registry-authorized `.sparkii/memory.json` files: `truth-batch.ts:125-171`.
- Journal-declared `projectFiles` data is not trusted. Recovery authorization comes from call options, the current registry, or staged registry content: `truth-batch.ts:108-143`, `truth-batch.ts:174-194`.
- Backup paths must resolve inside the canonical backup directory, and duplicate canonical targets/backups are rejected: `truth-batch.ts:180-193`.
- Registry-first write ordering is explicit: `truth-batch.ts:382-399`. Rollback restores in reverse order: `truth-batch.ts:210-215`, `truth-batch.ts:455-463`.
- Cleanup removes the journal before backups: `truth-batch.ts:255-262`. A committed journal is never used to restore old truth: `truth-batch.ts:331-333`.
- Missing backups trigger best-effort restore/quarantine followed by persistent write-block and evidence preservation: `truth-batch.ts:335-352`.
- Corrupt or unsafe recovery evidence is quarantined only after a write-block is persisted; unsafe roots remain read-only without external quarantine writes: `truth-batch.ts:264-287`.
- Persistent markers fail closed when unreadable, malformed, or illegal, while the in-process map prevents same-process bypass: `truth-batch.ts:224-253`.

### 2. Registry-first commit and committed-journal commit point

- All change targets are canonically validated and deduplicated before journal creation: `truth-batch.ts:372-381`.
- Existing targets are backed up with verified copy before the uncommitted journal is written: `truth-batch.ts:390-407`.
- Every target write is followed by a stable regular-file check: `truth-batch.ts:424-428`.
- The durable commit point is the committed-journal rename, not the later return from post-write verification: `settings.ts:58-59`, `truth-batch.ts:429-435`.
- If rename succeeded but verification or cleanup failed, the catch branch confirms the persisted committed marker and only cleans committed evidence; it never rolls truth back: `truth-batch.ts:439-453`.
- If commit state cannot be confirmed, journal/backups are retained and writes are blocked: `truth-batch.ts:446-449`.

### 3. Verified read/copy/rename/remove and atomic write

- `inspectTruthFilesTwice()` performs one fresh batched native attribute probe followed by two full `lstat` identities per path, compares both identities, and enforces any expected identity: `truth-path.ts:187-216`.
- Verified reads fence before reading and freshly re-probe plus compare identity after reading: `truth-path.ts:272-288`.
- Verified copy rechecks source immediately before the syscall and verifies destination bytes plus source identity afterward: `truth-path.ts:303-345`.
- Verified rename rejects an existing destination, rechecks source immediately before rename, and verifies source disappearance and destination dev/ino/mode/nlink/size afterward: `truth-path.ts:352-375`.
- Verified remove double-checks identity immediately before removal and confirms absence afterward: `truth-path.ts:384-399`.
- `atomicWrite()` fences parent/target, creates an exclusive temp file, fsyncs it, rechecks temp/target identity immediately before rename, validates renamed identity, reads back exact content, and confirms temp disappearance: `settings.ts:30-83`.

### 4. Performance refactor review

The refactor does not convert an earlier batch fence into a later read/write capability.

- `settings.ts:34-37` uses a batched initial inspection only to establish parent/target expectations. The actual rename boundary is freshly inspected at `settings.ts:48-51`; renamed identity and exact content are then checked at `settings.ts:60-75`.
- `readTruthFileVerifiedResult()` still performs its pre-read double identity check and a separate post-read fresh identity check: `truth-path.ts:272-287`.
- `allScopeFiles()` explicitly re-probes every file at its actual read boundary rather than relying on the directory or operation fence: `store.ts:589-592`, `store.ts:501-506`.
- Index transactions re-read truth and compare both expected identity and content hash before committing derived rows: `store.ts:529-540`, `store.ts:733-755`, `store.ts:782-789`.
- The operation-level read fence checks truth availability once on entry to synchronous rebuild/reconcile/replace operations: `store.ts:424-444`, `store.ts:714-716`, `store.ts:759-761`, `store.ts:842-844`. Nested calls skip only repeated marker reads; they do not skip per-file path probes, identity checks, content checks, or privacy-pending checks.
- The native helper returns one normalized reparse result per requested existing path, and the caller rejects missing, extra, or invalid results: `SandboxProbe.cpp:83-91`, `truth-path.ts:23-41`, `truth-path.ts:64-73`.

No safety-relevant skip or identity/content weakening was found in these changes.

### 5. Write-block enforcement and restart behavior

- `assertTruthAvailable()` is consulted by `MemoryStore.assertAvailable()`: `store.ts:424-429`.
- List/search/row paths reach reconciliation or direct availability checks: `store.ts:543-544`, `store.ts:931-938`, `store.ts:964-970`, `store.ts:984-986`.
- Rebuild and reconcile are operation-fenced: `store.ts:714-716`, `store.ts:842-844`.
- Service startup performs root fencing, privacy-block/journal loading, privacy sink registration, truth recovery, truth availability enforcement, store construction, and only then privacy resume: `service.ts:128-153`.
- A persisted or damaged truth marker therefore prevents production store construction and all listed read paths after restart. Same-process blocking is retained by `blockedDataDirs`: `truth-batch.ts:53`, `truth-batch.ts:224-253`.
- Regression assertions cover same-process and restarted list/search/row/rebuild/ensure/preview/archive blocking, including a damaged marker: `memory-r8-regression.test.ts:703-776`. Registry symlink/hardlink/non-symlink-reparse cases cover list/search/rebuild at `memory-r8-regression.test.ts:239-274`.

### 6. Privacy/truth recovery ordering and preflight

- Pending privacy journals are loaded and their secret corpus is registered with sinks before truth recovery can restore plaintext: `service.ts:128-137`, `service.ts:166-179`.
- If truth recovery is blocked, independent Pi/chat carrier cleanup is still attempted: `service.ts:137`, `service.ts:181-224`.
- Privacy preflight completes before journal persistence or sink/truth mutation: `service.ts:1197-1228`.
- The pending journal is durable before chat registration, memory registration, Gate/Audit/Error/Logger cleanup, truth deletion, carrier deletion, or journal clearing: `service.ts:1227-1279`.
- Pending maps are removed only after verified journal zeroing/removal succeeds: `service.ts:1177-1194`.
- Privacy journal zeroing uses fresh double identity checks, handle identity verification, fsync, zero readback, post-close identity verification, and verified removal: `service.ts:957-1021`.
- Identity/project/corrupt preflight regressions assert no truth, journal, audit, logger, or chat mutation: `memory-r8-regression.test.ts:991-1025`.
- Ordering regressions assert sink registration before truth restoration and carrier cleanup despite truth write-block: `memory-r8-regression.test.ts:426-474`.

### 7. Corrupt database/journal zeroing

- The destructive helper never uses a pre-probe `lstat` as authority for a later path write. It compares the opened handle to the freshly established identity before zeroing: `store.ts:1341-1359`.
- It preserves original length, verifies every zero byte through the same handle, fsyncs, rechecks path/handle identity after close, and only then performs verified removal: `store.ts:1360-1382`.
- Both `memory.db.corrupt-*` and `memory.db-journal` use this path: `store.ts:1400-1409`.

## Regression coverage assessment

The inspected assertions provide strong static coverage for the reviewed failure classes:

- Truth state machine, rollback, evidence retention, malformed journals, target fencing, canonical aliases, registry-first recovery, and committed-marker failures: `memory-truth-batch.test.ts:81-684`, `memory-truth-batch.test.ts:686-868`.
- Fresh-probe production boundaries, index snapshot changes, SQLite path fences, and second-read rechecks: `memory-truth-batch.test.ts:898-1184`.
- Round6 B1/B2 closing cases: `memory-truth-batch.test.ts:136-270`.
- Round6 B3/B4/B5 closing cases: `memory-r8-regression.test.ts:855-989`.
- Privacy carrier ordering, restart recovery, journal identity/content, and preflight: `memory-r8-regression.test.ts:276-701`, `memory-r8-regression.test.ts:777-1155`.
- R7 privacy corpus, pending operations, indexed/unregistered project authorization, auto-list-only non-write behavior, and future episode ingress: `memory-round7-regression.test.ts:121-793`, `memory-round7-regression.test.ts:795-1014`.
- Canonical `.sparkii` fence integration: `memory-fence-canonical.test.ts:77-145`.
- Disk-index failure fallback while preserving truth reads/writes: `memory-index-fallback.test.ts:53-71`.

Non-blocking coverage gaps remain: there is no direct assertion counting native probe invocations inside `inspectTruthFilesTwice()`, and no regression injects a new write-block marker midway through one synchronous read-fenced operation. Static inspection shows the former still performs two identity comparisons and the latter is an operation-scope marker check by design; per-file fresh checks remain in place.

## Verification scope

- Fully read the five scoped memory implementations, native probe source, and all five scoped regression test files.
- Independently re-read the Round6 report only to enumerate old findings.
- Searched production call sites for truth commit/recovery/availability, store construction, compaction, and destructive zeroing.
- Ran scoped `git diff --check`; no whitespace errors were reported.
- Computed SHA-256 values below from the reviewed worktree files.
- Did not run the full suite, typecheck, or any focused reproduction. No runtime pass/fail result is claimed.
- Did not edit source, tests, configuration, dependencies, CI, or old evidence; did not stage, commit, push, or touch real user data.

## Reviewed source SHA-256

```text
fe29a2665affc4916e637f0d7251529f634ba3549d6333c0d5d6b7aae1298583  apps/desktop/electron/main/memory/truth-path.ts
07b0891ab016420a4548f41ced326d278d3d3c6817ba6f1cc9bd59234f34bf52  apps/desktop/electron/main/memory/settings.ts
25e7eb9eda1ce66d92893c36aa35454873dc4345f33ceceb2b2e15fb58e7914d  apps/desktop/electron/main/memory/truth-batch.ts
40a8c10c16d1e8379b18722604ce874e3a4c8d747d25fd5bf29e3f7bc130c37e  apps/desktop/electron/main/memory/store.ts
11742712a100ef0f3b68c44118cd570eb12c3695fc2c1e7ceeff249b0f7edf46  apps/desktop/electron/main/memory/service.ts
ca34daefcbf7bebd2332bd6387bbbdc1b723cb99385907fe799cf5fbe7ba4cdf  apps/desktop/native/windows-sandbox/SandboxProbe.cpp
e9c76269fbce76ff2ec3c6f6a7da1c58a079f439d3a86536418bb8fe26e78915  apps/desktop/test/memory-truth-batch.test.ts
da6705f0f0ba26b6a5824f2e344cada7d18901784978a7ca07aa8c1851c93256  apps/desktop/test/memory-r8-regression.test.ts
afa505f6e1952eb5cc3234a04c6e547c520afd51a3ae36e27c519a02c5c491d6  apps/desktop/test/memory-round7-regression.test.ts
3be362d295aef4cf4347361d76d72bb36436fd4ee4163bcff25685018fdbd4f6  apps/desktop/test/memory-fence-canonical.test.ts
b21a791ec6113bca4467ad4335fc155fcfbd2768a6aab1b77cb731dd97a2d4e4  apps/desktop/test/memory-index-fallback.test.ts
```

## Unverified limitations and disclosed boundaries

- Windows check/use TOCTOU remains; fresh probes, double `lstat`, handle checks, and post-operation verification narrow but do not eliminate it.
- Windows symlink creation/probing may fail with `EPERM`; current paths fail closed.
- Outside-`.sparkii` recursive hardlink aliases remain a disclosed boundary.
- There is no cross-process `dataDir` lock.
- `atomicWrite()` and journal handling do not provide power-loss-grade file/directory fsync guarantees.
- The rebuilt `SandboxProbe.exe` was not independently executed or disassembled in this review; only `SandboxProbe.cpp` and its TypeScript integration were statically reviewed.
- No real Electron package, Pi subprocess, forced process termination, power loss, disk-full condition, or real user storage was exercised.
- The main agent's suite/typecheck results were not available to this review and are not inferred.
- The worktree may change after this review; the hashes above freeze only the versions actually read.
