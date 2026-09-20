import type { SurfaceAdapter } from "../browser/index.js";
import type { ObservedElement, SurfaceActionResult, SurfaceObservation } from "../domain/index.js";
import { validatePrepareSavingsCompletion } from "./completion-validator.js";
import type {
  CompletionValidation,
  DiscoveryEvent,
  DiscoveryLimits,
  DiscoveryStatus,
  ElementToolInput,
  InputElementToolInput,
  NavigateToolInput,
} from "./contracts.js";
import { InputVault, UnknownInputReferenceError } from "./input-vault.js";

export class DiscoveryStopError extends Error {
  constructor(
    readonly status: Exclude<DiscoveryStatus, "SUCCESS">,
    message: string,
  ) {
    super(message);
    this.name = "DiscoveryStopError";
  }
}

export interface DiscoveryToolApi {
  observe_surface(): Promise<unknown>;
  click_element(input: ElementToolInput): Promise<unknown>;
  fill_element_from_input(input: InputElementToolInput): Promise<unknown>;
  select_option_from_input(input: InputElementToolInput): Promise<unknown>;
  navigate_same_origin(input: NavigateToolInput): Promise<unknown>;
  complete_discovery(): Promise<unknown>;
}

export interface DiscoveryToolControllerOptions {
  readonly adapter: SurfaceAdapter;
  readonly vault: InputVault;
  readonly limits: DiscoveryLimits;
  readonly startedAtMs: number;
  readonly initialObservation: SurfaceObservation;
  readonly captureEvidence: (label: string) => Promise<string | undefined>;
  readonly now?: () => number;
}

export class DiscoveryToolController implements DiscoveryToolApi {
  readonly #adapter: SurfaceAdapter;
  readonly #vault: InputVault;
  readonly #limits: DiscoveryLimits;
  readonly #startedAtMs: number;
  readonly #captureEvidence: (label: string) => Promise<string | undefined>;
  readonly #now: () => number;
  readonly #events: DiscoveryEvent[] = [];
  readonly #actionCounts = new Map<string, number>();
  #toolQueue: Promise<void> = Promise.resolve();
  #latestObservation: SurfaceObservation;
  #actionCount = 0;
  #completionValidation: CompletionValidation | undefined;

  constructor(options: DiscoveryToolControllerOptions) {
    this.#adapter = options.adapter;
    this.#vault = options.vault;
    this.#limits = options.limits;
    this.#startedAtMs = options.startedAtMs;
    this.#latestObservation = options.initialObservation;
    this.#captureEvidence = options.captureEvidence;
    this.#now = options.now ?? Date.now;
  }

  get events(): readonly DiscoveryEvent[] {
    return this.#events;
  }

  get latestObservation(): SurfaceObservation {
    return this.#latestObservation;
  }

  get actionCount(): number {
    return this.#actionCount;
  }

  get completionValidation(): CompletionValidation | undefined {
    return this.#completionValidation;
  }

  observe_surface(): Promise<unknown> {
    return this.#enqueue(() => this.#observeSurface());
  }

  click_element(input: ElementToolInput): Promise<unknown> {
    return this.#enqueue(() => this.#executeElementAction("click_element", input));
  }

