# Project constraints

- Use Node.js 20+ and TypeScript in strict mode.
- Use `@openai/agents` only for probabilistic discovery.
- Use one discovery agent only.
- The first `SurfaceAdapter` implementation is headed Playwright Chromium.
- Never expose unrestricted Playwright or arbitrary browser code to the model.
- Keep policy, recording, artifact compilation, replay, outcomes, evidence, and human control in
  deterministic application code.
- Deterministic replay must make zero model calls and must not fall back autonomously to discovery.
- Do not add MCP, LangGraph, multi-agent frameworks, queues, or cloud infrastructure.
- Target a local, Express-based, server-rendered, legacy-style credit-union member portal.
- Use synthetic data only.
- Do not create `.env`, request an API key during setup, or commit secrets.
- The primary capability is `prepare_savings_subaccount`: success means reaching and verifying the
  final review screen.
- Policy must block the irreversible `Open Account` action; it is outside the capability.
- Test human handoff separately with a seeded session-expiry or identity-verification interruption.
- Do not implement Phase 1 behavior until the scaffold is explicitly approved.
