# interface.ai Computer-Use Automation System

Node.js 20+ and strict TypeScript project for a computer-use system that separates probabilistic
discovery from deterministic execution. Phase 1 implements the synthetic, server-rendered target
portal. Phase 2 adds its narrow, policy-controlled browser surface.

## Boundary

`@openai/agents` is reserved for one discovery agent operating through bounded tools. Browser access
is hidden behind `SurfaceAdapter`; `PlaywrightSurface` is the first headed-Chromium adapter. Policy,
recording, compilation, replay, outcomes, evidence, and handoff are deterministic application
components. Replay will make zero model calls.

The primary capability is `prepare_savings_subaccount`. It succeeds when automation reaches and
verifies the final review screen. The irreversible `Open Account` action is policy-blocked and is
not part of the capability. Human handoff is a separate scenario driven by a seeded session-expiry
or identity-verification interruption.

Phase 2 contains no AI, discovery reasoning, artifact compilation, deterministic replay, OpenAI
Agents SDK calls, or final human-handoff orchestration. The portal's identity-verification page is a
deterministic target scenario used to test the adapter's `HANDOFF_REQUIRED` boundary.

## Phase 2 surface adapter

`PlaywrightSurface` implements only four public operations: `start`, `observe`, `execute`, and
`close`. Commands are limited to element-reference-based click, fill, and selection plus same-origin
navigation. Raw browser objects, selectors, XPath, and JavaScript evaluation are not public APIs.

Every observation creates a fresh ID and ephemeral element references. Policy validates ownership,
risk, trusted-classification configuration, and navigation origin before interaction. Page metadata
is ignored unless explicitly trusted; missing or invalid classification fails closed. Details are
documented in [docs/surface-adapter.md](docs/surface-adapter.md).

## Setup

```shell
npm install
npx playwright install chromium
```

No API key or external service is needed.

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
