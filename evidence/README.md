# Curated submission evidence

This directory separates reviewable submission evidence from local runtime output. Runtime runs
under `evidence/discovery/` and `evidence/replay/` remain Git-ignored. Only `evidence/examples/**`
is committed.

## Contents

- `capability.json` is byte-identical to the canonical versioned capability artifact.
- `discovery/` contains the sanitized successful discovery trajectory, terminal summary, and a fully
  masked review screenshot.
- `replay-success/` contains the zero-model successful replay context, ordered event stream, and
  terminal summary.
- `replay-handoff/` contains the same-session pause/resume context, event stream, sanitized handoff
  checkpoint, terminal summary, and fully masked pause screenshot.
- `replay-business-outcome/` contains the one controlled zero-model `MEMBER_NOT_FOUND` run.
- `manifest.json` records the source identity, byte size, and SHA-256 digest of every curated
  example. It intentionally does not list itself, avoiding a recursive self-hash.

## Provenance

The discovery, normal replay, and human-handoff files are exact copies from the authoritative runs
named in `manifest.json`. The business-outcome files are exact copies from the single controlled
Phase 7 replay. The package does not alter any source evidence.

## Redaction boundary

The JSON evidence contains input references, page-state identifiers, typed outcomes, policy
classifications, hashes, and timestamps. It contains no resolved invocation values, member IDs,
credentials, API keys, authorization headers, raw resume tokens, verification codes, HTML/DOM,
selectors, Playwright handles, or provider/model messages. The two screenshots were visually
audited: all invocation-dependent and human-verification fields are masked.

`tests/unit/evidence-package.test.ts` verifies artifact byte identity, manifest completeness, every
listed size and digest, and the text-evidence redaction invariants.
