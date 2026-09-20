# Architecture

The project targets Node.js 20+ with strict TypeScript. Phase 3 confines `@openai/agents` to one
probabilistic discovery agent. Playwright remains only behind `SurfaceAdapter`; the browser,
context, page, locators, selectors, and script evaluation are not exposed through the public API.
Deterministic replay remains deferred and must eventually share this boundary.

# Artifact schema

The checked-in JSON Schema remains the authoritative capability contract. The example capability is
`prepare_savings_subaccount`, which terminates at a verified final review screen.

# Determinism & error handling

The adapter creates unique observations and ephemeral element references, re-resolves semantic
targets by accessible role/name/label, and requires exactly one match. Successful actions rotate the
observation registry. Stale references, ambiguity, external navigation, invalid metadata, and
irreversible actions fail closed. Missing ownership is `NONE`, missing risk is `IRREVERSIBLE`, and
page hints are ignored unless the host explicitly trusts them. Stable test-ID policy configuration
can override hints and takes precedence. Discovery completion uses deterministic review-state and
trajectory checks; replay remains pending.

# Heterogeneity & multi-tenant

The artifact retains app-family and supported-variant metadata while the initial target remains one
local synthetic Express portal. Multi-tenant runtime behavior is deliberately deferred.

# Escalation & handoff

The irreversible `Open Account` action is observed as `NONE` + `IRREVERSIBLE`, is policy-blocked,
and does not mutate the target when attempted through the adapter. Identity-verification controls
are human-owned: automation receives `HANDOFF_REQUIRED` without interacting, while the same browser
session remains open. Final handoff coordination and explicit operator resume are deferred.

# Safety

The discovery model receives only six strict tools over input references and ephemeral elements,
never raw Playwright or arbitrary browser code. Resolved inputs are replaced by placeholders in tool
results and JSON evidence. Operations use bounded turns, actions, repetition, elapsed time,
same-origin navigation, no `networkidle` dependency, and deterministic pre-interaction policy
checks. Offline tests inject a scripted runner and make no OpenAI calls.

# Cuts

No artifact compiler, deterministic replay engine, final handoff orchestration, automatic HUMAN or
irreversible action, MCP, multi-agent system, autonomous fallback, queue, cloud infrastructure, or
real banking data is implemented in Phase 3.
