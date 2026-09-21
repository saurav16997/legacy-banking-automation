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
import type {
  ReplayBusinessOutcomeResult,
  ReplayEngineOptions,
  ReplayEvidenceEvent,
  ReplayEvidenceSink,
  ReplayFailureCode,
  ReplayFailureResult,
  ReplayInterventionRequiredResult,
  ReplayRequest,
  ReplayResult,
  ReplaySuccessResult,
} from "./contracts.js";
import { NullReplayEvidenceSink } from "./evidence.js";

export * from "./contracts.js";
export * from "./evidence.js";

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

/** Deterministic, zero-model-call replay over the bounded surface contract. */
export class ReplayEngine {
  readonly #surface: SurfaceAdapter;
  readonly #evidence: ReplayEvidenceSink;
  readonly #now: () => number;
  readonly #createRunId: (() => string) | undefined;
  #eventSequence = 0;

  constructor(options: ReplayEngineOptions) {
    this.#surface = options.surface;
    this.#evidence = options.evidence ?? new NullReplayEvidenceSink();
    this.#now = options.now ?? Date.now;
    this.#createRunId = options.createRunId;
  }

  async replay(artifact: CapabilityArtifact, request: ReplayRequest): Promise<ReplayResult> {
    this.#eventSequence = 0;
    const startedAtMs = this.#now();
    const runId = this.#createRunId?.() ?? defaultRunId(startedAtMs);
    const startedAt = new Date(startedAtMs).toISOString();
    const artifactSha256 = sha256(canonicalJson(artifact));
    const lifecycleStatus = runtimeString(artifact.lifecycle.status);
    const draftOverride = lifecycleStatus === "DRAFT" && request.allowDraftArtifact === true;
    try {
      await this.#evidence.initialize({
        runId,
        capabilityId: artifact.capability.id,
        capabilityVersion: artifact.capability.version,
        artifactSha256,
        startedAt,
        draftOverride,
      });
    } catch {
      return this.#bareFailure(
        runId,
        artifact,
        "INITIALIZATION_FAILED",
        "Replay evidence could not be initialized.",
      );
    }

    const finish = async <T extends ReplayResult>(result: T, terminalCode: string): Promise<T> => {
      await this.#evidence.finalize({
        runId,
        capabilityId: artifact.capability.id,
        capabilityVersion: artifact.capability.version,
        artifactSha256,
        status: result.status,
        terminalCode,
        startedAt,
        endedAt: new Date(this.#now()).toISOString(),
        eventCount: this.#eventSequence,
      });
      return result;
    };

    await this.#record({ type: "RUN_STARTED", status: "STARTED" });

    if (
      runtimeString(artifact.schemaVersion) !== CAPABILITY_ARTIFACT_SCHEMA_VERSION ||
      runtimeString(artifact.capability.id) !== "prepare_savings_subaccount" ||
      runtimeString(artifact.surface.kind) !== "LEGACY_WEB"
    ) {
      return finish(
        await this.#failure(
          runId,
          artifact,
          request,
          "INVALID_ARTIFACT",
          "The artifact identity or schema version is unsupported.",
        ),
        "INVALID_ARTIFACT",
      );
    }
    if (lifecycleStatus === "DRAFT" && !draftOverride) {
      return finish(
        await this.#failure(
          runId,
          artifact,
          request,
          "ARTIFACT_NOT_APPROVED",
          "Draft artifacts require an explicit local demo override.",
        ),
        "ARTIFACT_NOT_APPROVED",
      );
    }
    if (lifecycleStatus !== "DRAFT" && lifecycleStatus !== "APPROVED") {
      return finish(
        await this.#failure(
          runId,
          artifact,
          request,
          "INVALID_ARTIFACT",
          "The artifact lifecycle status is unsupported.",
        ),
        "INVALID_ARTIFACT",
      );
    }
    const inputError = validateInputs(artifact, request.inputs);
    if (inputError) {
      return finish(
        await this.#failure(runId, artifact, request, "INVALID_INPUT", inputError),
        "INVALID_INPUT",
      );
    }

    const globalDeadline = startedAtMs + artifact.executionPolicy.maxTotalRuntimeMs;
    let observation: SurfaceObservation;
    try {
      observation = await this.#surface.start({
        timeoutMs: this.#remainingMs(globalDeadline),
      });
    } catch (error) {
      const timedOut = isSurfaceTimeout(error) || this.#remainingMs(globalDeadline) <= 0;
      const code = timedOut ? "GLOBAL_TIMEOUT" : "INITIALIZATION_FAILED";
      return finish(
        await this.#failure(
          runId,
          artifact,
          request,
          code,
          timedOut
            ? "Replay exhausted its global runtime while starting the bounded surface."
            : "The bounded browser surface could not be started.",
        ),
        code,
      );
    }

    const executed: ExecutedAction[] = [];
    const failedInitialPrecondition = artifact.preconditions.find(
      (condition) => !evaluateCondition(condition, observation, request.inputs, executed),
    );
    if (failedInitialPrecondition) {
      return finish(
        await this.#failure(
          runId,
          artifact,
          request,
          "UNEXPECTED_PAGE_STATE",
          `Initial precondition ${failedInitialPrecondition.id} failed.`,
          null,
          observation,
          artifact.surface.entryPoint.expectedInitialPageState,
          observation.pageState ?? "missing",
        ),
        "UNEXPECTED_PAGE_STATE",
      );
    }

    for (const step of artifact.steps) {
      if (this.#remainingMs(globalDeadline) <= 0) {
        return finish(
          await this.#failure(
            runId,
            artifact,
            request,
            "GLOBAL_TIMEOUT",
            "Replay exhausted its global runtime before the next step.",
            step.id,
            observation,
          ),
          "GLOBAL_TIMEOUT",
        );
      }
      const priorOutcome = detectBusinessOutcome(artifact, observation, request.inputs);
      if (priorOutcome)
        return finish(
          await this.#businessOutcome(runId, artifact, priorOutcome, observation),
          priorOutcome,
        );

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
        } catch (error) {
          if (!isSurfaceTimeout(error)) {
            return finish(
              await this.#failure(
                runId,
                artifact,
                request,
                "SESSION_LOSS",
                "The surface could not be observed before the step.",
                step.id,
                observation,
              ),
              "SESSION_LOSS",
            );
          }
          attemptTimedOut = true;
          timeoutMessage = "The precondition observation exceeded the bounded attempt timeout.";
        }

        if (!attemptTimedOut) {
          if (observation.pageState !== step.expectedStartingPageState) {
            if (isHumanInterruption(observation)) {
              return finish(
                await this.#intervention(runId, artifact, step.id, observation),
                "HUMAN_INTERVENTION",
              );
            }
            return finish(
              await this.#failure(
                runId,
                artifact,
                request,
                "UNEXPECTED_PAGE_STATE",
                "The step starting page state did not match the artifact.",
                step.id,
                observation,
                step.expectedStartingPageState,
                observation.pageState ?? "missing",
              ),
              "UNEXPECTED_PAGE_STATE",
            );
          }
        }

        const resolution = attemptTimedOut ? undefined : resolveTarget(observation, step.target);
        if (resolution && resolution.kind !== "RESOLVED") {
          const code = resolution.kind === "AMBIGUOUS" ? "TARGET_AMBIGUOUS" : "TARGET_NOT_FOUND";
          return finish(
            await this.#failure(
              runId,
              artifact,
              request,
              code,
              resolution.kind === "AMBIGUOUS"
                ? "The ordered target strategy resolved to multiple controls."
                : "No ordered target strategy resolved to a control.",
              step.id,
              observation,
              "exactly one acceptable target",
              `${String(resolution.observedCount)} matching targets`,
              step.target.strategies,
              resolution.observedCount,
            ),
            code,
          );
        }

        const element = resolution?.kind === "RESOLVED" ? resolution.element : undefined;
        if (element?.disabled) {
          return finish(
            await this.#failure(
              runId,
              artifact,
              request,
              "TARGET_UNAVAILABLE",
              "The resolved target is disabled.",
              step.id,
              observation,
            ),
            "TARGET_UNAVAILABLE",
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
          return finish(
            await this.#failure(
              runId,
              artifact,
              request,
              "POLICY_VIOLATION",
              "The live target classification is not authorized by the artifact.",
              step.id,
              observation,
            ),
            "POLICY_VIOLATION",
          );
        }

        const command = element
          ? makeCommand(step, observation, element, request.inputs)
          : undefined;
        if (!attemptTimedOut && !command) {
          return finish(
            await this.#failure(
              runId,
              artifact,
              request,
              "INVALID_INPUT",
              "The input cannot be applied to the resolved control.",
              step.id,
              observation,
            ),
            "INVALID_INPUT",
          );
        }

        if (!attemptTimedOut && this.#remainingMs(attemptDeadline) <= 0) {
          attemptTimedOut = true;
        }

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
            executed.push({
              role: element.semanticTarget.role,
              accessibleName: element.semanticTarget.accessibleName,
              owner: element.controlOwner,
            });
            try {
              observation =
                actionResult.observation ??
                (await this.#surface.observe({
                  timeoutMs: this.#requiredRemainingMs(attemptDeadline),
                }));
            } catch (error) {
              if (!isSurfaceTimeout(error)) {
                return finish(
                  await this.#failure(
                    runId,
                    artifact,
                    request,
                    "SESSION_LOSS",
                    "The surface could not be observed after the action.",
                    step.id,
                    observation,
                  ),
                  "SESSION_LOSS",
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
              if (outcome)
                return finish(
                  await this.#businessOutcome(runId, artifact, outcome, observation),
                  outcome,
                );
              if (observation.pageState !== step.expectedResultingPageState) {
                if (isHumanInterruption(observation)) {
                  return finish(
                    await this.#intervention(runId, artifact, step.id, observation),
                    "HUMAN_INTERVENTION",
                  );
                }
                return finish(
                  await this.#failure(
                    runId,
                    artifact,
                    request,
                    "UNEXPECTED_PAGE_STATE",
                    "The step postcondition page state did not match the artifact.",
                    step.id,
                    observation,
                    step.expectedResultingPageState,
                    observation.pageState ?? "missing",
                  ),
                  "UNEXPECTED_PAGE_STATE",
                );
              }
              completed = true;
              break;
            }
          } else if (actionResult.status === "TIMED_OUT") {
            attemptTimedOut = true;
            timeoutMessage = actionResult.message;
          } else if (actionResult.status === "HANDOFF_REQUIRED") {
            return finish(
              await this.#intervention(runId, artifact, step.id, observation),
              "HUMAN_INTERVENTION",
            );
          } else if (actionResult.status === "AMBIGUOUS_TARGET") {
            return finish(
              await this.#failure(
                runId,
                artifact,
                request,
                "TARGET_AMBIGUOUS",
                actionResult.message,
                step.id,
                observation,
                "exactly one acceptable target",
                "multiple targets",
                step.target.strategies,
              ),
              "TARGET_AMBIGUOUS",
            );
          } else if (actionResult.status === "BLOCKED") {
            return finish(
              await this.#failure(
                runId,
                artifact,
                request,
                "POLICY_VIOLATION",
                actionResult.message,
                step.id,
                observation,
              ),
              "POLICY_VIOLATION",
            );
          } else if (actionResult.status === "STALE_OBSERVATION") {
            const canRetryStale =
              attempt < maxAttempts &&
              isRetrySafeStep(step) &&
              step.retry.retryOn.includes("STALE_TARGET") &&
              this.#remainingMs(globalDeadline) > 0;
            if (!canRetryStale) {
              return finish(
                await this.#failure(
                  runId,
                  artifact,
                  request,
                  "STALE_TARGET",
                  actionResult.message,
                  step.id,
                  observation,
                ),
                "STALE_TARGET",
              );
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
            return finish(
              await this.#failure(
                runId,
                artifact,
                request,
                "SESSION_LOSS",
                actionResult.message,
                step.id,
                observation,
              ),
              "SESSION_LOSS",
            );
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
          return finish(
            await this.#failure(
              runId,
              artifact,
              request,
              code,
              timeoutMessage,
              step.id,
              observation,
            ),
            code,
          );
        }
      }
      if (!completed) {
        return finish(
          await this.#failure(
            runId,
            artifact,
            request,
            "TRANSIENT_TIMEOUT",
            "The step exhausted its bounded attempts.",
            step.id,
            observation,
          ),
          "TRANSIENT_TIMEOUT",
        );
      }
    }

    const failedCheckpoint = artifact.checkpoint.conditions.find(
      (condition) => !evaluateCondition(condition, observation, request.inputs, executed),
    );
    const failedPostcondition = artifact.postconditions.find(
      (condition) => !evaluateCondition(condition, observation, request.inputs, executed),
    );
    if (failedCheckpoint || failedPostcondition) {
      const failed = failedCheckpoint ?? failedPostcondition;
      return finish(
        await this.#failure(
          runId,
          artifact,
          request,
          "CHECKPOINT_FAILED",
          `Final condition ${failed?.id ?? "unknown"} failed.`,
          artifact.steps.at(-1)?.id ?? null,
          observation,
        ),
        "CHECKPOINT_FAILED",
      );
    }
    await this.#record({
      type: "CHECKPOINT_VALIDATED",
      ...(observation.pageState ? { pageState: observation.pageState } : {}),
      status: artifact.checkpoint.successStatus,
      surfaceFingerprint: surfaceFingerprint(observation),
    });
    await this.#record({
      type: "RUN_SUCCEEDED",
      status: "success",
      ...(observation.pageState ? { pageState: observation.pageState } : {}),
    });
    const result: ReplaySuccessResult = {
      status: "success",
      runId,
      artifactVersion: artifact.capability.version,
      outputs: successOutputs(artifact, request.inputs),
    };
    return finish(result, "READY_FOR_REVIEW");
  }

  async #businessOutcome(
    runId: string,
    artifact: CapabilityArtifact,
    code: "MEMBER_NOT_FOUND",
    observation: SurfaceObservation,
  ): Promise<ReplayBusinessOutcomeResult> {
    await this.#record({
      type: "BUSINESS_OUTCOME",
      code,
      status: "business_outcome",
      ...(observation.pageState ? { pageState: observation.pageState } : {}),
      surfaceFingerprint: surfaceFingerprint(observation),
    });
    return {
      status: "business_outcome",
      code,
      runId,
      artifactVersion: artifact.capability.version,
    };
  }

  async #intervention(
    runId: string,
    artifact: CapabilityArtifact,
    stepId: string,
    observation: SurfaceObservation,
  ): Promise<ReplayInterventionRequiredResult> {
    const interventionId = `${runId}-human-gate`;
    await this.#record({
      type: "INTERVENTION_REQUIRED",
      stepId,
      code: "HUMAN_INTERVENTION",
      status: "intervention_required",
      ...(observation.pageState ? { pageState: observation.pageState } : {}),
      surfaceFingerprint: surfaceFingerprint(observation),
    });
    return {
      status: "intervention_required",
      interventionId,
      stepId,
      reason: "The live surface requires human-owned interaction in the same browser session.",
      runId,
      artifactVersion: artifact.capability.version,
    };
  }

  async #failure(
    runId: string,
    artifact: CapabilityArtifact,
    request: ReplayRequest,
    code: ReplayFailureCode,
    message: string,
    stepId: string | null = null,
    observation?: SurfaceObservation,
    expected?: string,
    observed?: string,
    attemptedStrategies?: readonly TargetStrategy[],
    observedCount?: number,
  ): Promise<ReplayFailureResult> {
    const evidenceRefs: string[] = [];
    if (observation) {
      try {
        const screenshot = await this.#surface.captureScreenshot(Object.values(request.inputs));
        evidenceRefs.push(
          await this.#evidence.writeScreenshot(
            `${stepId ?? "run"}-${code.toLowerCase()}`,
            screenshot,
          ),
        );
      } catch {
        // Failure construction remains deterministic even when optional screenshot capture fails.
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
      runId,
      artifactVersion: artifact.capability.version,
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
