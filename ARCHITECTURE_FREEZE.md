# Interface.ai Computer-Use System — Architecture Freeze

Status: pre-implementation design baseline  
Runtime: Node.js 20+ with TypeScript strict mode  
Primary capability: `prepare_savings_subaccount`  
Target: local legacy-style credit-union member-servicing portal

## 1. Decision on Playwright

Use Playwright, but only as the first implementation of the `SurfaceAdapter` contract.

Playwright is responsible for:

- maintaining the live headed Chromium browser and browser context;
- taking screenshots;
- enumerating frames and interactive controls;
- executing approved clicks, fills, selections, waits, and navigations;
- resolving recorded locator candidates during replay; and
- exposing the same browser session to a human during a handoff.

Playwright is not responsible for:

- deciding the next action during discovery;
- defining the artifact format;
- deciding whether an action is safe;
- interpreting business outcomes;
- deciding replay behavior dynamically; or
- representing every future surface type.

The LLM never receives unrestricted Playwright or arbitrary code execution. It receives a screenshot
plus a normalized inventory of interactive controls and calls narrow tools such as
`observe_surface`, `click`, `fill`, `select_option`, `extract_output`, `complete_discovery`, and
`request_human_intervention`.

This preserves a future seam for `DesktopSurface` or `AccessibilitySurface` implementations without
changing the capability contract or replay-result contract.

## 2. Architectural invariants

1. The model may choose actions only during discovery.
2. Every UI action passes through the same `PolicyEngine` and `ActionExecutor`.
3. The artifact is compiled from normalized action events, not from the raw model transcript.
4. Replay makes zero model calls.
5. A locator must resolve to exactly one acceptable target; replay never silently guesses.
6. Every replay step has an observable postcondition.
7. Known business outcomes are returned as results, not thrown as system failures.
8. Retries are bounded and allowed only for idempotent operations.
9. Risky or irreversible operations are policy-blocked for the primary capability.
10. Human and automation control are mutually exclusive and use the same live session.
11. Inputs are parameter references in the artifact, never copied discovery values.
12. Logs and evidence pass through redaction before persistence.

## 3. Primary demo flow

Discovery goal:

> Prepare a Holiday Savings sub-account for member 12345 with an opening deposit of 25.00, stopping
> after the final review screen is verified.

Declared inputs:

| Name              | Type           | Sensitive | Example           |
| ----------------- | -------------- | --------- | ----------------- |
| `member_id`       | string         | yes       | `12345`           |
| `product_code`    | enum           | no        | `HOLIDAY_SAVINGS` |
| `opening_deposit` | decimal string | yes       | `25.00`           |

Declared outputs:

| Name                 | Type | Sensitive | Meaning                        |
| -------------------- | ---- | --------- | ------------------------------ |
| `preparation_status` | enum | no        | Expected value: `REVIEW_READY` |

Nominal sequence:

1. Search for the member.
2. Open the single matching member record.
3. Navigate to the accounts section.
4. Start the sub-account workflow.
5. Select the product and enter the deposit.
6. Reach and verify the final review-page summary.
7. Verify that the irreversible `Open Account` control is visible but policy-blocked.
8. Return success with `preparation_status = REVIEW_READY` without opening an account.

Human handoff is tested separately. A seeded session-expiry or identity-verification interruption
pauses automation and transfers the same browser session to a human; it is not a path for bypassing
the blocked `Open Account` action.

## 4. System boundaries

| Component            | Owns                                                        | Must not own                          |
| -------------------- | ----------------------------------------------------------- | ------------------------------------- |
| `DiscoveryAgent`     | Observe → decide → request-action loop                      | Replay, policy, direct browser access |
| `SurfaceAdapter`     | Surface observations and primitive UI operations            | Business semantics                    |
| `PolicyEngine`       | Origin, route, operation, risk, and runtime limits          | LLM reasoning                         |
| `ActionExecutor`     | Policy-gated execution and post-action observation          | Choosing the next step                |
| `ActionRecorder`     | Normalized actions, target evidence, checkpoints            | Raw chain-of-thought persistence      |
| `ArtifactCompiler`   | Parameter substitution and schema-valid artifact generation | Re-reasoning about the UI             |
| `ReplayEngine`       | Model-free step execution and structured results            | Open-ended recovery                   |
| `OutcomeDetector`    | Business, recoverable, hard-failure classification          | UI execution                          |
| `HandoffCoordinator` | Pause, ownership transfer, resume, audit events             | Agent-to-agent delegation             |
| `EvidenceStore`      | Redacted logs, screenshots, snapshots, run summary          | Unredacted secrets or real PII        |

