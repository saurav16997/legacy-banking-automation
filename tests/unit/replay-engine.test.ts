import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import type { CapabilityArtifact } from "../../src/compiler/contracts.js";
import type { ObservedElement } from "../../src/domain/index.js";
import {
  ReplayEngine,
  type ReplayEvidenceContext,
  type ReplayEvidenceEvent,
  type ReplayEvidenceSink,
  type ReplayEvidenceSummary,
} from "../../src/replay/index.js";
import { FakeSurfaceAdapter, makeObservation } from "../helpers/fake-surface.js";

const validInputs = {
  operator_username: "demo.operator",
  portal_password: "creditunion-demo",
  member_id: "M-20017",
  product_name: "Growth Savings",
  account_nickname: "Emergency Fund",
  initial_deposit: "125.00",
  funding_account: "Essential Checking \u2014 checking ending 9021",
} as const;

class MemoryEvidenceSink implements ReplayEvidenceSink {
  readonly events: ReplayEvidenceEvent[] = [];

  initialize(_context: ReplayEvidenceContext): Promise<void> {
    return Promise.resolve();
  }

  append(event: ReplayEvidenceEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }

  writeScreenshot(name: string, _bytes: Uint8Array): Promise<string> {
    return Promise.resolve(`memory://${name}`);
  }

  writeInterimHandoff(): Promise<string> {
    return Promise.resolve("memory://handoff.json");
  }

  finalize(_summary: ReplayEvidenceSummary): Promise<void> {
    return Promise.resolve();
  }
}

function observedElement(
  role: ObservedElement["semanticTarget"]["role"],
  accessibleName: string,
  label?: string,
): ObservedElement {
  return {
    elementRef: "element-001",
    semanticTarget: { role, accessibleName, ...(label ? { label } : {}) },
    elementType: role === "button" ? "button" : "input",
    currentValue: "",
    availableOptions: [],
    disabled: false,
    controlOwner: "AUTOMATION",
    actionRisk: "SAFE",
    sensitive: false,
  };
}

function artifactWithSingleStep(
  artifact: CapabilityArtifact,
  sourceStep: number,
  overrides: {
    timeoutMs?: number;
    maxAttempts?: number;
    retryOn?: readonly ("STALE_TARGET" | "TRANSIENT_TIMEOUT")[];
    maxTotalRuntimeMs?: number;
  } = {},
): CapabilityArtifact {
  const step = structuredClone(artifact.steps[sourceStep]);
  if (!step) throw new Error("Missing fixture step");
  return {
    ...structuredClone(artifact),
    steps: [
      {
        ...step,
        timeoutMs: overrides.timeoutMs ?? step.timeoutMs,
        retry: {
          ...step.retry,
          maxAttempts: overrides.maxAttempts ?? step.retry.maxAttempts,
          retryOn: overrides.retryOn ?? step.retry.retryOn,
        },
      },
    ],
    executionPolicy: {
      ...artifact.executionPolicy,
      maxStepAttempts: overrides.maxAttempts ?? artifact.executionPolicy.maxStepAttempts,
      maxTotalRuntimeMs: overrides.maxTotalRuntimeMs ?? artifact.executionPolicy.maxTotalRuntimeMs,
    },
  };
}

