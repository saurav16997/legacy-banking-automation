# Controlled Surface Adapter

## Architectural boundary

Playwright is the first implementation detail behind `SurfaceAdapter`; it is not the architecture.
The public contract consists of `start`, `observe`, `execute`, and `close`. A future discovery agent
and deterministic replay engine will both depend on that contract and will therefore pass through
the same policy checks, target-resolution rules, timeouts, and redaction behavior.

The adapter never returns a Playwright `Browser`, `BrowserContext`, `Page`, or `Locator`. It also
has no public selector, JavaScript evaluation, script, upload, or download operation. Callers can
issue only `click`, `fill`, `selectOption`, and same-origin `navigate` commands. This prevents a
future model from bypassing policy with raw CSS, XPath, page scripts, or unrestricted browser code.

## Observations and ephemeral references

Each observation has a new UUID and a new inventory of visible interactive elements. Entries have
ephemeral references such as `element-001` and semantic targets made from accessible roles, names,
labels, and an optional stable test ID. The serializable observation contains no Playwright objects.

Every element command must present both the observation ID and element reference. Any successful
action produces a fresh observation and invalidates the earlier registry. An ID mismatch, a
reference from an older observation, or a manufactured reference is rejected. At execution time, the
adapter resolves the recorded semantic target again and requires exactly one match. Zero or multiple
matches fail closed without interaction.

## Policy ownership and risk

Policy runs before the adapter resolves or interacts with a live element:

| Owner        | Risk           | Result                                               |
| ------------ | -------------- | ---------------------------------------------------- |
| `AUTOMATION` | `SAFE`         | Allowed                                              |
| `AUTOMATION` | `SENSITIVE`    | Allowed only when explicitly enabled; value redacted |
| `HUMAN`      | Any reversible | `HANDOFF_REQUIRED`; no browser interaction           |
| `NONE`       | Any            | `BLOCKED`                                            |
| Any          | `IRREVERSIBLE` | `BLOCKED`                                            |

Missing ownership defaults to `NONE`; missing or invalid risk defaults to `IRREVERSIBLE`. Both cases
are therefore blocked. Page metadata is only a classification hint and is ignored unless the host
explicitly enables `trustControlMetadata` for the configured application. The target portal marks
every interactive workflow control, but those annotations do not authorize themselves.

Independent trusted policy configuration takes precedence over page hints. A host may classify a
specific stable test ID through `trustedControlClassifications`; this is the only way an
unclassified or incorrectly classified control can become executable. This keyed allowlist is
evaluated before trusted page hints, and the resulting effective owner and risk still pass through
the policy matrix. Invalid trusted configuration also fails closed.

Navigation is allowed only when its resolved URL has the configured target-app origin. The primary
capability therefore cannot click **Open Account**, which the target marks as `NONE` and
`IRREVERSIBLE`. Identity-verification fields are `HUMAN`, so an automation attempt preserves the
live session and returns `HANDOFF_REQUIRED`.

## Redaction and bounded behavior

Sensitive input values appear as `[REDACTED]` in observations and are never repeated in action
results. Browser operations use bounded timeouts and page navigation waits for `domcontentloaded`,
never `networkidle`. Links and direct navigation are checked against the allowed origin.

## Deferred responsibilities

Phase 2 deliberately does not implement:

- OpenAI Agents SDK calls or discovery reasoning;
- action recording or evidence persistence;
- artifact compilation or approval;
- deterministic artifact replay and postcondition evaluation;
- screenshots and frame-tree normalization;
- final human-handoff coordination, operator resume signals, or handoff auditing; or
- outcome classification.

Those components may consume this adapter later, but they may not receive its private Playwright
objects or add a parallel browser-control path.
