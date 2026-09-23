import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const requiredReportHeadings = [
  "## Architecture",
  "## Artifact schema",
  "## Determinism & error handling",
  "## Heterogeneity & multi-tenant",
  "## Escalation & handoff",
  "## Safety",
  "## Cuts",
];

describe("evaluator documentation", () => {
  it("keeps every README npm command backed by a package script", async () => {
    const [readme, packageText] = await Promise.all([
      readFile("README.md", "utf8"),
      readFile("package.json", "utf8"),
    ]);
    const packageJson = JSON.parse(packageText) as { scripts?: Record<string, string> };
    const commands = [...readme.matchAll(/npm run ([a-z0-9:-]+)/gu)].map((match) => match[1]);

    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(packageJson.scripts).toHaveProperty(command ?? "");
  });

  it("documents deterministic scenarios, zero-model replay, and alternative demo commands", async () => {
    const readme = await readFile("README.md", "utf8");

    expect(readme).toContain("scenario: normal");
    expect(readme).toContain("scenario: identity_verification_on_review");
    expect(readme).toContain("choose exactly one");
    expect(readme).toContain("does not call OpenAI");
    expect(readme).toContain("OPENAI_API_KEY");
    expect(readme).toContain("required only for a new discovery run");
    expect(readme).not.toContain("npm run replay:prepare -- --allow-draft");
    expect(readme.match(/```mermaid/gu)).toHaveLength(1);
  });

  it("keeps the report structure and diagrams evaluator-reviewable", async () => {
    const report = await readFile("REPORT.md", "utf8");
    const headings = report.match(/^## .+$/gmu) ?? [];

    expect(headings).toEqual(requiredReportHeadings);
    expect(report.match(/```mermaid/gu)).toHaveLength(2);
    expect(report).toContain("Agent-facing capability catalog/API: **not implemented**");
    expect(report).toContain("Bounded single-step LLM fallback: **not implemented**");
    expect(report).toContain("Code generation: **not implemented**");
  });

  it("links to the canonical artifact, schema, evidence, and report", async () => {
    const paths = [
      "artifacts/prepare_savings_subaccount/1.0.0/capability.json",
      "schemas/capability-artifact.v1.schema.json",
      "evidence/examples/discovery/trajectory.json",
      "evidence/examples/replay-success/summary.json",
      "evidence/examples/replay-handoff/summary.json",
      "evidence/examples/replay-business-outcome/summary.json",
      "evidence/examples/manifest.json",
      "REPORT.md",
    ];

    await expect(
      Promise.all(paths.map((file) => access(path.resolve(file)))),
    ).resolves.toBeDefined();
  });
});
