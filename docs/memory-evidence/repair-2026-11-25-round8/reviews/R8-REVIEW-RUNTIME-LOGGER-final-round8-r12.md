# R8-REVIEW-RUNTIME-LOGGER final round8 candidate r12

## Verdict: CHANGES_REQUIRED

**Blocking finding count: 1**

### Blocking finding

Workflow LLM steps completed at prompt-command acceptance rather than correlated turn terminal.

- `apps/desktop/electron/main/workflow.ts:381` called `finish()` immediately after `await rt.promptTurn()`.
- Production `rt.promptTurn` calls `promptSession`, which returns after prompt and post-send `get_state`; it does not await the armed turn's settled promise.
- Real non-blocking Pi child accepts the prompt before assistant output/terminal.
- Consequence: listener detaches early and an LLM step can return empty/stale text. Existing workflow harness fake waited after send, masking this.

### Required remediation

- Do not finish on prompt acceptance alone.
- Await the current correlated turn for workflow callers, or explicitly consume a correlated terminal.
- Make harness resolve before turn events to match production.
- Add a regression proving acceptance-time resolution does not complete the step.

### Checks that passed

1. Immutable Main-created prompt origin propagation across action/proposal/connector-read and exact session/client/lease/admission cleanup: PASS.
2. Same-generation replacement cannot inherit shell grants or approvals: PASS.
3. Workflow serialization and late terminal attribution mechanism: PRESENT but affected by the blocking acceptance finish.
4. followUp cannot replace a superseded Task: PASS.
5. Privacy deletion stops task/extraction/Pi before destructive cleanup: PASS.
6. Physical newline secrets cannot break JSONL: PASS.
7. A/B/C late-envelope non-consumption assertions: PASS.

### Reviewer commands

- workflow/runtime router/task lifecycle: 3 files, 98 passed.
- agent-host SDK/queue/runtime/actions: 4 files, 31 passed.
- logger: 38 passed.
- IPC R8: 41 passed / 129 skipped.
- IPC A/B/C: 1 passed / 169 skipped.
- Source manifest 81/81 and evidence manifest 347/347 independently verified; R7 anchors matched.

### Known limitations

FakeHandle proves command/lease/origin bookkeeping, not real Pi subprocess behavior. Its session generation remains zero, so generation-staleness is mainly covered by agent-host tests. Packaged Electron process lifecycle and real resident daemon end-to-end exit remain unverified.

## Post-review remediation

- `ipc.ts` now arms `onPromptId` before command send and only waits `turn.settled` for workflow prompts with `waitForSettled:true`.
- `workflow.ts` correlates prompt IDs, buffers early correlated prompt errors, and finishes only after terminal/settled or a real failure.
- Workflow harness was changed to production ordering and received an explicit acceptance-only regression.
- Router now audits generic approval failure denial symmetrically.
- Remediated candidate passes full suite twice, IPC 170, Approval 94 and agent-host 219; final re-review remains required.
