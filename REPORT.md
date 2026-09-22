# Architecture

The system separates probabilistic learning from deterministic execution. A single OpenAI Agents SDK
agent performs goal-driven discovery through six closed tools. It sees semantic observations, input
references, and sanitized results—not resolved values, selectors, Playwright objects, or arbitrary
browser code. Deterministic application code owns policy, completion validation, recording,
compilation, replay, outcomes, evidence, and human control.

Node.js and strict TypeScript keep the local Express portal, Playwright adapter, schemas, CLIs, and
tests in one typed runtime. That reduces serialization mismatches at the trust boundaries and makes
the demonstration straightforward to run on Windows. Express/EJS deliberately represents a
server-rendered legacy application rather than a modern API-first target.

`SurfaceAdapter` is the stable browser port. Its first implementation uses headed or headless
Playwright Chromium, but consumers depend only on bounded `start`, `observe`, `execute`, screenshot,
session-identity, and `close` operations. Semantic roles, accessible names, labels, trusted IDs, and
expected page states were chosen instead of CSS/XPath because they express operator-visible intent,
survive incidental layout changes, and can be checked for exactly one match. Ephemeral observation
and element references prevent stale or fabricated browser handles.

# Artifact schema

The canonical v1 JSON schema defines capability identity and lifecycle, typed input references,
ordered steps, target strategies, timeouts and recovery, checkpoint/postconditions, typed outcomes,
safety policy, provenance, and compatibility. The checked-in `prepare_savings_subaccount` v1.0.0
artifact is a DRAFT with 12 safe actions and SHA-256
`6b69efff71733dd1da104a822cb2da75a0372d9e55582aa0a372233cedf61c83`.

Compilation accepts only a verified successful discovery directory. It validates the source
manifest, path containment, byte sizes, hashes, event vocabulary, input contract, action count,
semantic recipes, ownership/risk, and deterministic completion checks. It excludes observations,
stale attempts, model metadata, literal values, and the completion declaration from executable
steps. Canonical JSON sorting and newline rules make identical inputs byte-identical; an existing
version with different bytes fails instead of being overwritten.

# Determinism & error handling

Replay validates the artifact and every declared invocation input before opening a browser. For each
step it freshly observes the expected page, evaluates ordered semantic strategies, requires one
match, rechecks live ownership/risk, executes through `SurfaceAdapter`, and verifies the result
page. It makes zero model calls and has no discovery fallback.

Failures remain typed and distinct: invalid artifact/input, policy rejection, target missing or
ambiguous, stale observation, transient step timeout, exhausted global deadline, unexpected state,
handoff failure, and internal error. `MEMBER_NOT_FOUND` is a terminal business outcome, not a
generic failure. One live zero-model Phase 7 run exercised it and stopped after six safe artifact
actions.

Retry is deliberately narrow. Only declared idempotent FILL and SELECT_OPTION operations may retry
for their named stale/timeout recovery, within attempt and total-runtime bounds. Clicks, policy
rejections, HUMAN/NONE ownership, irreversible operations, and ambiguous targets never retry.
Timeouts propagate to the real Playwright operation and settle before control returns, preventing a
late browser mutation after a terminal result.

# Heterogeneity & multi-tenant

The architecture supports another UI through a new `SurfaceAdapter`, not by exposing raw browser
automation to discovery or replay. Artifact compatibility fields and surface versions make drift
explicit; exact semantic matching fails closed when a page changes. A new workflow adds a curated
definition, schema-compatible artifact, deterministic completion/outcome rules, and tests rather
than a new agent framework. A desktop adapter would preserve the same semantic target, ownership,
and policy contract while replacing the web accessibility/interaction implementation; legacy UIs
without useful accessibility metadata would require a deliberately bounded adapter-specific
normalization layer.

This submission intentionally runs one local synthetic tenant. A production extension would bind a
tenant ID, target origin, adapter configuration, artifact approval, input source, and evidence sink
into one immutable execution context. Artifacts and resume tokens would be tenant-scoped, and no
ambient credential or cross-tenant artifact lookup would be allowed. Reuse would start from a base
artifact and apply explicit, schema-validated tenant, vendor, and UI-version override layers before
approval; silent runtime overrides would be forbidden. Those controls are extension requirements,
not claims about the single-tenant demo.

# Escalation & handoff

A HUMAN-owned identity-verification page causes `PAUSED_FOR_HUMAN`, never an automated action. The
coordinator creates a 256-bit in-memory token and stores only its SHA-256 digest. It binds the token
to run, artifact, replay/surface sessions, completed-step checkpoint, expected transition, and TTL.
The browser remains open while the employee acts directly.

Resume accepts the token once, requires the same process and live sessions, and performs a fresh
observation. It cannot reuse pre-handoff element references or repeat completed actions. If the gate
remains, the token stays usable until expiry; an unexpected state, changed binding, expiry,
abandonment, or consumed token fails closed. The authoritative live run paused after all 12 artifact
steps, resumed with zero repeated actions, and finished `READY_FOR_REVIEW` in the original evidence
directory.

# Safety

Policy treats missing metadata as `NONE` plus `IRREVERSIBLE`. Only `AUTOMATION` controls with safe
or explicitly permitted sensitive risk can execute. External navigation, HUMAN/NONE ownership,
irreversible risk, and **Open Account** are blocked before interaction. The success contract proves
the review page and `accountCreated: false`; it never equates navigation with completion.

Sensitive values stay in an in-memory input vault or replay invocation. Evidence records references,
page states, fingerprints, policy decisions, hashes, and typed outcomes. It excludes resolved
inputs, credentials, API keys, authorization headers, raw tokens, verification values, HTML/DOM,
selectors, Playwright handles, and provider messages. Screenshots mask form controls and
invocation-dependent display values. Runtime evidence remains ignored; the committed examples are
hash-manifested, audited copies with an automated drift/redaction test.

# Cuts

The submission omits production identity, remote secret storage, distributed queues, durable
cross-process handoff, artifact signing/approval service, fleet scheduling, telemetry backends,
frame-tree normalization, downloads/uploads, and autonomous recovery through discovery. These cuts
keep the safety boundary inspectable and match the local assignment scope.

The next production step would be signed artifact approval plus tenant-bound execution identities
and a durable evidence store, followed by a second adapter/workflow to validate the intended
extension points. It should preserve the core rule demonstrated here: models may propose during
bounded discovery, while policy, replay, outcomes, evidence, and irreversible-action control remain
deterministic.
