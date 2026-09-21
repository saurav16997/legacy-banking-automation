# Deterministic Capability Compilation

## Boundary

Phase 4 converts a verified, sanitized `DiscoveryTrajectory` and the curated versioned
`prepare_savings_subaccount` definition into a draft capability artifact. Compilation imports no
Agents SDK or discovery runner code, makes no model or network request, and does not implement
replay or handoff.

The sole canonical contract is `schemas/capability-artifact.v1.schema.json`. The versioned output is
`artifacts/prepare_savings_subaccount/1.0.0/capability.json`.

## Source verification

Before compilation, the loader:

- accepts only the fixed discovery run-ID shape and contains resolution within the configured
  evidence root;
- parses a closed manifest and rejects duplicate, absolute, backslash, dot, or parent paths;
- checks every listed file's byte length and SHA-256 digest and rejects unlisted files;
- requires and parses `trajectory.json` and `summary.json`;
- checks that run IDs and terminal statuses agree; and
- rejects unsupported trajectory versions, operations, or event-level literal-value fields.

The compiler then requires `SUCCESS`, all eleven deterministic completion checks, the expected input
contract, summary/action-count agreement, and `ready-for-review` as the final state.

## Step projection

Only browser actions with sanitized result status `EXECUTED` become steps. The initial observation,
the rejected stale-reference attempt, and the final completion-validation event are excluded. They
remain represented by provenance event counts. The authoritative run therefore produces exactly
twelve steps from source event sequences `2, 4-14`.

Each source action must exactly match the curated operation, input reference, start and result page
states, semantic role, accessible name, optional label or trusted ID, ownership, and risk. Recipes
use only trusted control IDs, exact labels, and exact role/accessibility-name pairs scoped to an
expected page state. Every strategy requires exactly one match and ambiguity always fails closed.
Missing or different target identity is a compilation error; the compiler does not invent selectors
or guess a target.

Executed `HUMAN`, `NONE`, or `IRREVERSIBLE` actions and an executed `Open Account` target are always
rejected. The observed review-page `Open Account` control is retained only as a checkpoint target
classified `NONE` + `IRREVERSIBLE`.

## Inputs, outputs, and outcomes

Steps contain named `inputRef` values only. The artifact declares types, sensitivity, format,
pattern, and currency metadata without embedding invocation values. Success is `READY_FOR_REVIEW`,
explicitly records `accountCreated: false`, and defines a typed review receipt whose values come
from validated inputs or deterministic checks.

`MEMBER_NOT_FOUND` is a terminal business outcome detected by the `member-search` page state plus an
input-bound text template. Stale targets and transient timeouts are bounded recoverable conditions;
all other declared codes are terminal failures for later replay handling.

## Determinism and lifecycle

Canonical JSON recursively sorts object keys, preserves array order, uses two-space indentation, and
ends with one newline. The compiler uses only timestamps and hashes already present in verified
evidence; it never reads the current clock. Recompiling identical evidence produces identical bytes
and reports an idempotent no-op. Different bytes at an existing capability/version path cause
`ARTIFACT_VERSION_CONFLICT` instead of an overwrite.

Generated artifacts are `DRAFT` and require explicit approval. Phase 4 does not approve, execute, or
replay them.

## Command

```powershell
npm run compile:prepare -- <discovery-run-id>
```

The CLI prints a concise result containing only the status, capability version, step count, artifact
path, digest, and whether the file was newly written. Failures print an allowlisted compiler error
code and never raw evidence or input values.
