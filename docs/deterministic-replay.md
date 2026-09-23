# Deterministic replay

Phase 5 replays `prepare_savings_subaccount` without an LLM, agent runner, network model request,
raw Playwright access, selectors, or arbitrary browser code. `ReplayEngine` consumes the versioned
artifact, invocation inputs, and the bounded `SurfaceAdapter` contract used by discovery.

## Authorization and inputs

Replay rejects a `DRAFT` artifact by default. The current compiler intentionally emits drafts only,
so local demonstrations must supply the explicit `allowDraftArtifact` option or the CLI
`--allow-draft` flag. This override does not modify or approve the artifact.

Every declared input must be a non-empty string, pattern-constrained fields are checked before the
browser opens, and undeclared inputs are rejected. Select inputs may match one enabled option by
exact value or exact display label. Invocation values are passed to the surface only at execution
time and are never written to replay evidence.

## Execution

For each artifact step, replay verifies the expected page state, tries the ordered semantic target
strategies, and requires exactly one match. It re-checks ownership and risk against both the live
observation and artifact policy, then executes through an ephemeral observation and element
reference. `Open Account`, `NONE`/`HUMAN` ownership, irreversible risk, external navigation, and
ambiguous targets fail closed.

Each attempt uses one effective deadline: the earlier of `step.timeoutMs` and the remaining global
runtime. The bound covers the attempt's fresh observation, local target resolution, browser command,
and post-action observation/check. Remaining milliseconds are passed through the surface-neutral
operation options; `PlaywrightSurface` applies them to the actual Playwright operation and waits for
that operation to settle before returning `TIMED_OUT`.

Only artifact-declared, idempotent input operations (`FILL` and `SELECT_OPTION`) may retry. A stale
observation or `TRANSIENT_TIMEOUT` is retried only when its named recovery, attempt bound, policy
classification, and remaining global runtime all allow it. Clicks and HUMAN-, NONE-, or
IRREVERSIBLE-owned operations never retry. `TRANSIENT_TIMEOUT`, `GLOBAL_TIMEOUT`, policy rejection,
and target-not-found remain separate terminal codes. Replay never falls back to discovery or makes
an agent/model call.

After every action, replay checks the resulting page state before continuing. A missing-member page
returns the terminal `MEMBER_NOT_FOUND` business outcome. A human-owned identity verification page
returns `intervention_required` while the engine leaves the supplied surface open. Phase 6 binds a
short-lived in-memory resume token to the run, artifact hash, replay and surface sessions, completed
step checkpoint, and expected page-state transition. Human wait time is excluded from the remaining
automation budget. See [resumable-human-handoff.md](resumable-human-handoff.md).

## Evidence

`FileReplayEvidenceSink` writes `context.json`, `events.jsonl`, optional masked screenshots, and
`summary.json` beneath `evidence/replay/<run-id>/`. A paused handoff also writes one sanitized
`handoff.json`; `summary.json` remains absent until the replay reaches one terminal outcome. The
context links the run to the artifact version and canonical SHA-256 digest. Events contain input
references, page states, status codes, and sanitized surface fingerprints, but no input values,
resume tokens, verification codes, or visible page text.

## Local CLI

Start the target portal, set `TARGET_BASE_URL` and `PORTAL_PASSWORD`, then run:

```powershell
npm run replay:prepare:demo
```

For a visible browser:

```powershell
npm run replay:prepare:demo:headed
```

These task-specific local demonstration commands contain the explicit DRAFT override. Production and
default `ReplayEngine` behavior still rejects DRAFT artifacts.

The default replay member is the second synthetic fixture, `M-20017`, so the successful replay does
not reuse discovery's member. Optional overrides are `REPLAY_OPERATOR_USERNAME`, `REPLAY_MEMBER_ID`,
`REPLAY_PRODUCT_NAME`, `REPLAY_ACCOUNT_NICKNAME`, `REPLAY_INITIAL_DEPOSIT`, and
`REPLAY_FUNDING_ACCOUNT`. The CLI prints only a sanitized terminal summary and evidence path.
