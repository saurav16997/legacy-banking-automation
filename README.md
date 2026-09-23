# Deterministic computer-use automation for a legacy portal

This repository demonstrates a safe path from one goal-driven browser discovery run to a versioned,
deterministically replayed capability. The example prepares a savings subaccount in a synthetic
credit-union employee portal and stops at a verified review screen. It never opens the account.

The submission includes the local portal, a constrained Playwright surface, one OpenAI Agents SDK
discovery agent, offline capability compilation, zero-model replay, resumable human verification,
tests, and curated sanitized evidence.

## Architecture at a glance

| Layer            | Responsibility                                                                                          | Model use |
| ---------------- | ------------------------------------------------------------------------------------------------------- | --------- |
| Target portal    | Local Express/EJS legacy workflow with synthetic fixtures                                               | None      |
| `SurfaceAdapter` | Semantic observation and bounded `click`, `fill`, `selectOption`, and same-origin navigation            | None      |
| Policy           | Ownership, risk, origin, and irreversible-action enforcement                                            | None      |
| Discovery        | Goal-directed navigation through six closed tools and input references                                  | One agent |
| Compiler         | Verifies discovery evidence and emits canonical, versioned JSON                                         | None      |
| Replay           | Validates inputs, resolves exact semantic targets, executes ordered artifact steps, and checks outcomes | None      |
| Handoff          | Pauses on HUMAN ownership and resumes the same live session from a bound checkpoint                     | None      |
| Evidence         | Writes sanitized event records, hashes, terminal summaries, and masked screenshots                      | None      |

Playwright is private to `SurfaceAdapter`; callers never receive a browser, page, locator, selector,
or arbitrary script primitive. Discovery and replay use the same adapter and deterministic policy
boundary.

## Safety invariant

Success is `READY_FOR_REVIEW` with `accountCreated: false`. The final **Open Account** control is
observed as `NONE`-owned and `IRREVERSIBLE`, so policy blocks it. Replay also fails closed for
ambiguous or missing targets, external navigation, undeclared inputs, unsafe ownership/risk, expired
handoffs, and incompatible artifacts. It never falls back to discovery.

Invocation values are resolved only at execution time. Artifacts and evidence contain input
references, not values. Runtime evidence is ignored by Git; only the audited examples under
`evidence/examples/` are committed.

## Requirements and setup

- Node.js 20 or newer
- npm
- Playwright Chromium
- An OpenAI API key only if running a new discovery

```powershell
npm ci
npx playwright install chromium
Copy-Item .env.example .env
```

Use `.env.example` as the variable-name template. Set the local target URL and synthetic portal
credential for replay. A new discovery additionally requires `OPENAI_API_KEY` and `OPENAI_MODEL`.
Keep `.env` local; it is ignored and is never part of evidence or submission packaging.

## Shortest zero-model demo

Start the normal synthetic portal in one terminal:

```powershell
npm run target:start
```

In a second terminal, run the approved local draft artifact:

```powershell
npm run replay:prepare:demo
```

For a visible browser:

```powershell
npm run replay:prepare:demo:headed
```

These task-specific local demonstration commands contain the explicit DRAFT override. Production and
default `ReplayEngine` behavior still rejects DRAFT artifacts. A successful run executes 12 ordered
artifact actions, reaches `ready-for-review`, reports `READY_FOR_REVIEW`, and closes without
creating an account or targeting **Open Account**.

## Human-handoff demo

Start a fresh portal process with the seeded interruption:

```powershell
$env:TARGET_SCENARIO = "identity_verification_on_review"
npm run target:start
```

Then run headed replay in another terminal:

```powershell
npm run replay:prepare:handoff
```

Replay pauses after the 12th artifact action, keeps the browser open, and returns control to an
employee. Complete verification only in that browser, then acknowledge with an empty Enter in the
terminal. Resume uses the same run, replay engine, surface, and browser session; it performs a fresh
observation and does not repeat completed steps. The raw resume token and human verification value
never enter evidence or browser automation.

## Discovery and compilation

Discovery is the only probabilistic phase and the only phase that calls an OpenAI model:

```powershell
npm run discover:prepare:headed
```

The agent receives a sanitized goal, input definitions, and six closed tools. It cannot access raw
Playwright, selectors, arbitrary code, or resolved input values. Deterministic completion validation
must confirm the review page and blocked final action before the run is successful.

Compile verified discovery evidence offline:

```powershell
npm run compile:prepare -- <discovery-run-id>
```

The compiler verifies the source manifest and hashes, projects only executed safe actions, validates
the canonical schema, and writes byte-deterministic JSON. Existing capability versions cannot be
overwritten with different bytes. The checked-in artifact is intentionally `DRAFT`; local replay
therefore requires the explicit `--allow-draft` demonstration override.

## Deterministic outcomes and failure handling

Replay distinguishes successful review, typed business outcomes, human intervention, and terminal
failures. `MEMBER_NOT_FOUND` is a successful terminal business classification rather than an
automation crash; its single controlled live example is included in the curated evidence.

Only artifact-declared idempotent fills and selections may retry, and only for declared stale-target
or transient-timeout recovery within per-step and global deadlines. Clicks, policy rejections,
ambiguous targets, HUMAN/NONE ownership, and irreversible actions never retry.

## Curated evidence

See [`evidence/README.md`](evidence/README.md) and
[`evidence/examples/manifest.json`](evidence/examples/manifest.json). The package contains:

- the byte-identical capability artifact;
- sanitized successful discovery evidence and a masked review screenshot;
- a successful zero-model replay;
- a same-session human pause/resume replay with a masked pause screenshot; and
- the controlled `MEMBER_NOT_FOUND` replay.

The authoritative source runs are:

- discovery: `discovery-20260920160150-78f495af`
- normal replay: `replay-20260921220210-b1f338da`
- human handoff: `replay-20260922011845-72a62c36`
- business outcome: `replay-20260922151121-e3c32385`

The manifest records every curated file's byte length, SHA-256 digest, and source linkage. Tests
verify those digests and ensure the curated artifact remains identical to
`artifacts/prepare_savings_subaccount/1.0.0/capability.json`.

## Validation

```powershell
npm run format
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
git diff --check
```

Tests cover the portal, semantic adapter, fail-closed policy, discovery boundaries, evidence
redaction, schema/compiler determinism, replay outcomes and timeouts, irreversible-action blocking,
and resumable handoff lifecycle.

## Repository map

- `target_app/` — synthetic Express/EJS portal and fixtures
- `src/browser/` — controlled Playwright surface adapter
- `src/discovery/` — single-agent discovery boundary
- `src/compiler/` and `schemas/` — evidence verification and capability contract
- `src/replay/` — deterministic replay, evidence, outcomes, and session state
- `src/handoff/` — in-memory resume-token binding and validation
- `artifacts/` — canonical versioned capability
- `evidence/examples/` — curated, sanitized submission evidence
- `docs/` — detailed design and operating notes
- `tests/` — unit, integration, and end-to-end coverage

For design tradeoffs and extension boundaries, see [`REPORT.md`](REPORT.md).
