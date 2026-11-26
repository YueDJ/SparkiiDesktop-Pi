# R8-REVIEW-TRUTH-RECOVERY final round8 candidate r12

## VERDICT: APPROVE

**Blocking finding count: 0** (4 non-blocking findings below)

### Commands run and exact results

| Command | Result |
|---|---|
| `npx vitest run apps/desktop/test/memory-truth-batch.test.ts apps/desktop/test/memory-truth-probe-daemon.test.ts apps/desktop/test/memory-round7-regression.test.ts apps/desktop/test/memory-r8-regression.test.ts` | **4 files passed, 149 tests passed, 0 failed**, 44.89s, `EXIT=0` |
| `sha256sum -c docs/.../source-sha256-final-r12.txt` | **81/81 OK, exit 0**, zero mismatches |
| `sha256sum -c docs/.../evidence-sha256.txt` | **347/347 OK, exit 0**, zero mismatches |
| `sha256sum docs/memory-evidence/repair-2026-11-24-round7/{source,evidence}-sha256.txt` | exact R7 anchors |
| `git diff --check HEAD` | exit 0, only LF/CRLF conversion warnings |

No repo file was edited; all temp output went to `%TEMP%` only. Manifest coverage confirmed: all 9 focus sources/tests are listed.

### Required checks — all satisfied

1. **Invalid journal -> evidence preserved.** `truth-batch.ts:339-346` -> `unrecoverable():271-295`: root re-fence, then `blockWrites` before quarantine, then quarantine rename-saves both journal and backups. Quarantine failure appends a warning and keeps evidence in place. `commitTruthBatch:430-438` removes backups only after verified journal removal succeeds; failure propagates with backups intact. `parseJournal:200-212` enforces all four state invariants.
2. **Crash state machine correct.** `settings.ts:56-57` fires `onRenamed` at the rename success point; `truth-batch.ts:448-452` marks committed there and separates post-rename-throw from post-return-throw. Confirmed-committed paths clean up rather than restore; uncommitted paths restore and write-block on rollback failure.
3. **Copy ordering.** `truth-path.ts:620-634` checks destination -> source -> destination -> source -> destination before `copyFileSync`; source replacement during the last destination boundary is caught before copy. Post-copy anchors retain dev/ino/mode/nlink and allow only size/mtime/ctime changes.
4. **Removal fences.** Single path and batch removal retain two fresh pre-remove boundaries plus post-remove checks. Only the ancestry native probe is shared per boundary; per-path double `lstat` and full identity comparison remain.
5. **Privacy journal replacement.** Existing destination goes through complete zero/write/fsync/readback/close fence and verified removal before re-inspecting source/destination and renaming. Failure detail is preserved.
6. **Operation fence does not skip reads.** Marker and privacy operation fences do not replace actual content reads. Same-operation snapshot reuse is returned from `reconcileAllWithTruth`; independent second reads still compare identity and content. Index transaction performs fresh identity and content rechecks.
7. **R7 preserved.** AtomicWrite fences, verified directory reads, database zeroing, unified identity, and runtime markers remain.

### Non-blocking findings

- **F1** Test debug `R8_DEBUG_PROBE` / `R8_DEBUG_B2` console output remained and was embedded in evidence. Production temporary export is gone. Fixed after this review.
- **F2** `readTruthDirectoryVerified` did not normalize raw `readdirSync` failures into `TruthPathSafetyError`. Fixed after this review.
- **F3** Post-rename committed cleanup can surface a caller-visible error after durable commit. This is conservative and was tested.
- **F4** A marker written by another process mid-operation is not re-observed. This is the disclosed no-cross-process dataDir lock limitation.

### Evidence classification

Real filesystem operations and actual hardlink replacement are used in targeted tests. Some reparse detections use injected probe markers rather than OS-detected reparse points; the direct `memory-truth-probe-daemon` tests use the rebuilt executable. Reviewer did not run full IPC/Approval/agent-host suites by instruction.
