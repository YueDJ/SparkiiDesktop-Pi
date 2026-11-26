# R8 Runtime/Logger Independent Review — Round 7 Final

- Task-id: `R8-REPAIR-MEMORY`
- Review domain: `R8-REVIEW-RUNTIME-LOGGER`
- Reviewed worktree: `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi`
- Reviewed HEAD: `101487d3f612764766cc024d4b28dbf846a926cf`
- Review date: 2026-11-26
- Review mode: independent, read-only review of the current dirty worktree; no prior approval was accepted as evidence.

## Verdict

**CHANGES_REQUIRED**

**Blocking finding count: 1**

The round6 pool/release and prompt-terminal findings are substantively repaired in the reviewed source. One independent Task-origin integrity blocker remains in the child-to-Main runtime request path.

## Blocking finding

### B1 — Same-generation runtime tool/proposal requests are attributed to the current Task, not their originating Task

**Severity:** blocking. A superseded Pi turn can continue on the same client, lease, and session generation after its Task admission is replaced. A later `followUp` can establish a new Task on that still-running old turn. Runtime actions, proposals, and connector reads emitted by the old turn then arrive without an originating Task/admission token and Main binds them to the new Task. This defeats the Task boundary for `runTool`, `requestApproval`, and connector reads, and can let an old workflow action inherit the replacement Task's permissions or task-scoped shell grant.

**Concrete evidence:**

1. Runtime action requests contain only `requestId`, optional `toolCallId`, `toolName`, and `args`; there is no Task, admission, prompt-turn, or origin token:
   - `packages/agent-host/src/runtime-actions.ts:3-8`
   - `packages/agent-host/src/pi-runtime-transport.ts:28-39`

2. The SDK host stamps these requests only with `sessionGeneration`:
   - `packages/agent-host/src/pi-sdk-runtime.ts:268-273`
   - The same is true for proposals and connector reads at `packages/agent-host/src/pi-sdk-runtime.ts:254-266`.

3. The supervisor rejects only a changed session generation. It has no Task-origin check:
   - `packages/agent-host/src/pi-runtime-supervisor.ts:173-189` (actions)
   - `packages/agent-host/src/pi-runtime-supervisor.ts:149-163` (proposals)
   - `packages/agent-host/src/pi-runtime-supervisor.ts:209-221` (connector reads)

4. Main validates client, lease, and generation, then captures whichever Task owner is current at request-arrival time:
   - `apps/desktop/electron/main/ipc.ts:574-599`
   - Specifically, `captureTaskOwner(sessionId)` is called at request arrival (`ipc.ts:582`), not bound to the Task that started the Pi turn.
   - The captured replacement owner is passed into the router at `ipc.ts:627-630`.
   - Proposals do the same at `ipc.ts:635-655`.
   - Connector reads validate only the runtime binding around `handleConnectorRead` at `ipc.ts:1399-1410`; `document.read` separately captures the then-current grant at `ipc.ts:1507-1528`, while knowledge/ontology paths have no Task-origin token.

5. A normal prompt replacement commits a new admission without changing the pool client, lease, or session generation:
   - `apps/desktop/electron/main/ipc.ts:2156-2183`
   - `apps/desktop/electron/main/ipc.ts:2235-2244`
   - `packages/approval/src/security/task-grant-registry.ts:40-49`

6. Task replacement revokes the old grant, but the registered cancellation hooks terminate shell/reviewer/gateway/approval state; they do not abort or drain the old Pi prompt:
   - `apps/desktop/electron/main/ipc.ts:718-746`
   - `packages/approval/src/security/task-grant-registry.ts:45-48`

7. Workflow prompts are not registered in the Main prompt-turn queue and are sent without a `promptId`:
   - `apps/desktop/electron/main/workflow.ts:308-375`
   - `apps/desktop/electron/main/workflow.ts:800-813`
   - The workflow helper detaches its event listener when its admission guard fails (`workflow.ts:356-368`), but that does not abort the underlying Pi run.

