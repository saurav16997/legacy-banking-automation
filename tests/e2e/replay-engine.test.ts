import { mkdtemp, readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PlaywrightSurface } from "../../src/browser/index.js";
import type { CapabilityArtifact } from "../../src/compiler/contracts.js";
import { FileReplayEvidenceSink, ReplayEngine, type ReplayInputs } from "../../src/replay/index.js";
import { createTargetApp } from "../../target_app/server.js";

function serverUrl(server: Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

const successfulInputs: ReplayInputs = {
  operator_username: "demo.operator",
  portal_password: "creditunion-demo",
  member_id: "M-20017",
  product_name: "Growth Savings",
  account_nickname: "Emergency Fund",
  initial_deposit: "125.00",
  funding_account: "Essential Checking \u2014 checking ending 9021",
};

describe("deterministic capability replay", () => {
  const target = createTargetApp();
  const targetServer = target.app.listen(0);
  const ambiguousTarget = createTargetApp({ scenario: "ambiguous_continue_control" });
  const ambiguousServer = ambiguousTarget.app.listen(0);
  const interruptedTarget = createTargetApp({ scenario: "identity_verification_on_review" });
  const interruptedServer = interruptedTarget.app.listen(0);
  const surfaces: PlaywrightSurface[] = [];
  let artifact: CapabilityArtifact;
  let evidenceRoot: string;

  beforeAll(async () => {
    artifact = JSON.parse(
      await readFile(
        path.resolve("artifacts/prepare_savings_subaccount/1.0.0/capability.json"),
        "utf8",
      ),
    ) as CapabilityArtifact;
    evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "interface-cua-replay-"));
  });

  afterEach(async () => {
    await Promise.all(surfaces.splice(0).map(async (surface) => surface.close()));
  });

  afterAll(async () => {
    await Promise.all([
      closeServer(targetServer),
      closeServer(ambiguousServer),
      closeServer(interruptedServer),
    ]);
  });

  function surface(baseUrl: string): PlaywrightSurface {
    const created = new PlaywrightSurface({
      baseUrl,
      headless: true,
      timeoutMs: 3_000,
      allowSensitiveAutomation: true,
      trustControlMetadata: true,
    });
    surfaces.push(created);
    return created;
  }

  function engine(
    baseUrl: string,
    suffix: string,
  ): {
    replay: ReplayEngine;
    evidence: FileReplayEvidenceSink;
  } {
    const evidence = new FileReplayEvidenceSink(evidenceRoot);
    return {
      replay: new ReplayEngine({
        surface: surface(baseUrl),
        evidence,
        createRunId: () => `replay-20260921120000-${suffix}`,
      }),
      evidence,
    };
  }

  it("replays with inputs different from discovery and stops at review", async () => {
    const accountCount = target.fixtures.findMember("M-20017")?.accounts.length;
    const { replay, evidence } = engine(serverUrl(targetServer), "00000001");
    const result = await replay.replay(artifact, {
      inputs: successfulInputs,
      allowDraftArtifact: true,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "success",
        artifactVersion: "1.0.0",
        outputs: {
          preparation_status: "READY_FOR_REVIEW",
          account_created: false,
          review_receipt: {
            member: "M-20017",
            product: "Growth Savings",
            nickname: "Emergency Fund",
            deposit: "125.00",
            fundingAccount: "Essential Checking \u2014 checking ending 9021",
          },
        },
      }),
    );
    expect(target.fixtures.findMember("M-20017")?.accounts.length).toBe(accountCount);
    const directory = evidence.directory;
    expect(directory).toBeDefined();
    const eventLog = await readFile(path.join(directory ?? "", "events.jsonl"), "utf8");
    for (const value of Object.values(successfulInputs)) expect(eventLog).not.toContain(value);
    expect(eventLog).toContain('"type":"CHECKPOINT_VALIDATED"');
  });

  it("returns MEMBER_NOT_FOUND as a terminal business outcome", async () => {
    const { replay } = engine(serverUrl(targetServer), "00000002");
    const result = await replay.replay(artifact, {
      inputs: { ...successfulInputs, member_id: "M-99999" },
      allowDraftArtifact: true,
    });

    expect(result).toMatchObject({ status: "business_outcome", code: "MEMBER_NOT_FOUND" });
  });

  it("fails closed with evidence when the recorded target is ambiguous", async () => {
    const accountCount = ambiguousTarget.fixtures.findMember("M-20017")?.accounts.length;
    const { replay } = engine(serverUrl(ambiguousServer), "00000003");
    const result = await replay.replay(artifact, {
      inputs: successfulInputs,
      allowDraftArtifact: true,
    });

    expect(result).toMatchObject({
      status: "failure",
      code: "TARGET_AMBIGUOUS",
      stepId: "step-12",
      expectedCount: 1,
      observedCount: 2,
    });
    if (result.status !== "failure") throw new Error("Expected replay failure");
    expect(result.attemptedStrategies).toHaveLength(1);
    expect(result.evidenceRefs).toHaveLength(1);
    expect(ambiguousTarget.fixtures.findMember("M-20017")?.accounts.length).toBe(accountCount);
  });

  it("pauses at a human-owned interruption without replacing the live surface", async () => {
    const { replay } = engine(serverUrl(interruptedServer), "00000004");
    const result = await replay.replay(artifact, {
      inputs: successfulInputs,
      allowDraftArtifact: true,
    });

    expect(result).toMatchObject({
      status: "intervention_required",
      stepId: "step-12",
    });
    const liveSurface = surfaces.at(-1);
    await expect(liveSurface?.observe()).resolves.toMatchObject({
      pageState: "human-verification-required",
    });
  });
});
