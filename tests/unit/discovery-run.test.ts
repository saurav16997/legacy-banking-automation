import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgentTurnLimitError,
  type DiscoveryAgentRunRequest,
  type DiscoveryAgentRunner,
} from "../../src/discovery/agent-runner.js";
import { createCanonicalInputVault } from "../../src/discovery/input-vault.js";
import { runDiscovery } from "../../src/discovery/run.js";
import { FakeSurfaceAdapter, makeObservation } from "../helpers/fake-surface.js";

describe("discovery run limits and terminal behavior", () => {
  const temporaryDirectories: string[] = [];

  async function temporaryEvidenceRoot(): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), "legacy-banking-discovery-"));
    temporaryDirectories.push(directory);
    return directory;
  }

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map(async (directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("maps the model-turn limit to MAX_STEPS and closes the surface", async () => {
    const adapter = new FakeSurfaceAdapter();
    const runner: DiscoveryAgentRunner = {
      run: () => Promise.reject(new AgentTurnLimitError()),
    };
    const result = await runDiscovery({
      adapter,
      agentRunner: runner,
      vault: createCanonicalInputVault("secret-password"),
      model: "offline-test-model",
      evidenceRoot: await temporaryEvidenceRoot(),
      runId: "max-turns-test",
    });
    expect(result.trajectory.finalStatus).toBe("MAX_STEPS");
    expect(adapter.screenshotRedactions).toHaveLength(2);
    for (const redactions of adapter.screenshotRedactions) {
      expect(redactions).toEqual(
        expect.arrayContaining([
          "secret-password",
          "M-10042",
          "Morgan Redwood",
          "Vacation Fund",
          "250.00",
          "1842",
        ]),
      );
    }
    expect(adapter.closed).toBe(true);
  });

  it("enforces the elapsed timeout and closes the surface", async () => {
    const adapter = new FakeSurfaceAdapter();
    const runner: DiscoveryAgentRunner = {
      run: () => new Promise(() => undefined),
    };
    const result = await runDiscovery({
      adapter,
      agentRunner: runner,
      vault: createCanonicalInputVault("secret-password"),
      model: "offline-test-model",
      evidenceRoot: await temporaryEvidenceRoot(),
      limits: { maxDurationMs: 15 },
      runId: "timeout-test",
    });
    expect(result.trajectory.finalStatus).toBe("TIMED_OUT");
    expect(adapter.closed).toBe(true);
  });

  it("rejects a premature completion claim", async () => {
    const adapter = new FakeSurfaceAdapter();
    const runner: DiscoveryAgentRunner = {
      run: async (request: DiscoveryAgentRunRequest) => {
        await request.tools.complete_discovery();
        return { status: "SUCCESS", summary: "claimed success" };
      },
    };
    const result = await runDiscovery({
      adapter,
      agentRunner: runner,
      vault: createCanonicalInputVault("secret-password"),
      model: "offline-test-model",
      evidenceRoot: await temporaryEvidenceRoot(),
      runId: "premature-test",
    });
    expect(result.trajectory.finalStatus).toBe("FAILED");
    expect(result.trajectory.completionValidation?.passed).toBe(false);
  });

  it("classifies an agent return before the first tool call", async () => {
    const adapter = new FakeSurfaceAdapter();
    const runner: DiscoveryAgentRunner = {
      run: () => Promise.resolve({ status: "FAILED", summary: "gave up before observing" }),
    };
    const result = await runDiscovery({
      adapter,
      agentRunner: runner,
      vault: createCanonicalInputVault("secret-password"),
      model: "offline-test-model",
      evidenceRoot: await temporaryEvidenceRoot(),
      runId: "no-tool-test",
    });
    expect(result.trajectory.failure).toEqual({
      category: "INVALID_AGENT_OUTPUT",
      stage: "BEFORE_FIRST_TOOL_CALL",
      errorType: "DiscoveryAgentOutputError",
    });
    expect(result.trajectory.terminalReason).toContain("INVALID_AGENT_OUTPUT");
  });

  it("preserves safe API diagnostics without persisting the provider message", async () => {
    const adapter = new FakeSurfaceAdapter();
    const apiError = Object.assign(new Error("message containing api-key-secret"), {
      status: 404,
      code: "model_not_found",
      type: "invalid_request_error",
      param: "model",
    });
    const runner: DiscoveryAgentRunner = {
      run: () => Promise.reject(apiError),
    };
    const result = await runDiscovery({
      adapter,
      agentRunner: runner,
      vault: createCanonicalInputVault("secret-password"),
      model: "unavailable-test-model",
      evidenceRoot: await temporaryEvidenceRoot(),
      runId: "model-unavailable-test",
    });
    expect(result.trajectory.failure).toEqual({
      category: "MODEL_UNAVAILABLE",
      stage: "DURING_MODEL_REQUEST",
      errorType: "Error",
      apiStatus: 404,
      apiCode: "model_not_found",
      apiType: "invalid_request_error",
    });
    expect(JSON.stringify(result.trajectory)).not.toContain("api-key-secret");
    const summary = await readFile(path.join(result.evidenceDirectory, "summary.json"), "utf8");
    expect(summary).toContain('"category": "MODEL_UNAVAILABLE"');
    expect(summary).not.toContain("api-key-secret");
  });

  it("stops after BLOCKED without allowing a scripted bypass attempt", async () => {
    const blockedElement = {
      elementRef: "element-001",
      semanticTarget: { role: "button" as const, accessibleName: "Open Account" },
      elementType: "button" as const,
      availableOptions: [],
      disabled: false,
      controlOwner: "NONE" as const,
      actionRisk: "IRREVERSIBLE" as const,
      sensitive: false,
    };
    const observation = makeObservation({ elements: [blockedElement] });
    const adapter = new FakeSurfaceAdapter(observation);
    adapter.executeHandler = () => ({
      status: "BLOCKED",
      message: "irreversible",
      observation,
    });
    let bypassAttempted = false;
    const runner: DiscoveryAgentRunner = {
      run: async (request) => {
        await request.tools.click_element({
          observationId: observation.observationId,
          elementRef: blockedElement.elementRef,
        });
        bypassAttempted = true;
        return { status: "SUCCESS", summary: "should not happen" };
      },
    };
    const result = await runDiscovery({
      adapter,
      agentRunner: runner,
      vault: createCanonicalInputVault("secret-password"),
      model: "offline-test-model",
      evidenceRoot: await temporaryEvidenceRoot(),
      runId: "blocked-test",
    });
    expect(result.trajectory.finalStatus).toBe("BLOCKED");
    expect(bypassAttempted).toBe(false);
    expect(adapter.commands).toHaveLength(1);
  });

  it("stops at HANDOFF_REQUIRED and preserves a single attempted action", async () => {
    const humanElement = {
      elementRef: "element-001",
      semanticTarget: { role: "textbox" as const, accessibleName: "Verification code" },
      elementType: "input" as const,
      currentValue: "[REDACTED]",
      availableOptions: [],
      disabled: false,
      controlOwner: "HUMAN" as const,
      actionRisk: "SENSITIVE" as const,
      sensitive: true,
    };
    const observation = makeObservation({
      pageState: "human-verification-required",
      elements: [humanElement],
    });
    const adapter = new FakeSurfaceAdapter(observation);
    adapter.executeHandler = () => ({
      status: "HANDOFF_REQUIRED",
      message: "human owned",
      observation,
    });
    let continued = false;
    const runner: DiscoveryAgentRunner = {
      run: async (request) => {
        await request.tools.fill_element_from_input({
          observationId: observation.observationId,
          elementRef: humanElement.elementRef,
          inputRef: "portal_password",
        });
        continued = true;
        return { status: "FAILED", summary: "should not continue" };
      },
    };
    const result = await runDiscovery({
      adapter,
      agentRunner: runner,
      vault: createCanonicalInputVault("secret-password"),
      model: "offline-test-model",
      evidenceRoot: await temporaryEvidenceRoot(),
      runId: "handoff-test",
    });
    expect(result.trajectory.finalStatus).toBe("HANDOFF_REQUIRED");
    expect(continued).toBe(false);
    expect(adapter.commands).toHaveLength(1);
    expect(adapter.closed).toBe(true);
  });
});