8. The installed Pi SDK confirms that a prompt submitted while another run is streaming is queued as a steering/follow-up message on the existing run:
   - `<PI_SDK>/dist/core/agent-session.js:1682-1694`
   - `<PI_SDK>` is defined absolutely in the hash appendix below.

9. Only `behavior: 'prompt'` creates a `PromptTurn`; `followUp` does not. The `agent_settled` cleanup path requires such a turn:
   - `apps/desktop/electron/main/ipc.ts:2156-2175`
   - `apps/desktop/electron/main/ipc.ts:1325-1366`
   - Consequently, the replacement Task created for the queued follow-up in the interleaving below can remain active without a correlated turn, while the old run continues to emit requests.

**Reachable interleaving:**

1. Workflow Task A starts a Pi run. Before Main observes `agent_start`, user prompt B reads `isStreaming: false` and selects `behavior: 'prompt'`.
2. B's asynchronous Task factory yields. Workflow A becomes streaming in that window.
3. B commits admission B, replacing A. No Pi abort/drain occurs. B's prompt then deterministically fails because the SDK is already streaming; the correlated `prompt_error` ends B's turn/admission, while workflow A's Pi run continues.
4. User prompt C reads `isStreaming: true`, selects `followUp`, starts Task C because no owner remains, and queues C onto the still-running workflow A run.
5. Workflow A emits a late action/proposal/connector read. Its envelope still has the same client, lease, and session generation, so all current runtime-binding checks pass. Main captures Task C as owner and routes A's request under C's grant.
6. If A's tool is shell, C's task-scoped shell grant can authorize it; if A's connector write needs approval, the approval is attributed to C. The original admission A can no longer veto the request because it is absent from the envelope.

This is not a Windows filesystem TOCTOU issue. It is a concrete same-client/same-lease Task authorization bypass in the runtime control plane.

**Required repair:**

- Propagate an immutable Main-created Task/admission or prompt-turn origin token through the prompt command and SDK session context, and include it in every action, proposal, and connector-read envelope.
- Main must validate that exact origin token before capturing an owner and again across every asynchronous authorization/execution boundary. A request with no provable origin must fail closed.
- Workflow `sendPrompt` must participate in the same turn correlation/serialization scheme as normal prompts.
- Additionally, do not allow a `followUp` to create a new Task on a run owned by a superseded Task; either abort and await the old run before committing the replacement or keep the follow-up bound to the old origin and reject it when that origin is no longer current.

**Required regression:**

Add a regression that asserts the full interleaving above and then delivers a late action and proposal from workflow A after Task C is active. It must assert:

- the exact prompt/follow-up command sequence and `promptId` values;
- A, B, and C admission/task state at each step;
- unchanged client, lease, and session generation;
- denial of A's late action/proposal with no executor call, no approval submission, and no task-shell-grant consumption;
- preservation of C's grant and binding.

A rejection-only assertion at the IPC boundary is insufficient; the test must prove that no authorized workspace/shell/connector execution occurred.

## Other scoped results

### Workflow and IPC original-binding guards

No additional blocker was found in the reviewed workflow lease propagation:

- `selectModel` guards settings load, key lookup, `set_api_key`, and `set_model`: `apps/desktop/electron/main/workflow.ts:248-290`.
- `applyThinkingLevel` guards before and after the runtime command: `workflow.ts:236-246`.
- `sendPrompt` captures client plus lease and rechecks before subscription, on events, before/after send, and after terminal settlement: `workflow.ts:308-385`.
- Workflow tool writes and approvals carry the original Task/admission: `workflow.ts:388-479`, `workflow.ts:804-824`.
- `onReady`, rename, admission installation, journal append, loop progress, and release are binding/admission guarded: `workflow.ts:541-649`, `workflow.ts:684-771`, `workflow.ts:774-873`.
- Production workflow `onReady` and `beforeRelease` verify the exact open object, lease, and admission: `apps/desktop/electron/main/ipc.ts:3592-3652`.

These guards correctly prevent stale workflow output/journal/release, but they do not supply the missing origin token for SDK-generated runtime requests; that gap is B1.