  fill_element_from_input(input: InputElementToolInput): Promise<unknown> {
    return this.#enqueue(() =>
      this.#executeElementAction("fill_element_from_input", input, input.inputRef),
    );
  }

  select_option_from_input(input: InputElementToolInput): Promise<unknown> {
    return this.#enqueue(() =>
      this.#executeElementAction("select_option_from_input", input, input.inputRef),
    );
  }

  navigate_same_origin(input: NavigateToolInput): Promise<unknown> {
    return this.#enqueue(() => this.#navigateSameOrigin(input));
  }

  complete_discovery(): Promise<unknown> {
    return this.#enqueue(() => this.#completeDiscovery());
  }

  async #observeSurface(): Promise<unknown> {
    this.#checkTime();
    const started = this.#now();
    const observation = await this.#adapter.observe();
    this.#latestObservation = observation;
    const result = { status: "EXECUTED", observation: this.#vault.sanitize(observation) };
    this.#record({
      actionType: "observe_surface",
      observationId: observation.observationId,
      sanitizedResult: result,
      resultingPageState: observation.pageState,
      durationMs: this.#now() - started,
    });
    return result;
  }

  async #navigateSameOrigin(input: NavigateToolInput): Promise<unknown> {
    this.#checkTime();
    this.#reserveAction(`navigate:${input.path}`);
    const started = this.#now();
    const previousPageState = this.#latestObservation.pageState;
    const result = await this.#adapter.execute({ operation: "navigate", url: input.path });
    return this.#handleActionResult({
      actionType: "navigate_same_origin",
      result,
      started,
      ...(previousPageState ? { previousPageState } : {}),
      observationId: this.#latestObservation.observationId,
    });
  }

  #completeDiscovery(): Promise<unknown> {
    this.#checkTime();
    const started = this.#now();
    const validation = validatePrepareSavingsCompletion(
      this.#latestObservation,
      this.#events,
      this.#vault,
    );
    this.#completionValidation = validation;
    const result = validation.passed
      ? { status: "VALIDATED", validation }
      : { status: "VALIDATION_FAILED", validation };
    this.#record({
      actionType: "complete_discovery",
      observationId: this.#latestObservation.observationId,
      sanitizedResult: result,
      resultingPageState: this.#latestObservation.pageState,
      durationMs: this.#now() - started,
    });
    return Promise.resolve(result);
  }

  #enqueue(operation: () => Promise<unknown>): Promise<unknown> {
    const result = this.#toolQueue.then(operation);
    this.#toolQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #executeElementAction(
    actionType: "click_element" | "fill_element_from_input" | "select_option_from_input",
    input: ElementToolInput,
    inputRef?: string,
  ): Promise<unknown> {
    this.#checkTime();
    const element = this.#findCurrentElement(input);
    if (!element) {
      const started = this.#now();
      return this.#handleActionResult({
        actionType,
        result: {
          status: "STALE_OBSERVATION",
          message: "The tool may use only an element from the latest observation.",
        },
        started,
        observationId: input.observationId,
        elementRef: input.elementRef,
        ...(inputRef ? { inputRef } : {}),
      });
    }
    const signature = `${actionType}:${element.semanticTarget.role}:${element.semanticTarget.accessibleName}:${inputRef ?? ""}`;
    this.#reserveAction(signature);
    const started = this.#now();
    const previousPageState = this.#latestObservation.pageState;
    let result: SurfaceActionResult;
    try {
      if (actionType === "click_element") {
        result = await this.#adapter.execute({
          operation: "click",
          observationId: input.observationId,
          elementRef: input.elementRef,
        });
      } else {
        if (!inputRef) throw new UnknownInputReferenceError("missing");
        const resolvedValue = this.#vault.resolve(inputRef);
        if (actionType === "fill_element_from_input") {
          result = await this.#adapter.execute({
            operation: "fill",
            observationId: input.observationId,
            elementRef: input.elementRef,
            value: resolvedValue,
          });
        } else {
          const option = element.availableOptions.find(
            (candidate) => candidate.value === resolvedValue || candidate.label === resolvedValue,
          );
          result = await this.#adapter.execute({
            operation: "selectOption",
            observationId: input.observationId,
            elementRef: input.elementRef,
            option: option?.value ?? resolvedValue,
          });
        }
      }
    } catch (error) {
      if (!(error instanceof UnknownInputReferenceError)) throw error;
      result = { status: "BLOCKED", message: error.message };
    }
    return this.#handleActionResult({
      actionType,
      result,
      started,
      ...(previousPageState ? { previousPageState } : {}),
      observationId: input.observationId,
      elementRef: input.elementRef,
      element,
      ...(inputRef ? { inputRef } : {}),
    });
  }

  async #handleActionResult(details: {
    actionType: DiscoveryEvent["actionType"];
    result: SurfaceActionResult;
    started: number;
    previousPageState?: string;
    observationId?: string;
    elementRef?: string;
    element?: ObservedElement;
    inputRef?: string;
  }): Promise<unknown> {
    if (details.result.observation && details.result.status === "EXECUTED") {
      this.#latestObservation = details.result.observation;
    }
    const sanitizedResult = this.#vault.sanitize(details.result) as Record<string, unknown>;
    let evidenceRef: string | undefined;
    if (
      details.result.status === "EXECUTED" &&
      this.#latestObservation.pageState !== details.previousPageState
    ) {
      evidenceRef = await this.#captureEvidence(
        this.#latestObservation.pageState ?? `action-${String(this.#actionCount)}`,
      );
    }
    this.#record({
      actionType: details.actionType,
      ...(details.observationId ? { observationId: details.observationId } : {}),
      ...(details.elementRef ? { elementRef: details.elementRef } : {}),
      ...(details.element
        ? {
            semanticTarget: this.#vault.sanitize(details.element.semanticTarget),
            controlOwner: details.element.controlOwner,
            actionRisk: details.element.actionRisk,
          }
        : {}),
      ...(details.inputRef ? { inputRef: details.inputRef } : {}),
      sanitizedResult,
      ...(this.#latestObservation.pageState
        ? { resultingPageState: this.#latestObservation.pageState }
        : {}),
      durationMs: this.#now() - details.started,
      ...(evidenceRef ? { evidenceRef } : {}),
    });

    if (details.result.status === "HANDOFF_REQUIRED") {
      throw new DiscoveryStopError("HANDOFF_REQUIRED", details.result.message);
    }
    if (details.result.status === "BLOCKED") {
      throw new DiscoveryStopError("BLOCKED", details.result.message);
    }
    return sanitizedResult;
  }

  #findCurrentElement(input: ElementToolInput): ObservedElement | undefined {
    if (input.observationId !== this.#latestObservation.observationId) return undefined;
    return this.#latestObservation.elements.find(
      (element) => element.elementRef === input.elementRef,
    );
  }

  #reserveAction(signature: string): void {
    if (this.#actionCount >= this.#limits.maxBrowserActions) {
      throw new DiscoveryStopError("MAX_STEPS", "Maximum browser actions reached.");
    }
    const repeated = (this.#actionCounts.get(signature) ?? 0) + 1;
    this.#actionCounts.set(signature, repeated);
    if (repeated > this.#limits.maxRepeatedActions) {
      throw new DiscoveryStopError("MAX_STEPS", "Repeated browser action limit reached.");
    }
    this.#actionCount += 1;
  }

  #checkTime(): void {
    if (this.#now() - this.#startedAtMs >= this.#limits.maxDurationMs) {
      throw new DiscoveryStopError("TIMED_OUT", "Discovery duration limit reached.");
    }
  }

  #record(event: Omit<DiscoveryEvent, "sequence" | "timestamp">): void {
    this.#events.push({
      sequence: this.#events.length + 1,
      timestamp: new Date(this.#now()).toISOString(),
      ...event,
    });
  }
}