## 5. Surface observation contract

`observe()` returns:

- `surface_id` and stable browser-context ID;
- current URL, title, and frame tree;
- screenshot reference;
- normalized interactive elements with ephemeral IDs;
- role, accessible name, label, nearby anchor text, visibility, bounds, and frame path;
- known dialogs or interstitials; and
- a sanitized state fingerprint.

An ephemeral element ID is valid only for the current observation. The recorder enriches each
successful action with ordered locator candidates for future replay. A raw screen coordinate is
permitted only as an explicitly fragile, low-confidence final fallback.

## 6. Discovery-to-artifact pipeline

1. `DiscoveryRequest` supplies the natural-language goal, example inputs, desired outputs, target
   entry point, and policy profile.
2. `@openai/agents` runs one discovery agent with narrow UI tools.
3. The `ActionExecutor` validates and performs every requested action.
4. The `ActionRecorder` stores normalized action events and evidence references.
5. `complete_discovery` is accepted only when the host verifies the proposed checkpoint.
6. The deterministic compiler replaces observed example values with typed input references.
7. The compiler emits an artifact with `approval.status = draft`.
8. Replay rejects draft artifacts unless an explicit local demo override is supplied.

The compiler may reject an unsafe or ambiguous recording. It must not invent missing targets,
conditions, or types.

## 7. Replay algorithm

For each artifact step:

1. Validate the artifact version and approval state.
2. Validate invocation inputs.
3. Verify surface identity and the origin/route allowlist.
4. Evaluate known business-outcome detectors.
5. Evaluate step preconditions.
6. Resolve the ordered target candidates.
7. Require exactly one acceptable match.
8. Re-check action risk and policy.
9. Execute an allowed action, block a prohibited action, or enter a human gate for a separately
   seeded interruption.
10. Evaluate postconditions.
11. Apply only named, bounded recovery policies.
12. Write redacted evidence and continue.
13. Verify the final checkpoint and construct a typed result.

Replay result variants:

- `SuccessResult(status="success", outputs=...)`
- `BusinessOutcomeResult(status="business_outcome", code=...)`
- `InterventionRequiredResult(status="intervention_required", intervention_id=...)`
- `FailureResult(status="failure", code=..., step_id=..., expected=..., observed=..., evidence_refs=...)`

## 8. Control-transfer model

Run ownership is one of `AUTOMATION`, `HUMAN`, or `NONE`.

Valid transitions:

```text
AUTOMATION → HUMAN → AUTOMATION
AUTOMATION → NONE
HUMAN → NONE
```

The executor refuses automated actions while ownership is `HUMAN`. The human operates the same
headed browser and browser context. Browser-event instrumentation records click targets and field
names during human control, but never records sensitive field values. Resume requires both an
explicit operator signal and a successful resume checkpoint.

## 9. Error taxonomy

| Class              | Examples                                                                   | Required response                                               |
| ------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Business outcome   | `MEMBER_NOT_FOUND`, `PRODUCT_NOT_ELIGIBLE`                                 | Return a terminal, non-error result to the caller               |
| Recoverable        | Known modal, transient timeout, stale target                               | Apply one named bounded recovery, then re-check                 |
| Human intervention | Seeded session expiry or identity verification                             | Pause and transfer the same session                             |
| Policy block       | Irreversible `Open Account` action                                         | Stop before execution; do not transfer control to bypass policy |
| Hard failure       | Ambiguous target, permission denial, policy violation, checkpoint mismatch | Stop with step, expectation, observation, and evidence          |

## 10. Acceptance scenarios

### AT-01 — Genuine discovery produces a reviewable draft