### Task generation and atomic commit

No additional blocker was found:

- A pending admission is installed before the asynchronous factory: `apps/desktop/electron/main/security/task-lifecycle.ts:51-71`.
- The admission is rechecked after factory resolution and immediately before registry commit: `task-lifecycle.ts:76-92`.
- `owner()` returns an atomic frozen Task/admission snapshot only for a committed admission matching the registry grant: `task-lifecycle.ts:126-148`.
- Exact-token end/revoke paths avoid touching replacements: `task-lifecycle.ts:181-219`.
- Failed admissions restore a still-valid previous owner or keep a cancelled barrier: `task-lifecycle.ts:245-287`.
- Same Task IDs cannot be reused: `packages/approval/src/security/task-grant-registry.ts:31-48`.

### Pi pool lease, cancellation, and lifecycle lane

No additional blocker was found:

- Every bind receives a new immutable lease, including same-client/same-ID reuse: `packages/agent-host/src/pi-runtime-pool.ts:16-29`, `408-460`.
- Per-child lifecycle commands are serialized by a non-rejecting promise tail: `pi-runtime-pool.ts:240-253`.
- Release queues behind an opening bind and rechecks the exact lease at execution time: `pi-runtime-pool.ts:544-587`.
- Cancelled or ownership-uncertain opening binds retire the child and await supervisor stop: `pi-runtime-pool.ts:327-360`, `408-456`.
- `cancelAcquire` plus `waitForAcquire` cover queued, cold-starting, and in-flight bind/retirement work: `pi-runtime-pool.ts:173-212`.
- Retirement removes the slot and all aliases synchronously before awaiting process exit: `pi-runtime-pool.ts:372-397`.
- Session-changing successes require a strictly increasing safe generation; uncertain outcomes retire the slot: `pi-runtime-pool.ts:263-307`.

### Prompt turn correlation and terminal errors

The round6 B2 prompt-queue blockage is repaired:

- Prompt commands carry optional `promptId`: `packages/agent-host/src/types.ts`, `packages/agent-host/src/pi-runtime.ts:10-23`, `146-155`.
- SDK prompt rejections become `prompt_error` only with exact `promptId` and `terminal: true`; other errors remain generic: `packages/agent-host/src/pi-sdk-runtime.ts:142-161`, `packages/agent-host/src/pi-runtime.ts:76-95`.
- Main requires ready turn, client, exact lease, prompt command, terminal flag, and exact `promptId`, plus Task ownership or recognized cancellation: `apps/desktop/electron/main/ipc.ts:1287-1323`.
- Uncorrelated `agent_settled` requires exact ownership plus observed start, or cancelled/aborted state: `ipc.ts:1325-1366`.
- Normal prompts reserve serialization positions synchronously: `ipc.ts:2156-2175`.
- Post-send ambiguous failures retain the queue barrier: `ipc.ts:2235-2261`.

### Privacy stop ordering

No additional blocker was found:

- Deletion installs a tombstone before stopping runtime: `apps/desktop/electron/main/ipc.ts:2779-2800`.
- Stop captures `waitForAcquire()` before cancellation: `ipc.ts:2803-2817`.
- Destructive work waits for acquisition, ends the exact admission, stops parsing, persists only while ownership remains, releases the exact lease, and cancels extraction: `ipc.ts:2820-2866`.
- A same-ID replacement causes `false`, aborting deletion: `ipc.ts:2826-2835`, `2866`.
- Explicit release uses the same exact-admission/exact-lease ordering: `ipc.ts:2963-2997`.

### Logger JSONL and privacy redaction

No logger blocker was found:

