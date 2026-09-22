import { randomUUID } from "node:crypto";

import { SurfaceTimeoutError, type SurfaceAdapter } from "../browser/index.js";
import {
  CAPABILITY_ARTIFACT_SCHEMA_VERSION,
  type ArtifactStep,
  type CapabilityArtifact,
  type CapabilityCondition,
  type TargetRecipe,
  type TargetStrategy,
} from "../compiler/contracts.js";
import { canonicalJson, sha256 } from "../compiler/canonical-json.js";
import type { ObservedElement, SurfaceCommand, SurfaceObservation } from "../domain/index.js";
import {
  HandoffCoordinator,
  type HandoffBinding,
  type HandoffGrant,
  type HandoffResumeRequest,
} from "../handoff/index.js";
import type {
  ReplayAbandonReason,
  ReplayBusinessOutcomeResult,
  ReplayEngineOptions,
  ReplayEvidenceEvent,
  ReplayEvidenceSink,
  ReplayFailureCode,
  ReplayFailureResult,
  ReplayHandoffNotCompletedResult,
  ReplayInterventionRequiredResult,
  ReplayRequest,
  ReplayResult,
  ReplayResumeRejectedResult,
  ReplaySessionState,
  ReplaySuccessResult,
} from "./contracts.js";
import { NullReplayEvidenceSink } from "./evidence.js";

interface ResolutionSuccess {
  readonly kind: "RESOLVED";
  readonly element: ObservedElement;
}

interface ResolutionFailure {
  readonly kind: "NOT_FOUND" | "AMBIGUOUS";
  readonly observedCount: number;
}

type TargetResolution = ResolutionSuccess | ResolutionFailure;

interface ExecutedAction {
  readonly role: ObservedElement["semanticTarget"]["role"];
  readonly accessibleName: string;
  readonly owner: ObservedElement["controlOwner"];
}

interface ReplayRuntime {
  readonly artifact: CapabilityArtifact;
  readonly request: ReplayRequest;
  readonly runId: string;
  readonly startedAt: string;
  readonly artifactSha256: string;
  readonly draftOverride: boolean;
  readonly executed: ExecutedAction[];
  observation?: SurfaceObservation;
  nextStepIndex: number;
  automationRemainingMs: number;
  activeHandoff?: Pick<HandoffGrant, "handoffId" | "expiresAt">;
}

function timestampForRun(now: number): string {
  return new Date(now)
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
}

