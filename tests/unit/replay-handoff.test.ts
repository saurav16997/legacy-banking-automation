import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import type { CapabilityArtifact } from "../../src/compiler/contracts.js";
import type { ObservedElement, SurfaceObservation } from "../../src/domain/index.js";
import { driveHandoffLifecycle } from "../../src/cli/replay-prepare-handoff.js";
import { demoCredentials, syntheticVerificationCode } from "../../target_app/fixtures/index.js";
import {
  ReplayEngine,
  type HandoffResumeRequest,
  type ReplayEvidenceContext,
  type ReplayEvidenceEvent,
  type ReplayEvidenceSink,
  type ReplayEvidenceSummary,
  type ReplayHandoffEvidenceRecord,
  type ReplayInterventionRequiredResult,
} from "../../src/replay/index.js";
import { FakeSurfaceAdapter, makeObservation } from "../helpers/fake-surface.js";

const validInputs = {
  operator_username: "demo.operator",
  portal_password: demoCredentials.password,
  member_id: "M-20017",
  product_name: "Growth Savings",
  account_nickname: "Emergency Fund",
  initial_deposit: "125.00",
  funding_account: "Essential Checking \u2014 checking ending 9021",
} as const;

class MemoryEvidenceSink implements ReplayEvidenceSink {
  readonly events: ReplayEvidenceEvent[] = [];
  readonly handoffs: ReplayHandoffEvidenceRecord[] = [];
  readonly summaries: ReplayEvidenceSummary[] = [];
  readonly screenshotRedactions: string[][] = [];

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

  writeInterimHandoff(record: ReplayHandoffEvidenceRecord): Promise<string> {
    this.handoffs.push(record);
    return Promise.resolve("memory://handoff.json");
  }

  finalize(summary: ReplayEvidenceSummary): Promise<void> {
    this.summaries.push(summary);
    return Promise.resolve();
  }
}

let nextElementNumber = 100;

function element(
  accessibleName: string,
  role: ObservedElement["semanticTarget"]["role"],
  owner: ObservedElement["controlOwner"],
  risk: ObservedElement["actionRisk"],
  label?: string,
): ObservedElement {
  return {
    elementRef: `element-${String(nextElementNumber++)}`,
    semanticTarget: { role, accessibleName, ...(label ? { label } : {}) },
    elementType: role === "button" ? "button" : "input",
    availableOptions: [],
    disabled: false,
    controlOwner: owner,
    actionRisk: risk,
    sensitive: risk === "SENSITIVE",
  };
}

function savingsObservation(): SurfaceObservation {
  return makeObservation({
    pageState: "savings-application",
    primaryHeading: "Add Savings Subaccount",
    visibleText: "Add Savings Subaccount",
    elements: [element("Continue to review", "button", "AUTOMATION", "SAFE")],
  });
}

function humanObservation(): SurfaceObservation {
  return makeObservation({
    pageState: "human-verification-required",
    primaryHeading: "Identity Verification Required",
    visibleText: "Identity Verification Required Human action required.",
    elements: [
      element(
        "Synthetic verification code",
        "textbox",
        "HUMAN",
        "SENSITIVE",
        "Synthetic verification code",
      ),
      element("Verify and continue", "button", "HUMAN", "SAFE"),
    ],
  });
}

function reviewObservation(): SurfaceObservation {
  return makeObservation({
    pageState: "ready-for-review",
    primaryHeading: "Review Savings Subaccount",
    visibleText:
      "Review Savings Subaccount Member M-20017 Product Growth Savings Nickname Emergency Fund Initial deposit 125.00 Funding account Essential Checking \u2014 checking ending 9021 No account has been created.",
    elements: [element("Open Account", "button", "NONE", "IRREVERSIBLE")],
  });
}

function unexpectedObservation(): SurfaceObservation {
  return makeObservation({
    pageState: "employee-dashboard",
    primaryHeading: "Dashboard",
    visibleText: "Dashboard",
    elements: [],
  });
}

function resumeRequest(result: ReplayInterventionRequiredResult): HandoffResumeRequest {
  return {
    handoffId: result.handoff.handoffId,
    resumeToken: result.handoff.resumeToken,
    runId: result.handoff.runId,
    artifactId: result.handoff.artifactId,
    artifactVersion: result.handoff.artifactVersion,
    artifactSha256: result.handoff.artifactSha256,
    checkpointSha256: result.handoff.checkpointSha256,
    completedStepIds: result.handoff.completedStepIds,
  };
}

interface PausedFixture {
  readonly engine: ReplayEngine;
  readonly surface: FakeSurfaceAdapter;
  readonly evidence: MemoryEvidenceSink;
  readonly intervention: ReplayInterventionRequiredResult;
}