- Physical records split on CRLF, CR, or LF: `apps/desktop/electron/main/logger.ts:14-16`.
- Structured values are recursively redacted; dynamic keys containing registered secrets fail closed to a schema-safe placeholder: `logger.ts:28-67`.
- Malformed lines decode complete JSON string tokens with `JSON.parse`, redact decoded values, and fail closed on unsafe tokens: `logger.ts:68-125`.
- Rewrite validates the complete output, then synchronously writes and renames: `logger.ts:126-144`.
- `redactMemoryPromptLogs` and `redactSession` operate on physical lines and rewrite synchronously: `logger.ts:145-173`.
- Append is synchronous before any await point; `log()` contains no `await`: `logger.ts:183-199`.
- Export re-splits physical lines, redacts, and verifies complete output: `logger.ts:201-207`.
- The persistent registry stores hashes, lengths, character hashes, and a physical-newline flag rather than plaintext: `apps/desktop/electron/main/privacy-redactions.ts:114-152`.
- Multiline patterns and fragments are registered, and cross-record detection is explicit: `privacy-redactions.ts:118-131`, `175-181`.
- Markers avoid every registered character and are verified not to recreate a pattern: `privacy-redactions.ts:183-215`.
- Registry and initialization files must be regular, single-link files; missing/corrupt initialized state fails closed: `privacy-redactions.ts:40-97`.

### Round6 old-finding checklist

- Old B1 (release/`new_session` overtaking opening `switch_session`): addressed by the lifecycle lane, cancellation retirement, and exact-lease release. The regression asserts delayed-switch blocking, zero early resets, killed child, preserved private session file, and replacement client identity: `packages/agent-host/test/pi-runtime-pool.test.ts:128-193`.
- Old B2 (deterministic prompt rejection leaving queue/TaskGrant occupied): addressed by correlated terminal errors and exact-turn consumption. Tests use a real installed Pi SDK `AgentSession` for no-model and prepare rejection: `packages/agent-host/test/pi-sdk-runtime.test.ts:37-120`; Main queue/registry continuation is asserted at `apps/desktop/test/ipc.test.ts:6616-6645`.

## Regression quality

**Yes, the relevant regressions generally assert actual commands and state rather than merely rejection.** Examples:

- Pool tests assert reset counts, command ordering, killed state, client identity, current private session file, and exact stale-lease behavior: `packages/agent-host/test/pi-runtime-pool.test.ts:128-193`, `297-331`, `621-651`, `706-732`.
- Prompt tests assert actual prompt command order and subsequent registry state: `apps/desktop/test/ipc.test.ts:6505-6547`, `6616-6645`.
- Task lifecycle tests assert committed/pending/cancelled registry state and out-of-order factory outcomes: `apps/desktop/test/task-lifecycle.test.ts:78-97`, `139-179`, `198-237`.
- Router tests assert the exact canonical action object passed to the executor and actual audit/denial state: `apps/desktop/test/runtime-action-router.test.ts:391-503`.
- Logger tests assert rewritten/exported bytes, record counts, parsed schemas/values, persisted registry secrecy, future append behavior, malformed lines, marker collisions, and all physical-newline separator combinations: `apps/desktop/test/logger.test.ts:26-113`, `177-194`, `264-398`, `397-522`.
- Privacy registry tests assert secret-free persistence, fail-closed reload, unsafe-link rejection, marker rotation, and boundary recreation prevention: `apps/desktop/test/privacy-redactions.test.ts:13-113`.

However, the regression suite does **not** cover B1's late same-generation runtime request after a replacement Task has committed. The existing pending-owner test only denies while the replacement factory is still pending: `apps/desktop/test/ipc.test.ts:6691-6739`. That is materially different from a late request arriving after Task C is active.

## Scope and limitations

- This was a static, read-only architecture review. No source, test, config, dependency, CI, or old evidence file was edited. No stage, commit, push, full suite, or typecheck was performed. No real user data was touched.
- No temporary reproduction was run. B1 is established by the complete cross-file request path and the installed SDK's documented streaming/follow-up behavior; the required regression above would make it executable in CI.
- `FakeHandle`/`ManualHandle` tests prove Main-process protocol and state behavior only. Fork fixture children are not real Pi SDK children.
- Some prompt-error tests instantiate the real installed Pi SDK `AgentSession`, but there is no full production fork/SDK end-to-end test for the B1 interleaving.
- Windows TOCTOU and the disclosed filesystem identity boundaries were not treated as automatic blockers. The blocker is a control-plane Task-origin bypass, not a filesystem race.
- Auxiliary read-only metadata/UI IPC paths were not treated as lease-critical unless they participate in the runtime request, mutation, approval, journal, release, or privacy chains. Connector reads were included because they participate in the SDK runtime request path.
- Hashes below identify the exact reviewed bytes. `ipc.test.ts` and `workflow-broker.test.ts` were inspected in the relevant runtime/approval/privacy regions rather than every unrelated test; all listed production source files were reviewed as complete relevant chains.

