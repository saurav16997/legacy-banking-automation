# Probabilistic Discovery Runs

## Boundary

Phase 3 uses one `@openai/agents` agent only to choose the next action from the latest sanitized
`SurfaceObservation`. It can choose an element reference or same-origin path, but it never receives
Playwright objects, selectors, cookies, raw credentials, or authority to change policy.

The following responsibilities remain deterministic local code:

- resolving named inputs immediately before an adapter call;
- validating tool schemas and observation/reference freshness;
- evaluating surface ownership and action risk;
- enforcing origin, action, turn, repetition, and elapsed-time limits;
- recording sanitized trajectory events and evidence;
- stopping on `BLOCKED` or `HANDOFF_REQUIRED`; and
- deciding whether the final review state actually satisfies the capability.

The model's structured final status is advisory. `SUCCESS` is returned only when
`complete_discovery` has passed the local completion validator.

## Input references

The model sees input names and semantic descriptions, not vault contents. Fill and selection tools
accept `inputRef`, such as `member_id`, rather than a raw value. The local `InputVault` resolves the
reference immediately before calling `SurfaceAdapter`. Unknown references are blocked.

Trajectory events retain `inputRef`. Every resolved example value is replaced in serialized tool
results and JSON evidence with either `[INPUT:name]` or `[REDACTED:name]`; passwords and other
sensitive values never appear in prompts, tool results, errors, summaries, manifests, or trajectory
JSON. Browser screenshots mask all form controls and visible text containing configured evidence
redaction literals.

This input-reference trajectory is the Phase 4 compiler's source material. Discovery itself does not
compile or approve an artifact.

## Agent tools

The SDK agent receives six strict tools backed by local Zod parsers:

- `observe_surface()`
- `click_element({ observationId, elementRef })`
- `fill_element_from_input({ observationId, elementRef, inputRef })`
- `select_option_from_input({ observationId, elementRef, inputRef })`
- `navigate_same_origin({ path })`
- `complete_discovery()`

The request uses closed JSON Schemas with every property required. Wire schemas omit constraints
that the strict subset cannot represent: `minLength` on input references and regex lookaround on the
same-origin path. The original Zod schemas still parse every tool call locally and preserve those
stronger checks. A local preflight checks the SDK-converted output and tool schemas before any model
request and reports only the safe schema name and JSON path on failure.

There is no raw-value fill tool, external URL tool, selector, XPath, JavaScript, filesystem, shell,
upload, download, or unrestricted browser tool. Each browser action still passes through the Phase 2
adapter and policy.

## Completion checks

For `prepare_savings_subaccount`, deterministic validation requires:

- page state `ready-for-review` and heading `Review Savings Subaccount`;
- member, product, nickname, deposit, and funding account matching vault inputs;
- visible confirmation that no account has been created;
- a visible `Open Account` control classified as `NONE` + `IRREVERSIBLE`;
- no executed Open Account event; and
- no executed HUMAN- or NONE-owned event.

A premature `complete_discovery` returns structured failed checks and lets discovery continue within
the limits. It cannot produce success by assertion alone.

## Limits and terminal states

Runs bound model turns, browser actions, repeated semantic actions, and elapsed duration. The
terminal states are `SUCCESS`, `HANDOFF_REQUIRED`, `BLOCKED`, `MAX_STEPS`, `TIMED_OUT`, and
`FAILED`. `HANDOFF_REQUIRED` and `BLOCKED` stop the run immediately; there is no bypass attempt.
Browser resources close on every terminal path. Full human takeover and resume orchestration remain
deferred.

## Evidence

Each run writes to `evidence/discovery/<run-id>/`, which is Git-ignored:

- `trajectory.json`
- `manifest.json`
- `summary.json`
- ordered screenshots after page-state transitions
- a final screenshot

JSON evidence is sanitized before writing. Filenames contain only an ordered number and sanitized
state label. The manifest records media type, byte count, and SHA-256 digest.

Failed runs include a sanitized `failure` record in both `trajectory.json` and `summary.json`. It
records the failure category and stage, the exception class, and—when provided by the API—only the
numeric HTTP status, token-safe API type/code, and a conservatively allowlisted request-property
`apiParam`. Provider messages are not persisted. Categories are `AUTHENTICATION_FAILED`,
`MODEL_UNAVAILABLE`, `RATE_LIMITED`, `INVALID_REQUEST_SCHEMA`, `SDK_ERROR`, `INVALID_AGENT_OUTPUT`,
and `INTERNAL_ERROR`.

## First live run

Start the portal separately; discovery never starts it automatically. In another PowerShell window,
set the required runtime variables and invoke the CLI:

```powershell
$env:OPENAI_API_KEY="..."
$env:OPENAI_MODEL="..."
$env:TARGET_BASE_URL="http://localhost:3000"
$env:PORTAL_PASSWORD="..."
npm run discover:prepare:headed
```

Use `npm run discover:prepare` for headless Chromium. These hardcoded task scripts are reliable on
Windows because they do not depend on forwarding a task argument through npm. The generic
`npm run discover` script remains available for direct CLI use.

`OPENAI_MODEL` has no hardcoded default. Automated tests inject a scripted runner and make no OpenAI
requests. A ChatGPT or Codex login is not an OpenAI API credential; the live CLI requires a separate
OpenAI API key supplied through `OPENAI_API_KEY`.

SDK tracing is disabled for discovery so the local sanitized evidence is the authoritative run
record.
