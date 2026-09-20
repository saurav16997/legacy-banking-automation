# interface.ai Computer-Use Automation System

Node.js 20+ and strict TypeScript project for a computer-use system that separates probabilistic
discovery from deterministic execution. Phase 1 implements only a synthetic, server-rendered target
portal for later automation work.

## Boundary

`@openai/agents` is reserved for one discovery agent operating through bounded tools. Browser access
is hidden behind `SurfaceAdapter`; `PlaywrightSurface` is the first headed-Chromium adapter. Policy,
recording, compilation, replay, outcomes, evidence, and handoff are deterministic application
components. Replay will make zero model calls.

The primary capability is `prepare_savings_subaccount`. It succeeds when automation reaches and
verifies the final review screen. The irreversible `Open Account` action is policy-blocked and is
not part of the capability. Human handoff is a separate scenario driven by a seeded session-expiry
or identity-verification interruption.

Phase 1 contains no AI, discovery, artifact compilation, deterministic replay, OpenAI Agents SDK
calls, or browser-adapter logic. The portal's identity-verification page is a deterministic target
scenario used to test a future human handoff.

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
```