## SHA-256 appendix

All repository paths below are relative to `C:/Users/YDJ/Desktop/SparkiiDesktop-Pi`.

### Reviewed production source

| Path | SHA-256 |
|---|---|
| `apps/desktop/electron/main/ipc.ts` | `15ab2b42d3ed56dce164856d90e0458397c60223be502b3c9e2d8d23b379cab2` |
| `apps/desktop/electron/main/workflow.ts` | `e7658e293897a53675990a9694c27ee055efa8f7e443cc48cd27f43c8a0fa4d4` |
| `apps/desktop/electron/main/logger.ts` | `26f2b3ad83584e5e7d5ade06723d7d00bcbf5c047913fcb9310f2f9f6231c71d` |
| `apps/desktop/electron/main/privacy-redactions.ts` | `9b6b388cc75300fe3a369c1d24dfee1f68b8c9b461ce1e4c6c2f4b0d31c31a71` |
| `apps/desktop/electron/main/runtime.ts` | `a1ea5b4e31e6a8527dcabc3f239f6fa81c1294eb57b86b7d39af1588a897f242` |
| `apps/desktop/electron/main/security/task-lifecycle.ts` | `51320a59598465af312e22e3647b3505fb8a48fbd3b476088a54740aa320f7d0` |
| `apps/desktop/electron/main/security/runtime-action-router.ts` | `93d62266c744dec6c343afe69a24b0866802de0948953601f0a93b4bc89dca29` |
| `apps/desktop/electron/main/security/action-normalizer.ts` | `74b15cade2c3524d78ae684f2c0dfc0231b066680176cfe81703333a126e1756` |
| `apps/desktop/electron/main/security/workspace-executor.ts` | `0998c593796af974b3167c3900b0f353cd9e74eeeab805970f9ae9d16180aa0f` |
| `packages/agent-host/src/pi-runtime-pool.ts` | `2b763a29877eee6008754917bf1bb129bdcf575417ffe6826ea077086be29375` |
| `packages/agent-host/src/pi-runtime.ts` | `81e50b6b3fa3ace642ee18516f7d547afd615c228ba12a66719e069a3af2faeb` |
| `packages/agent-host/src/pi-runtime-transport.ts` | `ba3408825a46a8ab54feb0d1f4cce97029a9b1f9592a7a0a4b38d1dae9d27e63` |
| `packages/agent-host/src/pi-sdk-runtime.ts` | `b2bcaf450cfb3fe5c8c6566e975ea981514c3e8fdb5db015d30874cfefefc678` |
| `packages/agent-host/src/runtime-actions.ts` | `9438d127d0a380765b7dc28be11f12485ccfe3de2fbffadfd22910c5f5004220` |
| `packages/agent-host/src/pi-runtime-supervisor.ts` | `50c89c5abc0723e0d5bbe1811ef3f98ae135720558b6a766dd658e577ea224bd` |
| `packages/agent-host/src/runtime-pool.ts` | `8c4a08f0d5ba74001e2cdd49d3fddd827b8d357e73f83a433c77afb0b1591d56` |
| `packages/agent-host/src/tool-registry.ts` | `3d7b88535f7cd15a244e420282b0c611da174bef32774fd8238387f872429de8` |
| `packages/agent-host/src/coding-tools.ts` | `a4adf74f039cdac196f611d3ac44b002e7709f3da0764884ad762cfec20d023c` |
| `packages/agent-host/src/types.ts` | `ccb365e9b5dd43d3db526495e18f0d1cd0c013a75b43f44714f861b7e83ff359` |
| `packages/approval/src/security/task-grant-registry.ts` | `be0d6cbf1eaf799584267e2bc4dafb8e8514ef65b7ad866718bb41af67e8cc5b` |

