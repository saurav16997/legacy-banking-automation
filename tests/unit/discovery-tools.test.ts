import { describe, expect, it } from "vitest";

import type { ObservedElement } from "../../src/domain/index.js";
import { createCanonicalInputVault } from "../../src/discovery/input-vault.js";
import { DiscoveryStopError, DiscoveryToolController } from "../../src/discovery/tools.js";
import { FakeSurfaceAdapter, makeObservation } from "../helpers/fake-surface.js";

function observedElement(overrides: Partial<ObservedElement> = {}): ObservedElement {
  return {
    elementRef: "element-001",
    semanticTarget: { role: "textbox", accessibleName: "Member ID", label: "Member ID" },
    elementType: "input",
    currentValue: "[REDACTED]",
    availableOptions: [],
    disabled: false,
    controlOwner: "AUTOMATION",
    actionRisk: "SENSITIVE",
    sensitive: true,
    ...overrides,
  };
}

function controllerFor(
  adapter: FakeSurfaceAdapter,
  options: { now?: () => number; maxActions?: number; maxRepeated?: number } = {},
): DiscoveryToolController {
  return new DiscoveryToolController({
    adapter,
    vault: createCanonicalInputVault("never-record-this-password"),
    limits: {
      maxModelTurns: 5,
      maxBrowserActions: options.maxActions ?? 10,
      maxDurationMs: 1_000,
      maxRepeatedActions: options.maxRepeated ?? 2,
    },
    startedAtMs: 0,
    initialObservation: adapter.observation,
    captureEvidence: () => Promise.resolve(undefined),
    now: options.now ?? (() => 1),
  });
}

describe("discovery tool controller", () => {
  it("rejects stale references locally before vault resolution or browser interaction", async () => {
    const observation = makeObservation({ elements: [observedElement()] });
    const adapter = new FakeSurfaceAdapter(observation);
    const controller = controllerFor(adapter);

    const result = (await controller.fill_element_from_input({
      observationId: crypto.randomUUID(),
      elementRef: "element-999",
      inputRef: "member_id",
    })) as { status: string };
    expect(result.status).toBe("STALE_OBSERVATION");
    expect(adapter.commands).toHaveLength(0);
    expect(controller.events[0]?.sanitizedResult.status).toBe("STALE_OBSERVATION");
  });

  it("fails closed for unknown input references without exposing sensitive values", async () => {
    const observation = makeObservation({ elements: [observedElement()] });
    const adapter = new FakeSurfaceAdapter(observation);
    const controller = controllerFor(adapter);

    await expect(
      controller.fill_element_from_input({
        observationId: observation.observationId,
        elementRef: "element-001",
        inputRef: "invented_secret",
      }),
    ).rejects.toMatchObject({ status: "BLOCKED" });
    expect(JSON.stringify(controller.events)).not.toContain("never-record-this-password");
    expect(adapter.commands).toHaveLength(0);
  });

  it("propagates HANDOFF_REQUIRED and BLOCKED without a bypass action", async () => {
    const human = observedElement({ controlOwner: "HUMAN", actionRisk: "SENSITIVE" });
    const observation = makeObservation({ elements: [human] });
    const handoffAdapter = new FakeSurfaceAdapter(observation);
    handoffAdapter.executeHandler = () => ({
      status: "HANDOFF_REQUIRED",
      message: "human owned",
      observation,
    });
    const handoffController = controllerFor(handoffAdapter);
    await expect(
      handoffController.fill_element_from_input({
        observationId: observation.observationId,
        elementRef: human.elementRef,
        inputRef: "portal_password",
      }),
    ).rejects.toMatchObject({ status: "HANDOFF_REQUIRED" });
    expect(handoffAdapter.commands).toHaveLength(1);

    const none = observedElement({
      semanticTarget: { role: "button", accessibleName: "Open Account" },
      elementType: "button",
      controlOwner: "NONE",
      actionRisk: "IRREVERSIBLE",
      sensitive: false,
    });
    const blockedObservation = makeObservation({ elements: [none] });
    const blockedAdapter = new FakeSurfaceAdapter(blockedObservation);
    blockedAdapter.executeHandler = () => ({
      status: "BLOCKED",
      message: "irreversible",
      observation: blockedObservation,
    });
    const blockedController = controllerFor(blockedAdapter);
    await expect(
      blockedController.click_element({
        observationId: blockedObservation.observationId,
        elementRef: none.elementRef,
      }),
    ).rejects.toMatchObject({ status: "BLOCKED" });
    expect(blockedAdapter.commands).toHaveLength(1);
  });

  it("detects repeated actions and maximum browser actions", async () => {
    let sequence = 1;
    const first = makeObservation({ elements: [observedElement()] });
    const adapter = new FakeSurfaceAdapter(first);
    adapter.executeHandler = () => {
      sequence += 1;
      return {
        status: "EXECUTED",
        message: "executed",
        observation: makeObservation({
          observationId: crypto.randomUUID(),
          elements: [
            observedElement({ elementRef: `element-${String(sequence).padStart(3, "0")}` }),
          ],
        }),
      };
    };
    const repeatedController = controllerFor(adapter, { maxRepeated: 2 });
    for (let index = 0; index < 2; index += 1) {
      const current = repeatedController.latestObservation;
      await repeatedController.click_element({
        observationId: current.observationId,
        elementRef: current.elements[0]?.elementRef ?? "missing",
      });
    }
    const current = repeatedController.latestObservation;
    await expect(
      repeatedController.click_element({
        observationId: current.observationId,
        elementRef: current.elements[0]?.elementRef ?? "missing",
      }),
    ).rejects.toMatchObject({ status: "MAX_STEPS" });

    const maxAdapter = new FakeSurfaceAdapter(first);
    const maxController = controllerFor(maxAdapter, { maxActions: 0 });
    await expect(
      maxController.click_element({
        observationId: first.observationId,
        elementRef: "element-001",
      }),
    ).rejects.toMatchObject({ status: "MAX_STEPS" });
  });

  it("enforces elapsed duration before tool execution", async () => {
    const adapter = new FakeSurfaceAdapter(makeObservation());
    const controller = controllerFor(adapter, { now: () => 1_001 });
    await expect(controller.observe_surface()).rejects.toBeInstanceOf(DiscoveryStopError);
    expect(adapter.commands).toHaveLength(0);
  });
});
