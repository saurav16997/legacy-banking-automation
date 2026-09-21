import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compileCapabilityArtifact, compileEvidenceRun } from "../../src/compiler/compiler.js";
import { type CapabilityCompilerErrorCode } from "../../src/compiler/contracts.js";
import { loadVerifiedDiscoveryEvidence } from "../../src/compiler/evidence-loader.js";
import { PREPARE_SAVINGS_SUBACCOUNT_DEFINITION } from "../../src/compiler/prepare-savings-subaccount-definition.js";
import { validateCapabilityArtifact } from "../../src/compiler/schema-validator.js";
import type { DiscoveryTrajectory } from "../../src/discovery/contracts.js";
import {
  FIXTURE_RUN_ID,
  writeDiscoveryEvidenceFixture,
} from "../fixtures/discovery/prepare-savings-success.js";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const schemaPath = path.join(projectRoot, "schemas", "capability-artifact.v1.schema.json");

async function setup(mutate?: (trajectory: DiscoveryTrajectory) => void) {
  const root = await mkdtemp(path.join(tmpdir(), "capability-compiler-"));
  const evidenceRoot = path.join(root, "evidence", "discovery");
  await writeDiscoveryEvidenceFixture(evidenceRoot, mutate);
  return { root, evidenceRoot, artifactsRoot: path.join(root, "artifacts") };
}

async function expectCompilerError(
  promise: Promise<unknown>,
  code: CapabilityCompilerErrorCode,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "CapabilityCompilerError", code });
}

async function compileFixture(mutate?: (trajectory: DiscoveryTrajectory) => void) {
  const context = await setup(mutate);
  const evidence = await loadVerifiedDiscoveryEvidence(context.evidenceRoot, FIXTURE_RUN_ID);
  return { ...context, evidence, artifact: compileCapabilityArtifact(evidence) };
}

function eventAt(trajectory: DiscoveryTrajectory, index: number) {
  const event = trajectory.events[index];
  if (!event) throw new Error("Fixture event is missing.");
  return event;
}

function targetAt(trajectory: DiscoveryTrajectory, index: number) {
  const target = eventAt(trajectory, index).semanticTarget;
  if (!target) throw new Error("Fixture semantic target is missing.");
  return target;
}