### Reviewed tests and fixture children

| Path | SHA-256 |
|---|---|
| `apps/desktop/test/logger.test.ts` | `458ad63859547959243b18be82faeecc49f7cc0621b7edd6679f55f9a9c939c0` |
| `apps/desktop/test/privacy-redactions.test.ts` | `671264c57cc37f57bf59c8819639a4119241e463b20cc195d250d666813686fc` |
| `apps/desktop/test/task-lifecycle.test.ts` | `73d35238468736de49534c1d1d41cf9f9915d2f4eecc38603f7eed80fa43b68d` |
| `apps/desktop/test/runtime-action-router.test.ts` | `c5d1c29293f630516bc45b79d7b06ab51e2d8422fea1fd963eaf02e43dd3c4f8` |
| `apps/desktop/test/action-normalizer.test.ts` | `12e9f94980ddce2ebbffc5a1c23fdf4e54c74782fd15da88d867197d6317f3bb` |
| `apps/desktop/test/ipc.test.ts` | `54c88acee4347b5ef7bd11a4ce2c89c626379ecb2017a3d8e054be8b2f0bae31` |
| `apps/desktop/test/workflow-broker.test.ts` | `fb9967dffd1e57312e90ebff8c6309d7a50ce1985ec299c05ba62d499b4853a4` |
| `packages/agent-host/test/pi-runtime-pool.test.ts` | `be73f227c6d8a308d090bb2309f304bd1b61de1891db7d62ffa95d693501d502` |
| `packages/agent-host/test/pi-runtime-supervisor.test.ts` | `96704f8e87a099527b1e75e18855e4cd8bb600d412056d1e8a645e892e3dd934` |
| `packages/agent-host/test/pi-runtime.test.ts` | `ea5c283d43a3acfb07af75a4ea953f220105613a6447281eea7278b66eae963c` |
| `packages/agent-host/test/pi-sdk-runtime.test.ts` | `972f02b67bffe72ce85c53a712cb0e94bf81e43a47c8c0d513f737c09b9b12cc` |
| `packages/agent-host/test/pi-sdk-runtime-queue.test.ts` | `b67d12230dab96e0ecd81888a3c5cc7ea0454ec70615232bb74625de0d41393a` |
| `packages/agent-host/test/fixtures/pi-runtime-saddle-child.mjs` | `f842a00e8696f247858bd43430bede78798aca086dd0e9686315c3e289bbe789` |
| `packages/agent-host/test/fixtures/pi-runtime-skills-child.mjs` | `99de3070a3166587b1609420482f6728f4ab17777b27958c6f1b64884919b10e` |

### Inspected installed Pi SDK source

`PI_SDK = C:/Users/YDJ/Desktop/SparkiiDesktop-Pi/node_modules/.pnpm/@earendil-works+pi-coding-agent@1.5.0_@aws-sdk+credential-provider-node@3.972.84_@smithy+sign_nqz6y242fd6t6ckmkqqcf454oa/node_modules/@earendil-works/pi-coding-agent`

| Path under `PI_SDK` | SHA-256 |
|---|---|
| `dist/core/tools/write.js` | `0e9daec15a5001cafe651db391aed63a463c346d29b60e6dc91ef09477fd22f5` |
| `dist/core/tools/edit.js` | `7a220a800ed2997338f08b22e780a3d114243f106c66d66eb33d50c8d7930297` |
| `dist/core/agent-session-runtime.js` | `0e0b6bcd83b092e108ed52bed2c8f0bc28e9d606f4a3ddd8877636163260a019` |
| `dist/core/agent-session.js` | `1941d9608c98a3638825a8d10b5443ff7c06f96b3ae370bb37269f3a574ede65` |
