# Architecture

The project targets Node.js 20+ with strict TypeScript. `@openai/agents` remains confined to one
future probabilistic discovery agent. Phase 2 implements Playwright only behind `SurfaceAdapter`;
the browser, context, page, locators, selectors, and script evaluation are not exposed through the
public API. Discovery and replay are still deferred and must eventually share this boundary.

# Artifact schema

The checked-in JSON Schema remains the authoritative capability contract. The example capability is
`prepare_savings_subaccount`, which terminates at a verified final review screen.

# Determinism & error handling

The adapter creates unique observations and ephemeral element references, re-resolves semantic
targets by accessible role/name/label, and requires exactly one match. Successful actions rotate the
observation registry. Stale references, ambiguity, external navigation, invalid metadata, and
irreversible actions fail closed. Missing ownership is `NONE`, missing risk is `IRREVERSIBLE`, and
page hints are ignored unless the host explicitly trusts them. Stable test-ID policy configuration
can override hints and takes precedence. Replay and postcondition evaluation remain pending.

# Heterogeneity & multi-tenant

The artifact retains app-family and supported-variant metadata while the initial target remains one
local synthetic Express portal. Multi-tenant runtime behavior is deliberately deferred.

# Escalation & handoff

The irreversible `Open Account` action is observed as `NONE` + `IRREVERSIBLE`, is policy-blocked,
and does not mutate the target when attempted through the adapter. Identity-verification controls
are human-owned: automation receives `HANDOFF_REQUIRED` without interacting, while the same browser
session remains open. Final handoff coordination and explicit operator resume are deferred.

# Safety

The future model will receive only bounded surface commands, never raw Playwright or arbitrary
browser code. Sensitive values are redacted in observations and results. Operations use bounded
timeouts, same-origin navigation, no `networkidle` dependency, and deterministic pre-interaction
policy checks.

# Cuts

No discovery agent, Agents SDK calls, artifact compiler, deterministic replay engine, final handoff
orchestration, MCP, multi-agent framework, autonomous fallback, queues, cloud infrastructure, or
real banking data is implemented in Phase 2.