describe("deterministic capability compiler", () => {
  it("compiles exactly the twelve successful browser actions", async () => {
    const { artifact } = await compileFixture();

    expect(artifact.steps).toHaveLength(12);
    expect(artifact.steps.map((step) => step.sourceEventSequence)).toEqual([
      2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
    expect(artifact.provenance.eventCounts).toEqual({
      total: 15,
      executedBrowserActions: 12,
      rejectedBrowserActions: 1,
      observations: 1,
      validations: 1,
    });
    expect(artifact.lifecycle).toEqual({ status: "DRAFT", approvalRequired: true });
    expect(artifact.outputs.success.accountCreated.value).toBe(false);
  });

  it("validates against the canonical v1 JSON schema", async () => {
    const { artifact } = await compileFixture();
    await expect(validateCapabilityArtifact(artifact, schemaPath)).resolves.toBeUndefined();

    const invalid = structuredClone(artifact) as unknown as Record<string, unknown>;
    invalid.unexpected = true;
    await expectCompilerError(
      validateCapabilityArtifact(invalid as never, schemaPath),
      "ARTIFACT_SCHEMA_INVALID",
    );
  });

  it("is byte-deterministic and emits stable fail-closed target recipes", async () => {
    const first = await compileFixture();
    const second = await compileFixture();
    expect(JSON.stringify(first.artifact)).toBe(JSON.stringify(second.artifact));
    for (const step of first.artifact.steps) {
      expect(step.target.ambiguityPolicy).toBe("FAIL_CLOSED");
      expect(step.target.strategies.at(-1)).toMatchObject({
        kind: "EXACT_ROLE_AND_ACCESSIBLE_NAME",
        exact: true,
        expectedMatches: 1,
      });
    }
  });

  it("does not project observation handles, raw results, model metadata, or literal values", async () => {
    const { artifact } = await compileFixture();
    const serialized = JSON.stringify(artifact);
    for (const forbidden of [
      "observationId",
      "elementRef",
      "sanitizedResult",
      "sanitized-model-id",
      "[REDACTED:review]",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).toContain('"inputRef":"portal_password"');
  });

  it("rejects a tampered manifest-listed trajectory", async () => {
    const { evidenceRoot } = await setup();
    const trajectoryPath = path.join(evidenceRoot, FIXTURE_RUN_ID, "trajectory.json");
    await writeFile(trajectoryPath, `${await readFile(trajectoryPath, "utf8")} `, "utf8");
    await expectCompilerError(
      loadVerifiedDiscoveryEvidence(evidenceRoot, FIXTURE_RUN_ID),
      "MANIFEST_INTEGRITY_FAILED",
    );
  });

  it("rejects unsafe owners and irreversible executed actions", async () => {
    for (const mutation of [
      (trajectory: DiscoveryTrajectory) => {
        eventAt(trajectory, 1).controlOwner = "HUMAN";
      },
      (trajectory: DiscoveryTrajectory) => {
        eventAt(trajectory, 1).controlOwner = "NONE";
      },
      (trajectory: DiscoveryTrajectory) => {
        eventAt(trajectory, 1).actionRisk = "IRREVERSIBLE";
      },
    ]) {
      const { evidenceRoot } = await setup(mutation);
      const evidence = await loadVerifiedDiscoveryEvidence(evidenceRoot, FIXTURE_RUN_ID);
      expect(() => compileCapabilityArtifact(evidence)).toThrow(
        expect.objectContaining({ code: "UNSAFE_EXECUTED_ACTION" }),
      );
    }
  });

  it("rejects an executed Open Account action", async () => {
    const { evidenceRoot } = await setup((trajectory) => {
      eventAt(trajectory, 1).semanticTarget = {
        role: "button",
        accessibleName: "Open Account",
      };
    });
    const evidence = await loadVerifiedDiscoveryEvidence(evidenceRoot, FIXTURE_RUN_ID);
    expect(() => compileCapabilityArtifact(evidence)).toThrow(
      expect.objectContaining({ code: "OPEN_ACCOUNT_EXECUTED" }),
    );
  });

  it("rejects non-successful and incompletely validated trajectories", async () => {
    const failed = await setup((trajectory) => {
      trajectory.finalStatus = "FAILED";
    });
    const failedEvidence = await loadVerifiedDiscoveryEvidence(failed.evidenceRoot, FIXTURE_RUN_ID);
    expect(() => compileCapabilityArtifact(failedEvidence)).toThrow(
      expect.objectContaining({ code: "TRAJECTORY_NOT_SUCCESSFUL" }),
    );

    const incomplete = await setup((trajectory) => {
      const completion = trajectory.completionValidation;
      if (!completion) throw new Error("Fixture completion validation is missing.");
      completion.checks.pop();
    });
    const incompleteEvidence = await loadVerifiedDiscoveryEvidence(
      incomplete.evidenceRoot,
      FIXTURE_RUN_ID,
    );
    expect(() => compileCapabilityArtifact(incompleteEvidence)).toThrow(
      expect.objectContaining({ code: "COMPLETION_VALIDATION_FAILED" }),
    );
  });

  it("rejects unknown operations, undeclared inputs, and literal-value event fields", async () => {
    const unknown = await setup((trajectory) => {
      (eventAt(trajectory, 1) as unknown as Record<string, unknown>).actionType =
        "arbitrary_script";
    });
    await expectCompilerError(
      loadVerifiedDiscoveryEvidence(unknown.evidenceRoot, FIXTURE_RUN_ID),
      "UNKNOWN_OPERATION",
    );

    const undeclared = await setup((trajectory) => {
      eventAt(trajectory, 1).inputRef = "undeclared_input";
    });
    const undeclaredEvidence = await loadVerifiedDiscoveryEvidence(
      undeclared.evidenceRoot,
      FIXTURE_RUN_ID,
    );
    expect(() => compileCapabilityArtifact(undeclaredEvidence)).toThrow(
      expect.objectContaining({ code: "UNDECLARED_INPUT_REFERENCE" }),
    );

    const literal = await setup((trajectory) => {
      (eventAt(trajectory, 1) as unknown as Record<string, unknown>).value = "forbidden";
    });
    await expectCompilerError(
      loadVerifiedDiscoveryEvidence(literal.evidenceRoot, FIXTURE_RUN_ID),
      "LITERAL_VALUE_FORBIDDEN",
    );
  });

  it("rejects mismatched and insufficient semantic target recipes", async () => {
    const mismatched = await setup((trajectory) => {
      targetAt(trajectory, 1).accessibleName = "Different control";
    });
    const mismatchedEvidence = await loadVerifiedDiscoveryEvidence(
      mismatched.evidenceRoot,
      FIXTURE_RUN_ID,
    );
    expect(() => compileCapabilityArtifact(mismatchedEvidence)).toThrow(
      expect.objectContaining({ code: "TARGET_RECIPE_MISMATCH" }),
    );

    const insufficient = await setup((trajectory) => {
      targetAt(trajectory, 1).accessibleName = "";
    });
    const insufficientEvidence = await loadVerifiedDiscoveryEvidence(
      insufficient.evidenceRoot,
      FIXTURE_RUN_ID,
    );
    const definition = structuredClone(PREPARE_SAVINGS_SUBACCOUNT_DEFINITION);
    const firstStep = definition.steps[0];
    if (!firstStep) throw new Error("Fixture definition step is missing.");
    (firstStep.target as { accessibleName: string }).accessibleName = "";
    expect(() => compileCapabilityArtifact(insufficientEvidence, definition)).toThrow(
      expect.objectContaining({ code: "INSUFFICIENT_TARGET_RECIPE" }),
    );
  });

  it("rejects unsafe run identifiers before resolving a path", async () => {
    const { evidenceRoot } = await setup();
    await expectCompilerError(
      loadVerifiedDiscoveryEvidence(evidenceRoot, "../outside"),
      "INVALID_RUN_ID",
    );
  });

  it("rejects a manifest path that could escape the evidence directory", async () => {
    const { evidenceRoot } = await setup();
    const manifestPath = path.join(evidenceRoot, FIXTURE_RUN_ID, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      files: { path: string }[];
    };
    const firstFile = manifest.files[0];
    if (!firstFile) throw new Error("Fixture manifest entry is missing.");
    firstFile.path = "../summary.json";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await expectCompilerError(
      loadVerifiedDiscoveryEvidence(evidenceRoot, FIXTURE_RUN_ID),
      "SOURCE_PATH_OUTSIDE_EVIDENCE",
    );
  });

  it("writes idempotently and refuses a conflicting versioned artifact", async () => {
    const { evidenceRoot, artifactsRoot } = await setup();
    const options = {
      evidenceDiscoveryRoot: evidenceRoot,
      artifactsRoot,
      schemaPath,
      runId: FIXTURE_RUN_ID,
    };
    const first = await compileEvidenceRun(options);
    const second = await compileEvidenceRun(options);
    expect(first.wroteArtifact).toBe(true);
    expect(second.wroteArtifact).toBe(false);
    expect(second.sha256).toBe(first.sha256);

    await writeFile(first.artifactPath, "{}\n", "utf8");
    await expectCompilerError(compileEvidenceRun(options), "ARTIFACT_VERSION_CONFLICT");
  });
});
