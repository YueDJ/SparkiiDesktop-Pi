# R7 independent architecture reviews

## Memory truth, identity conflicts, and index consistency

- Task-id: `R7-REVIEW-TRUTH-INDEX`
- Verdict: **APPROVE**
- Report: `architecture-review-truth-index-final.txt`
- Review mode: independent read-only source and assertion inspection; no files edited and no full suite run.
- Verified: `recoverableProjectWorkspaces()` unions `privacy_recovery`, non-null `memories.workspace_path`, and project paths derived from `scope_files.file_ref`; replacement/source deletion/privacy use the snapshot before reconciliation; conflicts fail before truth commit and success events; source-delete success updates unregistered truth without reindexing; conflict eviction removes searchable rows and hashes and unchanged truth reindexes after resolution.
- Evidence: `truth-index-review-regressions-before-valid-2.txt` (5 targeted failures before repair), `truth-index-review-regressions-after-2.txt` and `truth-index-review-regressions-after-repeat.txt` (16/16 twice after repair).

## Fence and privacy deletion

- Task-id: `R7-REVIEW-FENCE-PRIVACY`
- Verdict: **APPROVE**
- Report: `architecture-review-fence-privacy-final-4.txt`
- Review mode: independent read-only source and assertion inspection; no source/tests edited and no full suite run.
- Verified: recursive path tools exclude reserved content before traversal/output/limit; direct/canonical reserved paths and recursive delete/move preflight are fenced. Privacy cleanup uses a normalized global corpus and restart-safe retry, recursively redacts every retained Gate state, preserves only structurally valid pending-operation control fields, recursively redacts invalid shapes, and uses ID/count/length/hash tool audit summaries.
- Evidence: `final3-privacy-before.txt`, `final3-whitespace-before.txt`, `final3-privacy-after.txt`, `final3-privacy-full.txt`, `fence-main-regressions-after.txt`.

## Runtime pool and logger integrity

- Task-id: `R7-REVIEW-RUNTIME-LOGGER`
- Verdict: **APPROVE**
- Report: `architecture-review-runtime-logger-final-5.txt`
- Review mode: independent read-only source and assertion inspection; no source/tests edited and no full suite run.
- Verified: resetting slots remain unavailable; failed reset retires the slot and clears aliases; event acceptance requires current client/lease/generation; successful session changes require strictly increasing safe integer generations; facade sends and release are lease-safe; workflow/IPC validate ownership across awaits and events; task-grant registration has a synchronous commit-point guard; logger redaction preserves schema, terminates rewritten JSONL, handles malformed escapes, prevents marker-boundary reconstruction, and verifies complete rewritten/exported output.
- Evidence: `runtime-direct-facade-before.txt`, `runtime-direct-facade-after.txt`, `pool-workflow-blockers-before.txt`, `pool-workflow-blockers-after-final.txt`, `final3-logger-before.txt`, `final3-logger-after.txt`, `final4-task-admission-before.txt`, `final4-ipc-after.txt`, `final4-task-lifecycle-after.txt`.
- Accepted limitation: FakeHandle/DeferredResetHandle only; no real child-process verification.