function defaultRunId(now: number): string {
  return `replay-${timestampForRun(now)}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function urlWithoutQuery(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid-url";
  }
}

function runtimeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function runtimeBoolean(value: unknown): boolean {
  return value === true;
}

function isSurfaceTimeout(error: unknown): boolean {
  return (
    error instanceof SurfaceTimeoutError ||
    (error instanceof Error && error.name === "TimeoutError")
  );
}

function isRetrySafeStep(step: ArtifactStep): boolean {
  return (
    runtimeBoolean(step.retry.idempotentOnly) &&
    (step.operation === "FILL" || step.operation === "SELECT_OPTION") &&
    step.target.expectedOwnership === "AUTOMATION" &&
    step.target.expectedRisk !== "IRREVERSIBLE"
  );
}

export function surfaceFingerprint(observation: SurfaceObservation): string {
  return sha256(
    canonicalJson({
      url: urlWithoutQuery(observation.url),
      title: observation.title,
      primaryHeading: observation.primaryHeading ?? null,
      pageState: observation.pageState ?? null,
      elements: observation.elements.map((element) => ({
        target: element.semanticTarget,
        owner: element.controlOwner,
        risk: element.actionRisk,
        disabled: element.disabled,
      })),
    }),
  );
}

function matchesStrategy(element: ObservedElement, strategy: TargetStrategy): boolean {
  if (strategy.kind === "TRUSTED_CONTROL_ID") {
    return element.semanticTarget.testId === strategy.controlId;
  }
  if (strategy.kind === "EXACT_LABEL") {
    return element.semanticTarget.label === strategy.label;
  }
  return (
    element.semanticTarget.role === strategy.role &&
    element.semanticTarget.accessibleName === strategy.accessibleName
  );
}

function resolveTarget(observation: SurfaceObservation, target: TargetRecipe): TargetResolution {
  let lastCount = 0;
  for (const strategy of target.strategies) {
    if (strategy.pageState !== observation.pageState) continue;
    const matches = observation.elements.filter((element) => matchesStrategy(element, strategy));
    lastCount = matches.length;
    if (matches.length > 1) return { kind: "AMBIGUOUS", observedCount: matches.length };
    const match = matches[0];
    if (match) return { kind: "RESOLVED", element: match };
  }
  return { kind: "NOT_FOUND", observedCount: lastCount };
}

function validateInputs(
  artifact: CapabilityArtifact,
  inputs: Readonly<Record<string, string>>,
): string | undefined {
  const declared = new Set(artifact.inputs.map((input) => input.name));
  const unknown = Object.keys(inputs).find((name) => !declared.has(name));
  if (unknown) return `Input ${unknown} is not declared by the artifact.`;
  for (const input of artifact.inputs) {
    const value = inputs[input.name];
    if (typeof value !== "string" || value.length === 0) {
      return `Required input ${input.name} must be a non-empty string.`;
    }
    if (input.pattern && !new RegExp(input.pattern, "u").test(value)) {
      return `Input ${input.name} does not match its declared format.`;
    }
  }
  return undefined;
}

function renderBusinessTemplate(
  template: string,
  bindings: Readonly<Record<string, string>>,
  inputs: Readonly<Record<string, string>>,
): string {
  return Object.entries(bindings).reduce(
    (rendered, [placeholder, inputRef]) =>
      rendered.replaceAll(`{${placeholder}}`, inputs[inputRef] ?? ""),
    template,
  );
}

function detectBusinessOutcome(
  artifact: CapabilityArtifact,
  observation: SurfaceObservation,
  inputs: Readonly<Record<string, string>>,
): "MEMBER_NOT_FOUND" | undefined {
  for (const outcome of artifact.outcomes.businessOutcomes) {
    const [pageStateCondition, textCondition] = outcome.detector.conditions;
    if (
      observation.pageState === pageStateCondition.pageState &&
      observation.visibleText.includes(
        renderBusinessTemplate(textCondition.template, textCondition.bindings, inputs),
      )
    ) {
      return outcome.code;
    }
  }
  return undefined;
}

function isHumanInterruption(observation: SurfaceObservation): boolean {
  return (
    observation.pageState === "human-verification-required" ||
    observation.elements.some((element) => element.controlOwner === "HUMAN")
  );
}

function evaluateCondition(
  condition: CapabilityCondition,
  observation: SurfaceObservation,
  inputs: Readonly<Record<string, string>>,
  executed: readonly ExecutedAction[],
): boolean {
  switch (condition.kind) {
    case "PAGE_STATE_EQUALS":
      return observation.pageState === condition.pageState;
    case "HEADING_EQUALS":
      return observation.primaryHeading === condition.heading;
    case "REVIEW_FIELD_MATCHES_INPUT": {
      const expected = inputs[condition.inputRef];
      return (
        expected !== undefined &&
        observation.visibleText.includes(condition.field) &&
        observation.visibleText.includes(expected)
      );
    }
    case "TEXT_CONTAINS":
      return observation.visibleText.includes(condition.text);
    case "CONTROL_PRESENT": {
      const resolved = resolveTarget(observation, condition.target);
      return (
        resolved.kind === "RESOLVED" &&
        resolved.element.controlOwner === condition.target.expectedOwnership &&
        resolved.element.actionRisk === condition.target.expectedRisk
      );
    }
    case "NO_EXECUTED_TARGET":
      return !executed.some(
        (action) =>
          action.role === condition.role && action.accessibleName === condition.accessibleName,
      );
    case "NO_EXECUTED_OWNERS":
      return !executed.some((action) =>
        condition.owners.includes(action.owner as "HUMAN" | "NONE"),
      );
  }
}

function selectOptionValue(element: ObservedElement, requested: string): string | undefined {
  const matches = element.availableOptions.filter(
    (option) => !option.disabled && (option.value === requested || option.label === requested),
  );
  return matches.length === 1 ? matches[0]?.value : undefined;
}

function makeCommand(
  step: ArtifactStep,
  observation: SurfaceObservation,
  element: ObservedElement,
  inputs: Readonly<Record<string, string>>,
): SurfaceCommand | undefined {
  if (step.operation === "CLICK") {
    return {
      operation: "click",
      observationId: observation.observationId,
      elementRef: element.elementRef,
    };
  }
  const value = step.inputRef ? inputs[step.inputRef] : undefined;
  if (value === undefined) return undefined;
  if (step.operation === "FILL") {
    return {
      operation: "fill",
      observationId: observation.observationId,
      elementRef: element.elementRef,
      value,
    };
  }
  const option = selectOptionValue(element, value);
  if (option === undefined) return undefined;
  return {
    operation: "selectOption",
    observationId: observation.observationId,
    elementRef: element.elementRef,
    option,
  };
}

function successOutputs(
  artifact: CapabilityArtifact,
  inputs: Readonly<Record<string, string>>,
): ReplaySuccessResult["outputs"] {
  const receipt = Object.fromEntries(
    artifact.outputs.success.reviewReceipt.fields.map((field) => {
      if (field.source.kind !== "VALIDATED_INPUT") return [field.name, ""];
      return [field.name, inputs[field.source.inputRef] ?? ""];
    }),
  );
  return {
    preparation_status: artifact.outputs.success.status.value,
    account_created: false,
    review_receipt: receipt,
  };
}

/** One deterministic replay session, including an optional in-process human pause. */
export class ReplayEngine {
  readonly #surface: SurfaceAdapter;
  readonly #evidence: ReplayEvidenceSink;
  readonly #now: () => number;
  readonly #createRunId: (() => string) | undefined;
  readonly #replaySessionId = randomUUID();
  readonly #handoff: HandoffCoordinator;
  #eventSequence = 0;
  #state: ReplaySessionState = "CREATED";
  #runtime: ReplayRuntime | undefined;

  constructor(options: ReplayEngineOptions) {
    this.#surface = options.surface;
    this.#evidence = options.evidence ?? new NullReplayEvidenceSink();
    this.#now = options.now ?? Date.now;
    this.#createRunId = options.createRunId;
    this.#handoff = new HandoffCoordinator({
      now: this.#now,
      ...(options.handoffTtlMs !== undefined ? { ttlMs: options.handoffTtlMs } : {}),
      ...(options.createResumeToken ? { createToken: options.createResumeToken } : {}),
      ...(options.createHandoffId ? { createHandoffId: options.createHandoffId } : {}),
    });
  }

  get state(): ReplaySessionState {
    return this.#state;
  }

  async replay(artifact: CapabilityArtifact, request: ReplayRequest): Promise<ReplayResult> {
    if (this.#state !== "CREATED") {
      return this.#resumeRejected("SESSION_NOT_PAUSED", "The replay session has already started.");
    }
    this.#eventSequence = 0;
    this.#state = "RUNNING";
    const startedAtMs = this.#now();
    const runId = this.#createRunId?.() ?? defaultRunId(startedAtMs);
    const lifecycleStatus = runtimeString(artifact.lifecycle.status);
    const runtime: ReplayRuntime = {
      artifact,
      request,
      runId,
      startedAt: new Date(startedAtMs).toISOString(),
      artifactSha256: sha256(canonicalJson(artifact)),
      draftOverride: lifecycleStatus === "DRAFT" && request.allowDraftArtifact === true,
      executed: [],
      nextStepIndex: 0,
      automationRemainingMs: artifact.executionPolicy.maxTotalRuntimeMs,
    };
    this.#runtime = runtime;

    try {
      await this.#evidence.initialize({
        runId,
        capabilityId: artifact.capability.id,
        capabilityVersion: artifact.capability.version,
        artifactSha256: runtime.artifactSha256,
        startedAt: runtime.startedAt,
        draftOverride: runtime.draftOverride,
      });
    } catch {
      this.#state = "FAILED";
      return this.#bareFailure(
        runId,
        artifact,
        "INITIALIZATION_FAILED",
        "Replay evidence could not be initialized.",
      );
    }

    await this.#record({ type: "RUN_STARTED", status: "STARTED" });
    if (
      runtimeString(artifact.schemaVersion) !== CAPABILITY_ARTIFACT_SCHEMA_VERSION ||
      runtimeString(artifact.capability.id) !== "prepare_savings_subaccount" ||
      runtimeString(artifact.surface.kind) !== "LEGACY_WEB"
    ) {
      return this.#terminalFailure(
        "INVALID_ARTIFACT",
        "The artifact identity or schema version is unsupported.",
      );
    }
    if (lifecycleStatus === "DRAFT" && !runtime.draftOverride) {
      return this.#terminalFailure(
        "ARTIFACT_NOT_APPROVED",
        "Draft artifacts require an explicit local demo override.",
      );
    }
    if (lifecycleStatus !== "DRAFT" && lifecycleStatus !== "APPROVED") {
      return this.#terminalFailure(
        "INVALID_ARTIFACT",
        "The artifact lifecycle status is unsupported.",
      );
    }
    const inputError = validateInputs(artifact, request.inputs);
    if (inputError) return this.#terminalFailure("INVALID_INPUT", inputError);

    const globalDeadline = startedAtMs + runtime.automationRemainingMs;
    try {
      runtime.observation = await this.#surface.start({
        timeoutMs: this.#requiredRemainingMs(globalDeadline),
      });
    } catch (error) {
      const timedOut = isSurfaceTimeout(error) || this.#remainingMs(globalDeadline) <= 0;
      return this.#terminalFailure(
        timedOut ? "GLOBAL_TIMEOUT" : "INITIALIZATION_FAILED",
        timedOut
          ? "Replay exhausted its global runtime while starting the bounded surface."
          : "The bounded browser surface could not be started.",
      );
    }
    const initialObservation = runtime.observation;
    const failedInitialPrecondition = artifact.preconditions.find(
      (condition) =>
        !evaluateCondition(condition, initialObservation, request.inputs, runtime.executed),
    );
    if (failedInitialPrecondition) {
      return this.#terminalFailure(
        "UNEXPECTED_PAGE_STATE",
        `Initial precondition ${failedInitialPrecondition.id} failed.`,
        null,
        artifact.surface.entryPoint.expectedInitialPageState,
        initialObservation.pageState ?? "missing",
      );
    }
    return this.#executeFrom(globalDeadline);
  }

  async resume(request: HandoffResumeRequest): Promise<ReplayResult> {
    const runtime = this.#runtime;
    if (!runtime) {
      return this.#resumeRejected("SESSION_NOT_PAUSED", "The replay session has not started.");
    }
    const validation = this.#handoff.validate(request);
    if (!validation.valid) {
      if (validation.code === "HANDOFF_EXPIRED" && this.#state === "PAUSED_FOR_HUMAN") {
        await this.#record({
          type: "HANDOFF_EXPIRED",
          handoffId: request.handoffId,
          code: validation.code,
          status: "failure",
        });
        return this.#terminalFailure(
          "HANDOFF_EXPIRED",
          "The human-handoff window expired before deterministic replay resumed.",
          runtime.artifact.steps[runtime.nextStepIndex - 1]?.id ?? null,
        );
      }
      return this.#resumeRejected(validation.code, "The resume request was rejected.");
    }
    if (this.#state !== "PAUSED_FOR_HUMAN") {
      return this.#resumeRejected("SESSION_NOT_PAUSED", "The replay session is not paused.");
    }
    const binding = validation.binding;
    if (this.#surface.surfaceSessionId() !== binding.surfaceSessionId) {
      this.#handoff.terminate("ABANDONED");
      return await this.#terminalFailure(
        "UNEXPECTED_POST_HANDOFF_STATE",
        "The live surface session no longer matches the paused handoff.",
        runtime.artifact.steps[runtime.nextStepIndex - 1]?.id ?? null,
      );
    }
    await this.#record({
      type: "RESUME_REQUESTED",
      handoffId: request.handoffId,
      checkpointSha256: binding.checkpointSha256,
      completedStepIds: binding.completedStepIds,
      status: "requested",
    });

    if (runtime.automationRemainingMs <= 0) {
      return this.#terminalFailure(
        "GLOBAL_TIMEOUT",
        "Replay has no automation runtime remaining for the resume observation.",
        runtime.artifact.steps[runtime.nextStepIndex - 1]?.id ?? null,
      );
    }

    const observationStartedAt = this.#now();
    const observationTimeout = Math.min(
      runtime.automationRemainingMs,
      runtime.artifact.executionPolicy.defaultStepTimeoutMs,
    );
    let observation: SurfaceObservation;
    try {
      observation = await this.#surface.observe({ timeoutMs: observationTimeout });
    } catch (error) {
      return await this.#terminalFailure(
        isSurfaceTimeout(error) ? "GLOBAL_TIMEOUT" : "SESSION_LOSS",
        "The paused surface could not be freshly observed during resume.",
        runtime.artifact.steps[runtime.nextStepIndex - 1]?.id ?? null,
      );
    } finally {
      runtime.automationRemainingMs = Math.max(
        0,
        runtime.automationRemainingMs - Math.max(0, this.#now() - observationStartedAt),
      );
    }
    runtime.observation = observation;
    if (this.#surface.surfaceSessionId() !== binding.surfaceSessionId) {
      this.#handoff.terminate("ABANDONED");
      return this.#terminalFailure(
        "UNEXPECTED_POST_HANDOFF_STATE",
        "The live surface session changed during resume validation.",
        runtime.artifact.steps[runtime.nextStepIndex - 1]?.id ?? null,
      );
    }
    if (
      observation.pageState === binding.expectedHumanPageState &&
      isHumanInterruption(observation)
    ) {
      await this.#record({
        type: "HANDOFF_NOT_COMPLETED",
        handoffId: request.handoffId,
        ownership: "HUMAN",
        checkpointSha256: binding.checkpointSha256,
        completedStepIds: binding.completedStepIds,
        ...(observation.pageState ? { pageState: observation.pageState } : {}),
        surfaceFingerprint: surfaceFingerprint(observation),
        status: "paused",
      });
      const result: ReplayHandoffNotCompletedResult = {
        status: "handoff_not_completed",
        code: "HANDOFF_NOT_COMPLETED",
        handoffId: request.handoffId,
        stepId: runtime.artifact.steps[runtime.nextStepIndex - 1]?.id ?? "handoff",
        reason: "Human verification is still required in the open browser session.",
        expiresAt: runtime.activeHandoff?.expiresAt ?? new Date(0).toISOString(),
        runId: runtime.runId,
        artifactVersion: runtime.artifact.capability.version,
      };
      return result;
    }
    if (observation.pageState !== binding.expectedPostHumanPageState) {
      this.#handoff.terminate("ABANDONED");
      return this.#terminalFailure(
        "UNEXPECTED_POST_HANDOFF_STATE",
        "The live surface did not reach the bounded post-human checkpoint.",
        runtime.artifact.steps[runtime.nextStepIndex - 1]?.id ?? null,
        binding.expectedPostHumanPageState,
        observation.pageState ?? "missing",
      );
    }

    this.#handoff.consume();
    await this.#record({
      type: "HANDOFF_COMPLETED",
      handoffId: request.handoffId,
      ownership: "HUMAN",
      checkpointSha256: binding.checkpointSha256,
      completedStepIds: binding.completedStepIds,
      ...(observation.pageState ? { pageState: observation.pageState } : {}),
      surfaceFingerprint: surfaceFingerprint(observation),
      status: "completed",
    });
    this.#state = "RUNNING";
    await this.#record({
      type: "REPLAY_RESUMED",
      handoffId: request.handoffId,
      checkpointSha256: binding.checkpointSha256,
      completedStepIds: binding.completedStepIds,
      status: "running",
    });
    const globalDeadline = this.#now() + runtime.automationRemainingMs;
    return this.#executeFrom(globalDeadline);
  }

  async abandon(reason: ReplayAbandonReason): Promise<ReplayFailureResult | undefined> {
    const runtime = this.#runtime;
    if (!runtime || this.#state !== "PAUSED_FOR_HUMAN") return undefined;
    const expired = reason === "EXPIRED";
    this.#handoff.terminate(expired ? "EXPIRED" : "ABANDONED");
    await this.#record({
      type: expired ? "HANDOFF_EXPIRED" : "HANDOFF_ABANDONED",
      ...(runtime.activeHandoff ? { handoffId: runtime.activeHandoff.handoffId } : {}),
      code: expired ? "HANDOFF_EXPIRED" : "HANDOFF_ABANDONED",
      status: "failure",
      message: expired
        ? "The bounded handoff TTL expired."
        : "The operator acknowledgement channel ended before resume.",
    });
    const result = await this.#terminalFailure(
      expired ? "HANDOFF_EXPIRED" : "HANDOFF_ABANDONED",
      expired ? "The human-handoff window expired." : "The human handoff was safely abandoned.",
      runtime.artifact.steps[runtime.nextStepIndex - 1]?.id ?? null,
    );
    await this.#surface.close();
    this.#state = "CLOSED";
    return result;
  }

  async close(): Promise<void> {
    if (this.#state === "CLOSED") return;
    if (this.#state === "PAUSED_FOR_HUMAN") {
      await this.abandon("CALLER_CLOSED");
      return;
    }
    await this.#surface.close();
    this.#state = "CLOSED";
  }

  async #executeFrom(globalDeadline: number): Promise<ReplayResult> {
    const runtime = this.#requiredRuntime();
    const { artifact, request } = runtime;
    let observation = runtime.observation;
    if (!observation) {
      return this.#terminalFailure("SESSION_LOSS", "The replay surface has no observation.");
    }

    const startingStepIndex = runtime.nextStepIndex;
    for (const [offset, step] of artifact.steps.slice(startingStepIndex).entries()) {
      const stepIndex = startingStepIndex + offset;
      if (this.#remainingMs(globalDeadline) <= 0) {
        return this.#terminalFailure(
          "GLOBAL_TIMEOUT",
          "Replay exhausted its global runtime before the next step.",
          step.id,
        );
      }
      const priorOutcome = detectBusinessOutcome(artifact, observation, request.inputs);
      if (priorOutcome) return this.#businessOutcome(priorOutcome, observation);

      const maxAttempts = Math.min(
        step.retry.maxAttempts,
        artifact.executionPolicy.maxStepAttempts,
      );
      let completed = false;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const attemptStartedAt = this.#now();
        const attemptDeadline = Math.min(globalDeadline, attemptStartedAt + step.timeoutMs);
        const effectiveTimeoutMs = Math.max(0, attemptDeadline - attemptStartedAt);
        let attemptTimedOut = false;
        let timeoutMessage = "The replay attempt exceeded its declared timeout.";

        try {
          observation = await this.#surface.observe({
            timeoutMs: this.#requiredRemainingMs(attemptDeadline),
          });
          runtime.observation = observation;
        } catch (error) {
          if (!isSurfaceTimeout(error)) {
            return this.#terminalFailure(
              "SESSION_LOSS",
              "The surface could not be observed before the step.",
              step.id,
            );
          }
          attemptTimedOut = true;
          timeoutMessage = "The precondition observation exceeded the bounded attempt timeout.";
        }

        if (!attemptTimedOut && observation.pageState !== step.expectedStartingPageState) {
          if (isHumanInterruption(observation)) {
            return this.#pauseForHuman(
              step,
              stepIndex,
              observation,
              step.expectedStartingPageState,
              globalDeadline,
            );
          }
          return this.#terminalFailure(
            "UNEXPECTED_PAGE_STATE",
            "The step starting page state did not match the artifact.",
            step.id,
            step.expectedStartingPageState,
            observation.pageState ?? "missing",
          );
        }

        const resolution = attemptTimedOut ? undefined : resolveTarget(observation, step.target);
        if (resolution && resolution.kind !== "RESOLVED") {
          const code = resolution.kind === "AMBIGUOUS" ? "TARGET_AMBIGUOUS" : "TARGET_NOT_FOUND";
          return this.#terminalFailure(
            code,
            resolution.kind === "AMBIGUOUS"
              ? "The ordered target strategy resolved to multiple controls."
              : "No ordered target strategy resolved to a control.",
            step.id,
            "exactly one acceptable target",
            `${String(resolution.observedCount)} matching targets`,
            step.target.strategies,
            resolution.observedCount,
          );
        }

        const element = resolution?.kind === "RESOLVED" ? resolution.element : undefined;
        if (element?.disabled) {
          return this.#terminalFailure(
            "TARGET_UNAVAILABLE",
            "The resolved target is disabled.",
            step.id,
          );
        }
        if (
          element &&
          (element.controlOwner !== step.target.expectedOwnership ||
            element.actionRisk !== step.target.expectedRisk ||
            element.controlOwner !== "AUTOMATION" ||
            element.actionRisk === "IRREVERSIBLE" ||
            artifact.safetyPolicy.forbiddenTargets.some(
              (target) =>
                target.role === element.semanticTarget.role &&
                target.accessibleName === element.semanticTarget.accessibleName,
            ))
        ) {
          return this.#terminalFailure(
            "POLICY_VIOLATION",
            "The live target classification is not authorized by the artifact.",
            step.id,
          );
        }

        const command = element
          ? makeCommand(step, observation, element, request.inputs)
          : undefined;
        if (!attemptTimedOut && !command) {
          return this.#terminalFailure(
            "INVALID_INPUT",
            "The input cannot be applied to the resolved control.",
            step.id,
          );
        }
        if (!attemptTimedOut && this.#remainingMs(attemptDeadline) <= 0) attemptTimedOut = true;

        if (!attemptTimedOut && command && element) {
          await this.#record({
            type: "STEP_ATTEMPTED",
            stepId: step.id,
            operation: step.operation,
            ...(step.inputRef ? { inputRef: step.inputRef } : {}),
            attempt,
            effectiveTimeoutMs,
            ...(observation.pageState ? { pageState: observation.pageState } : {}),
            surfaceFingerprint: surfaceFingerprint(observation),
          });
          const actionResult = await this.#surface.execute(command, {
            timeoutMs: this.#requiredRemainingMs(attemptDeadline),
          });
          if (actionResult.status === "EXECUTED") {
            runtime.executed.push({
              role: element.semanticTarget.role,
              accessibleName: element.semanticTarget.accessibleName,
              owner: element.controlOwner,
            });
            runtime.nextStepIndex = stepIndex + 1;
            try {
              observation =
                actionResult.observation ??
                (await this.#surface.observe({
                  timeoutMs: this.#requiredRemainingMs(attemptDeadline),
                }));
              runtime.observation = observation;
            } catch (error) {
              if (!isSurfaceTimeout(error)) {
                return this.#terminalFailure(
                  "SESSION_LOSS",
                  "The surface could not be observed after the action.",
                  step.id,
                );
              }
              attemptTimedOut = true;
              timeoutMessage = "The post-action observation exceeded the bounded attempt timeout.";
            }
            if (!attemptTimedOut && this.#remainingMs(attemptDeadline) <= 0) {
              attemptTimedOut = true;
            }
            if (!attemptTimedOut) {
              await this.#record({
                type: "STEP_EXECUTED",
                stepId: step.id,
                operation: step.operation,
                ...(step.inputRef ? { inputRef: step.inputRef } : {}),
                attempt,
                ...(observation.pageState ? { pageState: observation.pageState } : {}),
                status: actionResult.status,
                surfaceFingerprint: surfaceFingerprint(observation),
              });
              const outcome = detectBusinessOutcome(artifact, observation, request.inputs);
              if (outcome) return this.#businessOutcome(outcome, observation);
              if (observation.pageState !== step.expectedResultingPageState) {
                if (isHumanInterruption(observation)) {
                  return this.#pauseForHuman(
                    step,
                    stepIndex + 1,
                    observation,
                    step.expectedResultingPageState,
                    globalDeadline,
                  );
                }
                return this.#terminalFailure(
                  "UNEXPECTED_PAGE_STATE",
                  "The step postcondition page state did not match the artifact.",
                  step.id,
                  step.expectedResultingPageState,
                  observation.pageState ?? "missing",
                );
              }
              completed = true;
              break;
            }
          } else if (actionResult.status === "TIMED_OUT") {
            attemptTimedOut = true;
            timeoutMessage = actionResult.message;
          } else if (actionResult.status === "HANDOFF_REQUIRED") {
            return this.#pauseForHuman(
              step,
              stepIndex,
              observation,
              step.expectedStartingPageState,
              globalDeadline,
            );
          } else if (actionResult.status === "AMBIGUOUS_TARGET") {
            return this.#terminalFailure(
              "TARGET_AMBIGUOUS",
              actionResult.message,
              step.id,
              "exactly one acceptable target",
              "multiple targets",
              step.target.strategies,
            );
          } else if (actionResult.status === "BLOCKED") {
            return this.#terminalFailure("POLICY_VIOLATION", actionResult.message, step.id);
          } else if (actionResult.status === "STALE_OBSERVATION") {
            const canRetryStale =
              attempt < maxAttempts &&
              isRetrySafeStep(step) &&
              step.retry.retryOn.includes("STALE_TARGET") &&
              this.#remainingMs(globalDeadline) > 0;
            if (!canRetryStale) {
              return this.#terminalFailure("STALE_TARGET", actionResult.message, step.id);
            }
            await this.#record({
              type: "RECOVERY_APPLIED",
              stepId: step.id,
              attempt,
              code: "STALE_TARGET",
              message: "The idempotent step will be re-observed before its bounded retry.",
            });
            continue;
          } else {
            return this.#terminalFailure("SESSION_LOSS", actionResult.message, step.id);
          }
        }

        if (attemptTimedOut) {
          const timeoutScope = this.#remainingMs(globalDeadline) <= 0 ? "GLOBAL" : "ATTEMPT";
          const code: ReplayFailureCode =
            timeoutScope === "GLOBAL" ? "GLOBAL_TIMEOUT" : "TRANSIENT_TIMEOUT";
          await this.#record({
            type: "STEP_TIMED_OUT",
            stepId: step.id,
            operation: step.operation,
            ...(step.inputRef ? { inputRef: step.inputRef } : {}),
            attempt,
            code,
            timeoutScope,
            effectiveTimeoutMs,
            ...(observation.pageState ? { pageState: observation.pageState } : {}),
            surfaceFingerprint: surfaceFingerprint(observation),
            message: timeoutMessage,
          });
          const canRetryTimeout =
            timeoutScope === "ATTEMPT" &&
            attempt < maxAttempts &&
            isRetrySafeStep(step) &&
            step.retry.retryOn.includes("TRANSIENT_TIMEOUT") &&
            this.#remainingMs(globalDeadline) > 0;
          if (canRetryTimeout) {
            await this.#record({
              type: "RECOVERY_APPLIED",
              stepId: step.id,
              attempt,
              code: "TRANSIENT_TIMEOUT",
              message: "The settled idempotent operation will be retried within its bound.",
            });
            continue;
          }
          return this.#terminalFailure(code, timeoutMessage, step.id);
        }
      }
      if (!completed) {
        return this.#terminalFailure(
          "TRANSIENT_TIMEOUT",
          "The step exhausted its bounded attempts.",
          step.id,
        );
      }
    }
    runtime.observation = observation;
    return this.#complete();
  }

  async #pauseForHuman(
    step: ArtifactStep,
    nextStepIndex: number,
    observation: SurfaceObservation,
    expectedPostHumanPageState: string,
    globalDeadline: number,
  ): Promise<ReplayResult> {
    const runtime = this.#requiredRuntime();
    const surfaceSessionId = this.#surface.surfaceSessionId();
    if (!surfaceSessionId) {
      return this.#terminalFailure(
        "SESSION_LOSS",
        "The handoff cannot bind to a live surface session.",
        step.id,
      );
    }
    if (!isHumanInterruption(observation)) {
      return this.#terminalFailure(
        "UNEXPECTED_PAGE_STATE",
        "The surface did not expose a trusted human-owned interruption.",
        step.id,
      );
    }
    runtime.nextStepIndex = nextStepIndex;
    runtime.observation = observation;
    runtime.automationRemainingMs = this.#remainingMs(globalDeadline);
    const completedStepIds = runtime.artifact.steps
      .slice(0, nextStepIndex)
      .map((completedStep) => completedStep.id);
    const checkpointSha256 = sha256(
      canonicalJson({
        artifactSha256: runtime.artifactSha256,
        completedStepIds,
        nextStepIndex,
      }),
    );
    const binding: HandoffBinding = {
      runId: runtime.runId,
      artifactId: runtime.artifact.capability.id,
      artifactVersion: runtime.artifact.capability.version,
      artifactSha256: runtime.artifactSha256,
      replaySessionId: this.#replaySessionId,
      surfaceSessionId,
      checkpointSha256,
      completedStepIds,
      nextStepIndex,
      expectedHumanPageState: observation.pageState ?? "human-verification-required",
      expectedPostHumanPageState,
    };
    const grant = this.#handoff.begin(binding);
    runtime.activeHandoff = { handoffId: grant.handoffId, expiresAt: grant.expiresAt };
    let screenshotRef: string | undefined;
    try {
      const screenshot = await this.#surface.captureScreenshot(
        Object.values(runtime.request.inputs),
      );
      screenshotRef = await this.#evidence.writeScreenshot(`${grant.handoffId}-paused`, screenshot);
    } catch {
      // The typed handoff remains valid when optional screenshot capture fails.
    }
    const interimRef = await this.#evidence.writeInterimHandoff({
      handoffId: grant.handoffId,
      runId: grant.runId,
      artifactId: grant.artifactId,
      artifactVersion: grant.artifactVersion,
      artifactSha256: grant.artifactSha256,
      sessionBindingSha256: sha256(`${grant.replaySessionId}:${grant.surfaceSessionId}`),
      checkpointSha256: grant.checkpointSha256,
      completedStepIds: grant.completedStepIds,
      nextStepIndex: grant.nextStepIndex,
      expectedHumanPageState: grant.expectedHumanPageState,
      expectedPostHumanPageState: grant.expectedPostHumanPageState,
      ownership: "HUMAN",
      createdAt: grant.createdAt,
      expiresAt: grant.expiresAt,
      ...(screenshotRef ? { screenshotRef } : {}),
    });
    await this.#record({
      type: "HANDOFF_REQUIRED",
      stepId: step.id,
      handoffId: grant.handoffId,
      ownership: "HUMAN",
      checkpointSha256: grant.checkpointSha256,
      completedStepIds: grant.completedStepIds,
      expectedPageState: grant.expectedHumanPageState,
      expiresAt: grant.expiresAt,
      evidenceRef: interimRef,
      ...(observation.pageState ? { pageState: observation.pageState } : {}),
      surfaceFingerprint: surfaceFingerprint(observation),
      code: "INTERVENTION_REQUIRED",
      status: "intervention_required",
    });
    this.#state = "PAUSED_FOR_HUMAN";
    const result: ReplayInterventionRequiredResult = {
      status: "intervention_required",
      code: "INTERVENTION_REQUIRED",
      interventionId: grant.handoffId,
      stepId: step.id,
      reason:
        "Complete identity verification directly in the open browser, then acknowledge resume.",
      handoff: {
        handoffId: grant.handoffId,
        resumeToken: grant.resumeToken,
        runId: grant.runId,
        artifactId: grant.artifactId,
        artifactVersion: grant.artifactVersion,
        artifactSha256: grant.artifactSha256,
        checkpointSha256: grant.checkpointSha256,
        completedStepIds: grant.completedStepIds,
        expectedHumanPageState: grant.expectedHumanPageState,
        expectedPostHumanPageState: grant.expectedPostHumanPageState,
        expiresAt: grant.expiresAt,
      },
      runId: runtime.runId,
      artifactVersion: runtime.artifact.capability.version,
    };
    return result;
  }

  async #complete(): Promise<ReplayResult> {
    const runtime = this.#requiredRuntime();
    const observation = runtime.observation;
    if (!observation) {
      return this.#terminalFailure("SESSION_LOSS", "The final observation is unavailable.");
    }
    const failedCheckpoint = runtime.artifact.checkpoint.conditions.find(
      (condition) =>
        !evaluateCondition(condition, observation, runtime.request.inputs, runtime.executed),
    );
    const failedPostcondition = runtime.artifact.postconditions.find(
      (condition) =>
        !evaluateCondition(condition, observation, runtime.request.inputs, runtime.executed),
    );
    if (failedCheckpoint || failedPostcondition) {
      const failed = failedCheckpoint ?? failedPostcondition;
      return this.#terminalFailure(
        "CHECKPOINT_FAILED",
        `Final condition ${failed?.id ?? "unknown"} failed.`,
        runtime.artifact.steps.at(-1)?.id ?? null,
      );
    }
    await this.#record({
      type: "CHECKPOINT_VALIDATED",
      ...(observation.pageState ? { pageState: observation.pageState } : {}),
      status: runtime.artifact.checkpoint.successStatus,
      surfaceFingerprint: surfaceFingerprint(observation),
    });
    await this.#record({
      type: "RUN_SUCCEEDED",
      status: "success",
      ...(observation.pageState ? { pageState: observation.pageState } : {}),
    });
    const result: ReplaySuccessResult = {
      status: "success",
      runId: runtime.runId,
      artifactVersion: runtime.artifact.capability.version,
      outputs: successOutputs(runtime.artifact, runtime.request.inputs),
    };
    return this.#finish(result, "READY_FOR_REVIEW");
  }

  async #businessOutcome(
    code: "MEMBER_NOT_FOUND",
    observation: SurfaceObservation,
  ): Promise<ReplayBusinessOutcomeResult> {
    const runtime = this.#requiredRuntime();
    await this.#record({
      type: "BUSINESS_OUTCOME",
      code,
      status: "business_outcome",
      ...(observation.pageState ? { pageState: observation.pageState } : {}),
      surfaceFingerprint: surfaceFingerprint(observation),
    });
    const result: ReplayBusinessOutcomeResult = {
      status: "business_outcome",
      code,
      runId: runtime.runId,
      artifactVersion: runtime.artifact.capability.version,
    };
    return this.#finish(result, code);
  }

  async #terminalFailure(
    code: ReplayFailureCode,
    message: string,
    stepId: string | null = null,
    expected?: string,
    observed?: string,
    attemptedStrategies?: readonly TargetStrategy[],
    observedCount?: number,
  ): Promise<ReplayFailureResult> {
    const runtime = this.#requiredRuntime();
    const result = await this.#failure(
      code,
      message,
      stepId,
      runtime.observation,
      expected,
      observed,
      attemptedStrategies,
      observedCount,
    );
    return this.#finish(result, code);
  }

  async #failure(
    code: ReplayFailureCode,
    message: string,
    stepId: string | null,
    observation?: SurfaceObservation,
    expected?: string,
    observed?: string,
    attemptedStrategies?: readonly TargetStrategy[],
    observedCount?: number,
  ): Promise<ReplayFailureResult> {
    const runtime = this.#requiredRuntime();
    const evidenceRefs: string[] = [];
    if (observation) {
      try {
        const screenshot = await this.#surface.captureScreenshot(
          Object.values(runtime.request.inputs),
        );
        evidenceRefs.push(
          await this.#evidence.writeScreenshot(
            `${stepId ?? "run"}-${code.toLowerCase()}`,
            screenshot,
          ),
        );
      } catch {
        // Failure construction remains deterministic if optional screenshot capture fails.
      }
    }
    await this.#record({
      type: "RUN_FAILED",
      ...(stepId ? { stepId } : {}),
      code,
      status: "failure",
      ...(observation?.pageState ? { pageState: observation.pageState } : {}),
      ...(observation ? { surfaceFingerprint: surfaceFingerprint(observation) } : {}),
      message,
    });
    return {
      status: "failure",
      code,
      message,
      stepId,
      runId: runtime.runId,
      artifactVersion: runtime.artifact.capability.version,
      ...(expected ? { expected } : {}),
      ...(observed ? { observed } : {}),
      ...(attemptedStrategies ? { attemptedStrategies } : {}),
      ...(attemptedStrategies ? { expectedCount: 1 } : {}),
      ...(observedCount !== undefined ? { observedCount } : {}),
      ...(observation ? { currentUrl: urlWithoutQuery(observation.url) } : {}),
      ...(observation ? { surfaceFingerprint: surfaceFingerprint(observation) } : {}),
      evidenceRefs,
    };
  }

  async #finish<T extends ReplaySuccessResult | ReplayBusinessOutcomeResult | ReplayFailureResult>(
    result: T,
    terminalCode: string,
  ): Promise<T> {
    const runtime = this.#requiredRuntime();
    this.#state =
      result.status === "success" || result.status === "business_outcome" ? "COMPLETED" : "FAILED";
    await this.#evidence.finalize({
      runId: runtime.runId,
      capabilityId: runtime.artifact.capability.id,
      capabilityVersion: runtime.artifact.capability.version,
      artifactSha256: runtime.artifactSha256,
      status: result.status,
      terminalCode,
      startedAt: runtime.startedAt,
      endedAt: new Date(this.#now()).toISOString(),
      eventCount: this.#eventSequence,
    });
    return result;
  }

  #resumeRejected(
    code: ReplayResumeRejectedResult["code"],
    reason: string,
  ): ReplayResumeRejectedResult {
    return {
      status: "resume_rejected",
      code,
      reason,
      runId: this.#runtime?.runId ?? "uninitialized",
      artifactVersion: this.#runtime?.artifact.capability.version ?? "unknown",
    };
  }

  #bareFailure(
    runId: string,
    artifact: CapabilityArtifact,
    code: ReplayFailureCode,
    message: string,
  ): ReplayFailureResult {
    return {
      status: "failure",
      code,
      message,
      stepId: null,
      runId,
      artifactVersion: artifact.capability.version,
      evidenceRefs: [],
    };
  }

  #requiredRuntime(): ReplayRuntime {
    if (!this.#runtime) throw new Error("The replay session has not been initialized.");
    return this.#runtime;
  }

  #remainingMs(deadline: number): number {
    return Math.max(0, Math.floor(deadline - this.#now()));
  }

  #requiredRemainingMs(deadline: number): number {
    const remaining = this.#remainingMs(deadline);
    if (remaining <= 0) throw new SurfaceTimeoutError();
    return remaining;
  }

  async #record(event: Omit<ReplayEvidenceEvent, "sequence" | "timestamp">): Promise<void> {
    this.#eventSequence += 1;
    await this.#evidence.append({
      ...event,
      sequence: this.#eventSequence,
      timestamp: new Date(this.#now()).toISOString(),
    });
  }
}
