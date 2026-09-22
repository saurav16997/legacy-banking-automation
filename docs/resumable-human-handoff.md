# Resumable human handoff

Phase 6 adds one in-process, same-surface human pause to deterministic replay. It does not add a
human-action API, browser selectors, direct Playwright access, discovery fallback, or a model call.
The supported interruption is the synthetic identity-verification gate reached after the final
artifact action.

## Session state machine

`ReplayEngine` is one replay session with these states:

```text
CREATED -> RUNNING -> COMPLETED -> CLOSED
                   -> FAILED -> CLOSED
                   -> PAUSED_FOR_HUMAN -> RUNNING -> COMPLETED -> CLOSED
                                          |          -> FAILED -> CLOSED
                                          -> FAILED -> CLOSED
```

Only `replay()` starts a created session. A HUMAN gate changes ownership to the employee and returns
`intervention_required`; it is neither success nor failure. `resume()` is accepted only for the
active handoff while the session is `PAUSED_FOR_HUMAN`. `close()` is idempotent. Closing a paused
session first records safe abandonment and a terminal summary.

## Trust boundary and handoff identity

`HandoffCoordinator` creates a cryptographically random 256-bit, base64url resume token. The caller
receives the raw token once in the typed in-memory result. Only its SHA-256 digest is retained, and
validation uses `timingSafeEqual`. The token is never written to evidence, output, a URL, or a
browser surface.

One token is bound to the replay run, artifact ID/version/SHA-256, replay-session identity, opaque
surface-session identity, ordered completed-step checkpoint, expected HUMAN page state, and
creation/expiration timestamps. The default TTL is ten minutes; clock and TTL are injectable for
tests. Unknown tokens, another run/session, artifact mismatch, checkpoint mismatch, expiration, and
consumption fail closed without browser interaction.

The implementation is deliberately in-process. Resume requires the original Node.js process,
`ReplayEngine`, `SurfaceAdapter`, and live browser context. Process restart and cross-process
recovery are out of scope.

## Pause and resume

When the final `Continue to review` action reaches identity verification, that action is recorded as
executed and included in the completed-step checkpoint. It is never repeated. The engine records
HUMAN ownership, keeps the adapter open, optionally captures a fully masked screenshot, and returns
sanitized instructions without element references, selectors, HTML, invocation values, or the
verification code.

An explicit terminal acknowledgement triggers resume validation. Resume always makes a fresh
semantic observation, invalidating pre-handoff element references:

- If the HUMAN gate remains, the result is `handoff_not_completed`; no automation runs and the token
  remains valid until its TTL.
- If the surface reaches `ready-for-review`, the token is consumed, replay continues after the
  checkpoint, and the ordinary deterministic checkpoint/postcondition validation returns
  `READY_FOR_REVIEW`.
- Any other page state, surface-session change, or unsafe condition fails closed. Replay does not
  search, restart, or repeat completed steps.
- Reusing a consumed token or calling resume after completion is rejected without observing the
  browser.

The verification code is entered only by the employee in headed Chromium. CLI arguments, environment
variables, stdin, replay inputs, and `SurfaceAdapter.execute()` never carry it.

## Timeouts and abandonment

Automation's `maxTotalRuntimeMs` budget is snapshotted at pause and reconstructed at resume, so
human waiting time does not consume an automation step timeout. Fresh resume observations still
consume automation time. The separate handoff TTL bounds the human pause.

The handoff CLI accepts only Enter on an empty line as acknowledgement. Non-empty stdin is ignored.
EOF, Ctrl+C, TTL expiration, or caller closure records `HANDOFF_ABANDONED` or `HANDOFF_EXPIRED`,
writes one terminal failure summary, and closes the same surface.

## Evidence

The original run ID and evidence directory span initial automation, pause, resume, and the terminal
outcome. `handoff.json` is an interim sanitized record; `summary.json` is written once, only when
the session terminates. `events.jsonl` may contain:

- `HANDOFF_REQUIRED`
- `RESUME_REQUESTED`
- `HANDOFF_NOT_COMPLETED`
- `HANDOFF_COMPLETED`
- `HANDOFF_EXPIRED`
- `HANDOFF_ABANDONED`
- `REPLAY_RESUMED`
- the ordinary terminal replay event

Evidence includes the artifact binding, checkpoint digest, completed step IDs, HUMAN ownership,
surface fingerprint, and resume outcome. It excludes raw tokens, verification codes, credentials,
resolved invocation values, API keys, HTML/DOM, Playwright handles, selectors, and model/provider
content. Handoff and failure screenshots use the existing form-control and invocation-value masks.

## Manual validation (run later)

In one PowerShell terminal, start the seeded portal:

```powershell
$env:TARGET_SCENARIO="identity_verification_on_review"
npm run target:start
```

In another terminal, provide the existing local target URL and synthetic portal credential through
the normal runtime environment, then run:

```powershell
npm run replay:prepare:handoff
```

The task-specific command builds and starts headed deterministic replay with the explicit local
DRAFT override. Complete verification in Chromium, press Enter on an empty terminal line, and expect
`success` / `READY_FOR_REVIEW`. Do not select **Open Account**. The command never accepts or prints
the verification code.