describe("resumable deterministic replay handoff", () => {
  let handoffArtifact: CapabilityArtifact;

  beforeAll(async () => {
    const artifact = JSON.parse(
      await readFile(
        path.resolve("artifacts/prepare_savings_subaccount/1.0.0/capability.json"),
        "utf8",
      ),
    ) as CapabilityArtifact;
    const finalStep = structuredClone(artifact.steps.at(-1));
    if (!finalStep) throw new Error("Missing final artifact step");
    handoffArtifact = {
      ...structuredClone(artifact),
      preconditions: [
        { id: "handoff-test-start", kind: "PAGE_STATE_EQUALS", pageState: "savings-application" },
      ],
      steps: [finalStep],
    };
  });

  async function pause(
    options: { now?: () => number; handoffTtlMs?: number } = {},
  ): Promise<PausedFixture> {
    const surface = new FakeSurfaceAdapter(savingsObservation());
    const evidence = new MemoryEvidenceSink();
    surface.executeHandler = () => {
      const observation = humanObservation();
      return { status: "EXECUTED", message: "continued to human gate", observation };
    };
    const engine = new ReplayEngine({
      surface,
      evidence,
      createRunId: () => "replay-20260922090000-a1b2c3d4",
      ...(options.now ? { now: options.now } : {}),
      ...(options.handoffTtlMs ? { handoffTtlMs: options.handoffTtlMs } : {}),
    });
    const result = await engine.replay(handoffArtifact, {
      inputs: validInputs,
      allowDraftArtifact: true,
    });
    if (result.status !== "intervention_required") {
      throw new Error(`Expected intervention_required, received ${result.status}`);
    }
    return { engine, surface, evidence, intervention: result };
  }

  it("checkpoints the executed step, keeps the surface open, and emits a sanitized handoff", async () => {
    const fixture = await pause();

    expect(fixture.engine.state).toBe("PAUSED_FOR_HUMAN");
    expect(fixture.surface.closed).toBe(false);
    expect(fixture.surface.commands).toHaveLength(1);
    expect(fixture.intervention.handoff.completedStepIds).toEqual(["step-12"]);
    expect(fixture.evidence.handoffs).toHaveLength(1);
    expect(fixture.evidence.summaries).toHaveLength(0);
    expect(fixture.evidence.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "HANDOFF_REQUIRED",
          ownership: "HUMAN",
          completedStepIds: ["step-12"],
        }),
      ]),
    );
    for (const value of Object.values(validInputs)) {
      expect(fixture.surface.screenshotRedactions[0]).toContain(value);
    }

    const serialized = JSON.stringify({
      events: fixture.evidence.events,
      handoffs: fixture.evidence.handoffs,
    });
    expect(serialized).not.toContain(fixture.intervention.handoff.resumeToken);
    expect(serialized).not.toContain(syntheticVerificationCode);
    for (const value of Object.values(validInputs)) expect(serialized).not.toContain(value);
  });

  it("keeps a still-present gate resumable, then resumes from a fresh checkpoint observation", async () => {
    let now = 0;
    const fixture = await pause({ now: () => now, handoffTtlMs: 600_000 });
    const request = resumeRequest(fixture.intervention);
    const commandCount = fixture.surface.commands.length;
    const observeCount = fixture.surface.observeOptions.length;

    now = 250_000;
    fixture.surface.observation = humanObservation();
    const pending = await fixture.engine.resume(request);
    expect(pending).toMatchObject({
      status: "handoff_not_completed",
      code: "HANDOFF_NOT_COMPLETED",
    });
    expect(fixture.engine.state).toBe("PAUSED_FOR_HUMAN");
    expect(fixture.surface.commands).toHaveLength(commandCount);
    expect(fixture.surface.observeOptions.length).toBeGreaterThan(observeCount);

    now = 300_000;
    fixture.surface.observation = reviewObservation();
    const success = await fixture.engine.resume(request);
    expect(success).toMatchObject({
      status: "success",
      outputs: { preparation_status: "READY_FOR_REVIEW", account_created: false },
    });
    expect(fixture.engine.state).toBe("COMPLETED");
    expect(fixture.surface.commands).toHaveLength(commandCount);
    expect(fixture.evidence.summaries).toHaveLength(1);
    expect(fixture.evidence.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "RESUME_REQUESTED",
        "HANDOFF_NOT_COMPLETED",
        "HANDOFF_COMPLETED",
        "REPLAY_RESUMED",
        "CHECKPOINT_VALIDATED",
        "RUN_SUCCEEDED",
      ]),
    );
  });

  it("rejects unknown, cross-run, artifact, and checkpoint mismatches without observation", async () => {
    const fixture = await pause();
    const otherSession = await pause();
    const request = resumeRequest(fixture.intervention);
    const observations = fixture.surface.observeOptions.length;
    const otherObservations = otherSession.surface.observeOptions.length;

    await expect(
      fixture.engine.resume({ ...request, resumeToken: "x".repeat(43) }),
    ).resolves.toMatchObject({ status: "resume_rejected", code: "UNKNOWN_HANDOFF" });
    await expect(
      fixture.engine.resume({ ...request, runId: "replay-20990101000000-deadbeef" }),
    ).resolves.toMatchObject({ status: "resume_rejected", code: "HANDOFF_MISMATCH" });
    await expect(
      fixture.engine.resume({ ...request, artifactSha256: "0".repeat(64) }),
    ).resolves.toMatchObject({ status: "resume_rejected", code: "ARTIFACT_MISMATCH" });
    await expect(
      fixture.engine.resume({ ...request, completedStepIds: [] }),
    ).resolves.toMatchObject({ status: "resume_rejected", code: "CHECKPOINT_MISMATCH" });
    await expect(otherSession.engine.resume(request)).resolves.toMatchObject({
      status: "resume_rejected",
      code: "UNKNOWN_HANDOFF",
    });
    expect(fixture.surface.observeOptions).toHaveLength(observations);
    expect(otherSession.surface.observeOptions).toHaveLength(otherObservations);
    expect(fixture.engine.state).toBe("PAUSED_FOR_HUMAN");
  });

  it("rejects an expired token and finalizes the session without browser interaction", async () => {
    let now = 0;
    const fixture = await pause({ now: () => now, handoffTtlMs: 100 });
    const request = resumeRequest(fixture.intervention);
    const observations = fixture.surface.observeOptions.length;
    now = 101;

    const result = await fixture.engine.resume(request);
    expect(result).toMatchObject({ status: "failure", code: "HANDOFF_EXPIRED" });
    expect(fixture.engine.state).toBe("FAILED");
    expect(fixture.surface.observeOptions).toHaveLength(observations);
    expect(fixture.evidence.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "HANDOFF_EXPIRED" })]),
    );
  });

  it("fails closed on an unexpected post-human state", async () => {
    const fixture = await pause();
    fixture.surface.observation = unexpectedObservation();
    const result = await fixture.engine.resume(resumeRequest(fixture.intervention));

    expect(result).toMatchObject({
      status: "failure",
      code: "UNEXPECTED_POST_HANDOFF_STATE",
    });
    expect(fixture.surface.commands).toHaveLength(1);
  });

  it("rejects a consumed token and any resume after completion without observing again", async () => {
    const fixture = await pause();
    const request = resumeRequest(fixture.intervention);
    fixture.surface.observation = reviewObservation();
    await expect(fixture.engine.resume(request)).resolves.toMatchObject({ status: "success" });
    const observations = fixture.surface.observeOptions.length;

    await expect(fixture.engine.resume(request)).resolves.toMatchObject({
      status: "resume_rejected",
      code: "HANDOFF_CONSUMED",
    });
    expect(fixture.surface.observeOptions).toHaveLength(observations);
  });

  it("keeps the CLI handoff active after premature acknowledgement and accepts a later retry", async () => {
    const fixture = await pause({ handoffTtlMs: 600_000 });
    const commandCount = fixture.surface.commands.length;
    const messages: string[] = [];
    let acknowledgementCount = 0;

    const result = await driveHandoffLifecycle(
      fixture.engine,
      fixture.intervention,
      () => {
        acknowledgementCount += 1;
        if (acknowledgementCount === 2) fixture.surface.observation = reviewObservation();
        return Promise.resolve("ACKNOWLEDGED");
      },
      (message) => messages.push(message),
    );

    expect(result).toMatchObject({
      status: "success",
      outputs: { preparation_status: "READY_FOR_REVIEW", account_created: false },
    });
    expect(acknowledgementCount).toBe(2);
    expect(messages.join("\n")).toContain("Verification is still required");
    expect(fixture.surface.commands).toHaveLength(commandCount);
    expect(fixture.evidence.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "HANDOFF_NOT_COMPLETED" })]),
    );
  });

  it.each(["EOF", "SIGNAL", "EXPIRED"] as const)(
    "safely abandons and closes the surface on %s",
    async (acknowledgement) => {
      const fixture = await pause();
      const result = await driveHandoffLifecycle(
        fixture.engine,
        fixture.intervention,
        () => Promise.resolve(acknowledgement),
        () => undefined,
      );

      expect(result).toMatchObject({
        status: "failure",
        code: acknowledgement === "EXPIRED" ? "HANDOFF_EXPIRED" : "HANDOFF_ABANDONED",
      });
      expect(fixture.engine.state).toBe("CLOSED");
      expect(fixture.surface.closed).toBe(true);
      expect(fixture.evidence.summaries).toHaveLength(1);
      expect(fixture.evidence.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: acknowledgement === "EXPIRED" ? "HANDOFF_EXPIRED" : "HANDOFF_ABANDONED",
          }),
        ]),
      );
    },
  );

  it("never automates HUMAN, NONE, IRREVERSIBLE, or Open Account controls", async () => {
    const fixture = await pause();
    fixture.surface.observation = reviewObservation();
    await fixture.engine.resume(resumeRequest(fixture.intervention));

    expect(fixture.surface.commands).toHaveLength(1);
    expect(fixture.surface.commands[0]?.operation).toBe("click");
    expect(fixture.evidence.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "CLICK", message: "Open Account" }),
      ]),
    );
  });
});
