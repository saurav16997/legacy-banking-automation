# Architecture

The project targets Node.js 20+ with strict TypeScript. Phase 3 confines `@openai/agents` to one
probabilistic discovery agent. Playwright remains only behind `SurfaceAdapter`; the browser,
context, page, locators, selectors, and script evaluation are not exposed through the public API.
Phase 4 adds deterministic artifact compilation. Phase 5 adds zero-model-call deterministic replay
through the same bounded surface.

# Artifact schema

`schemas/capability-artifact.v1.schema.json` is the sole authoritative capability contract. The
compiler verifies the source evidence manifest and digests, then combines the successful sanitized
trajectory with a curated, versioned `prepare_savings_subaccount` definition. Its draft artifact
contains typed inputs and outputs, exact semantic target recipes, retry and timeout policy,
checkpoint and postconditions, explicit business and failure outcomes, provenance, safety policy,
and compatibility metadata. It never contains literal inputs, ephemeral element handles, selectors,
raw observations, model text, or discovery summaries.

# Determinism & error handling

The adapter creates unique observations and ephemeral element references, re-resolves semantic
targets by accessible role/name/label, and requires exactly one match. Successful actions rotate the
observation registry. Stale references, ambiguity, external navigation, invalid metadata, and
irreversible actions fail closed. Missing ownership is `NONE`, missing risk is `IRREVERSIBLE`, and
page hints are ignored unless the host explicitly trusts them. Stable test-ID policy configuration
can override hints and takes precedence. Discovery completion uses deterministic review-state and
trajectory checks. Compilation includes only executed browser actions and uses canonical, key-sorted
JSON, source timestamps only, and conflict-safe versioned writes. Replay validates inputs, resolves
ordered semantic targets, checks live policy classifications, evaluates business outcomes and final
conditions, and emits artifact-linked redacted evidence.

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

No final resumable handoff orchestration, automatic HUMAN or irreversible action, MCP, multi-agent
system, autonomous fallback, queue, cloud infrastructure, or real banking data is implemented
through Phase 5. Replay can detect a human gate and preserve the supplied live surface, but explicit
operator resume and same-session continuation remain deferred.
