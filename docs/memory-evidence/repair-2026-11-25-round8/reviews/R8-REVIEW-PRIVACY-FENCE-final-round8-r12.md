# R8-REVIEW-PRIVACY-FENCE final round8 candidate r12

## Verdict: APPROVE

**Blocking finding count: 0** (6 non-blocking findings; 4 recommendations)

Scope: uncommitted R8 round8 increment on top of `b411f47`, reviewed read-only against `R8-MAPPING.md`.

### Required checks — all 8 hold

1. **Crash/sink recovery and restart resume.** Constructor order loads privacy write-block, journals and sink fences, then performs truth recovery/store construction and resumes pending deletion. Every journal or sink persistence failure sets a persistent block and privacy read fence. Gate blocking is cleared only after invalidations and errors are empty.
2. **Existing journal replacement is plaintext-safe.** Pre-existing destination passes fresh path fence, double identity, handle identity, original-length truncate, zero write, fsync, same-handle readback, post-close identity and verified removal before source/destination revalidation and rename. Error root cause is retained.
3. **Preflight precedes irreversible cleanup.** Scope conflict/corrupt/identity preflight runs before extraction invalidation, journal persistence and sink/truth mutation. Commit reuses the preflight plan.
4. **Write fences cover list/search/rebuild/reconcile.** Construction, scope discovery, row/search/rebuild/view and privacy resume paths assert both truth write-block and privacy unavailable state.
5. **Dynamic pending keys and markers fail closed.** Structural fields are explicitly validated; dynamic key names are registered; raw, JSON-escaped and physical-newline variants are redacted; marker characters are guaranteed absent from registered text; output and key-collision checks throw on leakage or unsafe mapping.
6. **All sinks and DB cleanup run independently.** Gate/Audit/Error/Logger/chat/Pi carriers and database/WAL/journal zeroing have separate attempts; one failure cannot skip the rest, while failure remains fenced.
7. **Future writes remain redacted.** Each sink maintains its own non-plaintext registry and rechecks registry identity before use; new writes pass through redaction.
8. **Tests were not weakened.** No skip/only/tautological assertion was introduced. Broadened workflow proposal error regex still proves rejection before execution and unchanged submit count; workflow completion handling was strengthened rather than relaxed.

### Reviewer test evidence

- R8 memory, round7, audit regression and privacy-redaction files: 131 passed.
- Daemon, truth-batch and memory-service files: 67 passed.
- Total 198 targeted tests passed. Full suite was not rerun by instruction; committed `final-r12-full-suite` rounds both report 589 passed / 1 skipped and hashes verified.

### Non-blocking findings

- **F-1 Evidence anchor:** `source-manifest-sha256.txt` recorded a stale digest for `source-sha256.txt`. Regenerated after review.
- **F-2 Mapping citation:** one focused-after filename had r10/r11 mismatch. Corrected after review.
- **F-3 Coverage:** no direct assertion that an existing destination journal was zeroed before replacement. Focused test added after review.
- **F-4 Mapping line drift:** several historical citations pointed at unrelated functions. Corrected after review.
- **F-5 Fence asymmetry:** raw indexed reads relied on later fenced operations; no leak demonstrated.
- **F-6 Open flag asymmetry:** privacy journal cleanup used `'r+'`; DB cleanup used `O_RDWR | O_NOFOLLOW`. Unified after review.

### Evidence classification

Round7/R8 privacy tests use real filesystem databases and subprocesses where applicable. R8 regression intentionally injects probe results for selected reparse targets while using real symlink/junction/hardlink mutations elsewhere; the reviewer records this as partly simulated. FakeHandle workflow/IPC tests prove control-plane ordering, not real Pi child behavior. End-to-end Electron packaged process lifecycle remains disclosed as unverified.
