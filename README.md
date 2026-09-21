# interface.ai Computer-Use Automation System

Node.js 20+ and strict TypeScript project for a computer-use system that separates probabilistic
discovery from deterministic execution. Phase 1 implements the synthetic, server-rendered target
portal. Phase 2 adds its narrow, policy-controlled browser surface. Phase 3 adds the single-agent
probabilistic discovery run and deterministic local validation. Phase 4 compiles one verified,
sanitized successful trajectory into a draft, versioned capability artifact without model or network
access.

## Boundary

`@openai/agents` is reserved for one discovery agent operating through bounded tools. Browser access
is hidden behind `SurfaceAdapter`; `PlaywrightSurface` is the first headed-Chromium adapter. Policy,
recording, compilation, replay, outcomes, evidence, and handoff are deterministic application
components. Replay will make zero model calls.

The primary capability is `prepare_savings_subaccount`. It succeeds when automation reaches and
verifies the final review screen. The irreversible `Open Account` action is policy-blocked and is
not part of the capability. Human handoff is a separate scenario driven by a seeded session-expiry
or identity-verification interruption.

Phase 3 uses `@openai/agents` only for discovery decisions. Phase 4 artifact compilation is entirely
deterministic. Deterministic replay and final human-handoff orchestration remain unimplemented. The
portal's identity-verification page is a deterministic target scenario used to test the
`HANDOFF_REQUIRED` boundary.

## Phase 2 surface adapter

`PlaywrightSurface` implements bounded lifecycle, observation, execution, and evidence screenshot
operations. Agent commands are limited to element-reference-based click, fill, and selection plus
same-origin navigation; the screenshot hook is deterministic host-only evidence support. Raw browser
objects, selectors, XPath, and JavaScript evaluation are not public APIs.

Every observation creates a fresh ID and ephemeral element references. Policy validates ownership,
risk, trusted-classification configuration, and navigation origin before interaction. Page metadata
is ignored unless explicitly trusted; missing or invalid classification fails closed. Details are
documented in [docs/surface-adapter.md](docs/surface-adapter.md).

## Phase 3 discovery

The discovery agent receives six narrow tools over the existing surface adapter. Values are supplied
through named input references and resolved only by a local vault. Deterministic code enforces run
limits, records sanitized evidence, and validates the final review state before returning success.
See [docs/discovery-run.md](docs/discovery-run.md) for tools, completion checks, evidence rules, and
live-run setup.

## Setup

```shell
npm install
npx playwright install chromium
```

No API key or external service is needed for tests. A live discovery run requires the environment
variables documented below and makes an OpenAI API request.

## Run discovery

Start the target portal separately. Then set `OPENAI_API_KEY`, `OPENAI_MODEL`, `TARGET_BASE_URL`,
and `PORTAL_PASSWORD` in the discovery shell and run:

```powershell
npm run discover:prepare:headed
```

Use `npm run discover:prepare` for headless Chromium. The generic `npm run discover` entry remains
available for direct CLI use, but the task-specific commands avoid Windows argument-forwarding
differences.

The CLI does not create `.env` or start the portal. It reads runtime variables from the shell and
can load an existing local `.env` without overriding shell values; it prints only a sanitized run
summary. A ChatGPT or Codex login is not an OpenAI API credential.

## Phase 4 capability compilation

Compilation verifies the selected discovery directory, manifest entries, file sizes, SHA-256
digests, successful terminal state, completion checks, input references, exact semantic targets, and
policy classifications. Only successfully executed browser actions become executable steps;
observations, rejected attempts, and completion events remain provenance counts.

The canonical contract is
[`schemas/capability-artifact.v1.schema.json`](schemas/capability-artifact.v1.schema.json). Compile
a verified local run with:

```powershell
npm run compile:prepare -- discovery-20260920160150-78f495af
```

This command makes no model or network request. It writes
`artifacts/prepare_savings_subaccount/1.0.0/capability.json`. Repeating compilation from identical
evidence is byte-idempotent; the compiler refuses to overwrite different bytes at the same
capability version. See [docs/capability-artifact.md](docs/capability-artifact.md).

## Start the target portal

Normal mode:

```powershell
npm run target:start
```

Open `http://localhost:3000` and use these entirely synthetic training values:

- Operator username: `demo.operator`
- Password: `creditunion-demo`
- Member ID: `M-10042`

Manual walkthrough:

1. Log in and open **Member Search**.
2. Search for `M-10042` and open the returned member profile.
3. Select **Add savings subaccount**.
4. Choose **Growth Savings**, enter nickname **Vacation Fund**, enter initial deposit **250.00**,
   and choose **Everyday Checking — checking ending 1842**.
5. Select **Continue to review**. The review page is the successful end state for
   `prepare_savings_subaccount`; do not select **Open Account** as part of that capability.

The **Open Account** button is functional for manual target testing and creates one in-memory
savings account. Repeated confirmation does not create duplicates. Restarting the process restores
the synthetic fixtures.

## Identity-verification scenario

Start the deterministic interruption scenario in PowerShell:

```powershell
$env:TARGET_SCENARIO="identity_verification_on_review"
npm run target:start
```

Follow the same walkthrough. Continuing from the application form displays a human-owned identity
verification page while preserving the session and draft. Enter the synthetic verification code
`739241` to resume at review in the same browser session. Remove the variable (or open a new
PowerShell window) to return to normal mode:

```powershell
Remove-Item Env:TARGET_SCENARIO
```

For automated tests only, setting `ENABLE_TEST_CONTROLS=true` exposes `POST /__test__/reset`, which
restores fixtures and clears sessions. That endpoint does not exist in normal mode.

## Checks

```shell
npm run format
npm run lint
npm run typecheck
npm test
npm run build
npm test
npm run test:e2e
```