**Given** the seeded eligible member `12345`, the live local portal, and the declared
goal/contract  
**When** the `@openai/agents` discovery agent completes the UI flow  
**Then** it must have interacted with the real browser, passed every action through the policy-gated
executor, verified a final checkpoint, and produced:

- a schema-valid draft capability artifact;
- parameter references rather than `12345` or `25.00` embedded in recorded steps;
- a redacted discovery JSONL log;
- screenshots or state snapshots referenced from the log; and
- provenance linking the artifact to the discovery run and event-log digest.

The test fails if a hand-authored artifact is substituted for the discovery output or if success
depends only on the model's final text.

### AT-02 — Deterministic replay succeeds with different inputs

**Given** an approved artifact and a reset application state  
**When** replay is invoked for a different eligible seeded member and opening deposit  
**Then** the replay engine must:

- make zero LLM or `@openai/agents` calls;
- execute the recorded steps through the same `ActionExecutor`;
- verify every required postcondition and the final checkpoint;
- return `SuccessResult` with `preparation_status = REVIEW_READY`;
- leave the irreversible `Open Account` action unexecuted and policy-blocked; and
- persist a redacted replay log linked to the artifact version.

### AT-03 — Missing member is a business outcome

**Given** an approved artifact and member ID `99999`, which is absent from the seed data  
**When** replay performs the member search  
**Then** it must return:

```json
{
  "status": "business_outcome",
  "code": "MEMBER_NOT_FOUND"
}
```

It must not throw an unhandled exception, retry the search indefinitely, request an LLM fallback, or
classify the outcome as infrastructure failure.

### AT-04 — Known transient condition recovers once

**Given** a seeded scenario that displays the known interstitial or delays the accounts page on its
first load  
**When** replay reaches the affected step  
**Then** the named recovery policy must dismiss or wait for the condition, retry only the idempotent
operation, and continue successfully.

The evidence must record the trigger, recovery action, retry count, and eventual postcondition. A
second occurrence beyond the configured bound becomes a hard failure.

### AT-05 — Human takes over the same live session

**Given** replay encounters a seeded session-expiry or identity-verification interruption  
**When** policy requires human intervention  
**Then** the run must pause, preserve the browser-context ID, change ownership from `AUTOMATION` to
`HUMAN`, and expose the current browser to the operator.

After the human restores the session or completes identity verification:

- the human interaction is recorded without sensitive values;
- ownership returns to `AUTOMATION` only after an explicit resume signal;
- the browser-context ID remains unchanged;
- replay returns to its deterministic step boundary; and
- the capability still stops successfully at the verified review screen without clicking
  `Open Account`.

Opening a fresh browser or merely asking for textual approval fails this test.

### AT-06 — Ambiguous target stops with debuggable evidence

**Given** a seeded UI variant containing two equally valid `Continue` controls and no stronger
approved locator  
**When** deterministic replay resolves that step  
**Then** it must stop without clicking either target and return `FailureResult` containing:

- code `TARGET_AMBIGUOUS`;
- the artifact version and failing step ID;
- the attempted locator strategies;
- the expected count and observed count;
- current URL and sanitized surface fingerprint; and
- screenshot or snapshot evidence references.

Replay must not ask the model to choose, silently use coordinates, or continue past the failed
postcondition.

## 11. Pre-coding definition of done

Architecture is ready for scaffolding when:

- the JSON Schema validates;
- one example artifact can validate against it;
- the six scenarios can be expressed as automated or hybrid tests;
- the target app's seed records map cleanly to those scenarios;
- the exact control-transfer state transitions are accepted; and
- all deliberate cuts are documented.

## 12. Deliberate cuts

- No MCP in the first version.
- No multi-agent discovery.
- No queue, distributed worker, or cloud deployment.
- No autonomous LLM fallback during replay.
- No native desktop implementation; only the interface and design seam.
- No cross-tenant runtime; only app-family/variant fields and one seeded variant test.
- No artifact self-healing or automatic promotion from draft to approved.
- No real banking system, credentials, or PII.
- No account creation: `prepare_savings_subaccount` ends at the final review screen and policy
  blocks `Open Account`.