describe("deterministic replay validation", () => {
  let artifact: CapabilityArtifact;

  beforeAll(async () => {
    artifact = JSON.parse(
      await readFile(
        path.resolve("artifacts/prepare_savings_subaccount/1.0.0/capability.json"),
        "utf8",
      ),
    ) as CapabilityArtifact;
  });

  it("rejects a draft artifact unless the caller explicitly enables the local demo override", async () => {
    const surface = new FakeSurfaceAdapter();
    const result = await new ReplayEngine({ surface }).replay(artifact, { inputs: validInputs });

    expect(result).toMatchObject({
      status: "failure",
      code: "ARTIFACT_NOT_APPROVED",
      stepId: null,
    });
    expect(surface.commands).toEqual([]);
  });

  it("validates all invocation inputs before opening or acting on the surface", async () => {
    const surface = new FakeSurfaceAdapter();
    const inputs = { ...validInputs, member_id: "not-a-member-id" };
    const result = await new ReplayEngine({ surface }).replay(artifact, {
      inputs,
      allowDraftArtifact: true,
    });

    expect(result).toMatchObject({ status: "failure", code: "INVALID_INPUT", stepId: null });
    expect(surface.commands).toEqual([]);
  });

  it("rejects undeclared inputs rather than silently accepting ambient values", async () => {
    const surface = new FakeSurfaceAdapter();
    const result = await new ReplayEngine({ surface }).replay(artifact, {
      inputs: { ...validInputs, extra_secret: "must-not-be-used" },
      allowDraftArtifact: true,
    });

    expect(result).toMatchObject({ status: "failure", code: "INVALID_INPUT", stepId: null });
    expect(surface.commands).toEqual([]);
  });

  describe("bounded step attempts", () => {
    it("passes the effective step timeout to the surface and returns TRANSIENT_TIMEOUT", async () => {
      const timedArtifact = artifactWithSingleStep(artifact, 0, {
        timeoutMs: 40,
        maxAttempts: 1,
        retryOn: ["TRANSIENT_TIMEOUT"],
      });
      const surface = new FakeSurfaceAdapter(
        makeObservation({
          elements: [observedElement("textbox", "Operator username", "Operator username")],
        }),
      );
      surface.executeHandler = async (_command, options) => {
        await new Promise<void>((resolve) => setTimeout(resolve, options?.timeoutMs ?? 1));
        return { status: "TIMED_OUT", message: "Synthetic bounded timeout." };
      };

      const result = await new ReplayEngine({ surface }).replay(timedArtifact, {
        inputs: validInputs,
        allowDraftArtifact: true,
      });

      expect(result).toMatchObject({ status: "failure", code: "TRANSIENT_TIMEOUT" });
      expect(surface.executeOptions).toHaveLength(1);
      expect(surface.executeOptions[0]?.timeoutMs).toBeGreaterThan(0);
      expect(surface.executeOptions[0]?.timeoutMs).toBeLessThanOrEqual(40);
    });

    it("waits for timeout cancellation to settle before returning", async () => {
      const timedArtifact = artifactWithSingleStep(artifact, 0, {
        timeoutMs: 25,
        maxAttempts: 1,
        retryOn: ["TRANSIENT_TIMEOUT"],
      });
      const surface = new FakeSurfaceAdapter(
        makeObservation({
          elements: [observedElement("textbox", "Operator username", "Operator username")],
        }),
      );
      let active = false;
      let underlyingActionCompleted = false;
      surface.executeHandler = (_command, options) =>
        new Promise((resolve) => {
          active = true;
          const work = setTimeout(
            () => {
              underlyingActionCompleted = true;
            },
            (options?.timeoutMs ?? 1) + 30,
          );
          setTimeout(() => {
            clearTimeout(work);
            active = false;
            resolve({ status: "TIMED_OUT", message: "Synthetic operation cancelled." });
          }, options?.timeoutMs ?? 1);
        });

      const result = await new ReplayEngine({ surface }).replay(timedArtifact, {
        inputs: validInputs,
        allowDraftArtifact: true,
      });

      expect(result).toMatchObject({ status: "failure", code: "TRANSIENT_TIMEOUT" });
      expect(active).toBe(false);
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      expect(underlyingActionCompleted).toBe(false);
    });

    it("retries an eligible idempotent timeout only up to the declared bound", async () => {
      const timedArtifact = artifactWithSingleStep(artifact, 0, {
        timeoutMs: 100,
        maxAttempts: 2,
        retryOn: ["TRANSIENT_TIMEOUT"],
      });
      const surface = new FakeSurfaceAdapter(
        makeObservation({
          elements: [observedElement("textbox", "Operator username", "Operator username")],
        }),
      );
      surface.executeHandler = () => ({ status: "TIMED_OUT", message: "Synthetic timeout." });

      const result = await new ReplayEngine({ surface }).replay(timedArtifact, {
        inputs: validInputs,
        allowDraftArtifact: true,
      });

      expect(result).toMatchObject({ status: "failure", code: "TRANSIENT_TIMEOUT" });
      expect(surface.commands).toHaveLength(2);
    });

    it("does not retry a non-idempotent click even when timeout recovery is declared", async () => {
      const timedArtifact = artifactWithSingleStep(artifact, 2, {
        timeoutMs: 100,
        maxAttempts: 3,
        retryOn: ["TRANSIENT_TIMEOUT"],
      });
      const surface = new FakeSurfaceAdapter(
        makeObservation({ elements: [observedElement("button", "Log in")] }),
      );
      surface.executeHandler = () => ({ status: "TIMED_OUT", message: "Synthetic timeout." });

      const result = await new ReplayEngine({ surface }).replay(timedArtifact, {
        inputs: validInputs,
        allowDraftArtifact: true,
      });

      expect(result).toMatchObject({ status: "failure", code: "TRANSIENT_TIMEOUT" });
      expect(surface.commands).toHaveLength(1);
    });

    it("never passes a timeout larger than the remaining global runtime", async () => {
      let now = 0;
      const timedArtifact = artifactWithSingleStep(artifact, 0, {
        timeoutMs: 1_000,
        maxAttempts: 1,
        retryOn: ["TRANSIENT_TIMEOUT"],
        maxTotalRuntimeMs: 50,
      });
      class AdvancingSurface extends FakeSurfaceAdapter {
        override async observe(options = {}) {
          const result = await super.observe(options);
          now += 20;
          return result;
        }
      }
      const surface = new AdvancingSurface(
        makeObservation({
          elements: [observedElement("textbox", "Operator username", "Operator username")],
        }),
      );
      surface.executeHandler = () => ({ status: "TIMED_OUT", message: "Synthetic timeout." });

      await new ReplayEngine({ surface, now: () => now }).replay(timedArtifact, {
        inputs: validInputs,
        allowDraftArtifact: true,
      });

      expect(surface.startOptions[0]?.timeoutMs).toBe(50);
      expect(surface.observeOptions[0]?.timeoutMs).toBe(50);
      expect(surface.executeOptions[0]?.timeoutMs).toBe(30);
    });

    it("records timeout evidence using references and redacts every input value", async () => {
      const timedArtifact = artifactWithSingleStep(artifact, 0, {
        timeoutMs: 100,
        maxAttempts: 1,
        retryOn: ["TRANSIENT_TIMEOUT"],
      });
      const surface = new FakeSurfaceAdapter(
        makeObservation({
          elements: [observedElement("textbox", "Operator username", "Operator username")],
        }),
      );
      surface.executeHandler = () => ({ status: "TIMED_OUT", message: "Synthetic timeout." });
      const evidence = new MemoryEvidenceSink();

      await new ReplayEngine({ surface, evidence }).replay(timedArtifact, {
        inputs: validInputs,
        allowDraftArtifact: true,
      });

      const serializedEvidence = JSON.stringify(evidence.events);
      expect(evidence.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "STEP_TIMED_OUT",
            code: "TRANSIENT_TIMEOUT",
            timeoutScope: "ATTEMPT",
            inputRef: "operator_username",
          }),
        ]),
      );
      for (const value of Object.values(validInputs)) {
        expect(serializedEvidence).not.toContain(value);
        expect(surface.screenshotRedactions[0]).toContain(value);
      }
    });

    it("distinguishes exhaustion of the global replay deadline", async () => {
      let now = 0;
      const timedArtifact = artifactWithSingleStep(artifact, 0, {
        timeoutMs: 1_000,
        maxAttempts: 2,
        retryOn: ["TRANSIENT_TIMEOUT"],
        maxTotalRuntimeMs: 50,
      });
      const surface = new FakeSurfaceAdapter(
        makeObservation({
          elements: [observedElement("textbox", "Operator username", "Operator username")],
        }),
      );
      surface.executeHandler = () => {
        now = 50;
        return { status: "TIMED_OUT", message: "Synthetic global timeout." };
      };

      const result = await new ReplayEngine({ surface, now: () => now }).replay(timedArtifact, {
        inputs: validInputs,
        allowDraftArtifact: true,
      });

      expect(result).toMatchObject({ status: "failure", code: "GLOBAL_TIMEOUT" });
      expect(surface.commands).toHaveLength(1);
    });

    it("keeps policy rejection distinct from timeout and does not retry it", async () => {
      const timedArtifact = artifactWithSingleStep(artifact, 0, {
        timeoutMs: 100,
        maxAttempts: 2,
        retryOn: ["TRANSIENT_TIMEOUT"],
      });
      const surface = new FakeSurfaceAdapter(
        makeObservation({
          elements: [observedElement("textbox", "Operator username", "Operator username")],
        }),
      );
      surface.executeHandler = () => ({ status: "BLOCKED", message: "Synthetic policy block." });

      const result = await new ReplayEngine({ surface }).replay(timedArtifact, {
        inputs: validInputs,
        allowDraftArtifact: true,
      });

      expect(result).toMatchObject({ status: "failure", code: "POLICY_VIOLATION" });
      expect(surface.commands).toHaveLength(1);
    });

    it("keeps target-not-found distinct and never invokes the surface action", async () => {
      const timedArtifact = artifactWithSingleStep(artifact, 0, {
        timeoutMs: 100,
        maxAttempts: 2,
        retryOn: ["TRANSIENT_TIMEOUT"],
      });
      const surface = new FakeSurfaceAdapter(makeObservation({ elements: [] }));

      const result = await new ReplayEngine({ surface }).replay(timedArtifact, {
        inputs: validInputs,
        allowDraftArtifact: true,
      });

      expect(result).toMatchObject({ status: "failure", code: "TARGET_NOT_FOUND" });
      expect(surface.commands).toHaveLength(0);
    });

    it("never executes a live NONE-owned irreversible target", async () => {
      const timedArtifact = artifactWithSingleStep(artifact, 0, {
        timeoutMs: 100,
        maxAttempts: 2,
        retryOn: ["TRANSIENT_TIMEOUT"],
      });
      const forbidden = observedElement("textbox", "Operator username", "Operator username");
      const surface = new FakeSurfaceAdapter(
        makeObservation({
          elements: [{ ...forbidden, controlOwner: "NONE", actionRisk: "IRREVERSIBLE" }],
        }),
      );

      const result = await new ReplayEngine({ surface }).replay(timedArtifact, {
        inputs: validInputs,
        allowDraftArtifact: true,
      });

      expect(result).toMatchObject({ status: "failure", code: "POLICY_VIOLATION" });
      expect(surface.commands).toHaveLength(0);
    });
  });
});
