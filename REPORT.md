# Architecture

The scaffold targets Node.js 20+ with strict TypeScript. `@openai/agents` is confined to one future
probabilistic discovery agent. Playwright remains behind a surface adapter; all other control paths
remain deterministic.

# Artifact schema

The checked-in JSON Schema remains the authoritative capability contract. The example capability is
`prepare_savings_subaccount`, which terminates at a verified final review screen.

# Determinism & error handling

Replay will make zero model calls, require exact target resolution and observable postconditions,
and stop on ambiguity or policy denial. Implementation and evaluation remain pending.

# Heterogeneity & multi-tenant

The artifact retains app-family and supported-variant metadata while the initial target remains one
local synthetic Express portal. Multi-tenant runtime behavior is deliberately deferred.

# Escalation & handoff

The irreversible `Open Account` action is policy-blocked and excluded from the primary capability.
Human handoff will be tested separately through seeded session-expiry or identity-verification
interruptions in the same headed browser session.

# Safety

The model will receive only bounded discovery tools, never raw Playwright or arbitrary browser code.
Inputs, logs, screenshots, and evidence will use synthetic data and deterministic redaction
controls.

# Cuts

No Phase 1 workflow, MCP, multi-agent framework, autonomous replay fallback, queues, cloud
infrastructure, or real banking data is included in this scaffold.
