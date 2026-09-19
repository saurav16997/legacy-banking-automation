# interface.ai Computer-Use Automation System

Initial Node.js 20+ and strict TypeScript scaffold for a computer-use system that separates
probabilistic discovery from deterministic execution.

## Boundary

`@openai/agents` is reserved for one discovery agent operating through bounded tools. Browser access
is hidden behind `SurfaceAdapter`; `PlaywrightSurface` is the first headed-Chromium adapter. Policy,
recording, compilation, replay, outcomes, evidence, and handoff are deterministic application
components. Replay will make zero model calls.

The primary capability is `prepare_savings_subaccount`. It succeeds when automation reaches and
verifies the final review screen. The irreversible `Open Account` action is policy-blocked and is
not part of the capability. Human handoff is a separate scenario driven by a seeded session-expiry
or identity-verification interruption.

This repository currently contains contracts and placeholders only. It does not yet implement
discovery, compilation, replay, or human handoff.

## Setup

```shell
npm install
npx playwright install chromium
```

No API key is needed for scaffold checks. Copy `.env.example` to `.env` only in a later approved
phase.

## Checks

```shell
npm run format
npm run lint
npm run typecheck
npm test
```
