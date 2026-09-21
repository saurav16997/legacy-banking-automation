import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DiscoveryEvent, DiscoveryTrajectory } from "../discovery/contracts.js";
import type { ActionRisk, SemanticTarget } from "../domain/index.js";
import { canonicalJson, sha256 } from "./canonical-json.js";
import {
  CAPABILITY_ARTIFACT_SCHEMA_VERSION,
  CAPABILITY_COMPILER_VERSION,
  CapabilityCompilerError,
  type ArtifactStep,
  type CapabilityArtifact,
  type CapabilityDefinition,
  type CompilationResult,
  type TargetRecipe,
  type TargetStrategy,
} from "./contracts.js";
import {
  loadVerifiedDiscoveryEvidence,
  type VerifiedDiscoveryEvidence,
} from "./evidence-loader.js";
import { PREPARE_SAVINGS_SUBACCOUNT_DEFINITION } from "./prepare-savings-subaccount-definition.js";
import { validateCapabilityArtifact } from "./schema-validator.js";

const EXECUTABLE_ACTIONS = new Set([
  "click_element",
  "fill_element_from_input",
  "select_option_from_input",
]);

const FORBIDDEN_ARTIFACT_KEYS = new Set([
  "observationId",
  "elementRef",
  "selector",
  "visibleText",
  "sanitizedResult",
  "model",
  "currentValue",
  "availableOptions",
  "transcript",
]);

const REQUIRED_COMPLETION_CHECKS = new Set([
  "page_state",
  "review_heading",
  "member",
  "product",
  "nickname",
  "deposit",
  "funding_account",
  "account_not_created",
  "open_account_policy",
  "open_account_not_executed",
  "forbidden_owners_not_executed",
]);

export interface CompileEvidenceRunOptions {
  readonly evidenceDiscoveryRoot: string;
  readonly artifactsRoot: string;
  readonly schemaPath: string;
  readonly runId: string;
  readonly definition?: CapabilityDefinition;
}

function fail(
  code: ConstructorParameters<typeof CapabilityCompilerError>[0],
  message: string,
): never {
  throw new CapabilityCompilerError(code, message);
}

function eventStatus(event: DiscoveryEvent): unknown {
  return event.sanitizedResult.status;
}

function sameTarget(actual: SemanticTarget | undefined, expected: SemanticTarget): boolean {
  return (
    actual?.role === expected.role &&
    actual.accessibleName === expected.accessibleName &&
    (actual.label ?? null) === (expected.label ?? null) &&
    (actual.testId ?? null) === (expected.testId ?? null)
  );
}

function controlKind(role: SemanticTarget["role"]): TargetRecipe["controlKind"] {
  switch (role) {
    case "button":
      return "BUTTON";
    case "link":
      return "LINK";
    case "textbox":
      return "TEXT_FIELD";
    case "combobox":
      return "SELECT";
    default:
      return fail("INSUFFICIENT_TARGET_RECIPE", "The target role cannot form a stable recipe.");
  }
}

function createTargetRecipe(
  target: SemanticTarget,
  pageState: string,
  ownership: NonNullable<DiscoveryEvent["controlOwner"]>,
  risk: NonNullable<DiscoveryEvent["actionRisk"]>,
): TargetRecipe {
  if (!target.accessibleName.trim()) {
    fail("INSUFFICIENT_TARGET_RECIPE", "A stable target requires an accessible name.");
  }
  const strategies: TargetStrategy[] = [];
  const signalCodes: TargetRecipe["robustness"]["signalCodes"][number][] = ["PAGE_STATE"];
  if (target.testId) {
    strategies.push({
      kind: "TRUSTED_CONTROL_ID",
      pageState,
      controlId: target.testId,
      expectedMatches: 1,
    });
    signalCodes.push("TRUSTED_CONTROL_ID");
  }
  if (target.label) {
    strategies.push({
      kind: "EXACT_LABEL",
      pageState,
      label: target.label,
      exact: true,
      expectedMatches: 1,
    });
    signalCodes.push("LABEL");
  }
  strategies.push({
    kind: "EXACT_ROLE_AND_ACCESSIBLE_NAME",
    pageState,
    role: target.role,
    accessibleName: target.accessibleName,
    exact: true,
    expectedMatches: 1,
  });
  signalCodes.push("SEMANTIC_ROLE", "ACCESSIBLE_NAME");
  return {
    requiredPageState: pageState,
    controlKind: controlKind(target.role),
    strategies,
    expectedOwnership: ownership,
    expectedRisk: risk,
    ambiguityPolicy: "FAIL_CLOSED",
    robustness: {
      tier: target.testId || target.label ? "HIGH" : "MEDIUM",
      signalCodes,
      rationaleCode: "CURATED_EXACT_SEMANTIC_IDENTITY",
    },
  };
}

function assertInputContract(
  trajectory: DiscoveryTrajectory,
  definition: CapabilityDefinition,
): void {
  const actual = [...trajectory.inputs]
    .map((input) => `${input.name}:${String(input.sensitive)}`)
    .sort();
  const expected = [...definition.inputs]
    .map((input) => `${input.name}:${String(input.sensitivity !== "NONE")}`)
    .sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    fail("INPUT_CONTRACT_MISMATCH", "The discovery inputs do not match the capability definition.");
  }
}

function assertSuccessfulSource(
  trajectory: DiscoveryTrajectory,
  definition: CapabilityDefinition,
): void {
  if (trajectory.finalStatus !== "SUCCESS") {
    fail("TRAJECTORY_NOT_SUCCESSFUL", "Only a successful discovery trajectory can be compiled.");
  }
  const completion = trajectory.completionValidation;
  if (
    !completion?.passed ||
    completion.checks.length === 0 ||
    completion.checks.some((check) => !check.passed)
  ) {
    fail("COMPLETION_VALIDATION_FAILED", "All deterministic completion checks must pass.");
  }
  const checkNames = new Set(completion.checks.map((check) => check.name));
  if (
    completion.checks.length !== REQUIRED_COMPLETION_CHECKS.size ||
    checkNames.size !== REQUIRED_COMPLETION_CHECKS.size ||
    [...REQUIRED_COMPLETION_CHECKS].some((name) => !checkNames.has(name))
  ) {
    fail("COMPLETION_VALIDATION_FAILED", "The deterministic completion check set is incomplete.");
  }
  assertInputContract(trajectory, definition);
}

function assertSafeExecutedEvent(event: DiscoveryEvent): void {
  if (
    event.semanticTarget?.role === "button" &&
    event.semanticTarget.accessibleName === "Open Account"
  ) {
    fail("OPEN_ACCOUNT_EXECUTED", "The forbidden Open Account action was executed.");
  }
  if (
    event.controlOwner !== "AUTOMATION" ||
    event.actionRisk === "IRREVERSIBLE" ||
    event.actionRisk === undefined
  ) {
    fail("UNSAFE_EXECUTED_ACTION", "An executed action violates the capability safety boundary.");
  }
}

function safetyClassification(
  operation: ArtifactStep["operation"],
  risk: Exclude<ActionRisk, "IRREVERSIBLE">,
): ArtifactStep["safety"]["classification"] {
  if (operation === "CLICK") return "READ_ONLY";
  return risk === "SENSITIVE" ? "SENSITIVE_INPUT" : "REVERSIBLE_INPUT";
}

function compileSteps(
  trajectory: DiscoveryTrajectory,
  definition: CapabilityDefinition,
): readonly ArtifactStep[] {
  const events = [...trajectory.events].sort((left, right) => left.sequence - right.sequence);
  if (events.some((event, index) => index > 0 && event.sequence === events[index - 1]?.sequence)) {
    fail("INVALID_TRAJECTORY", "Trajectory event sequence numbers must be unique.");
  }
  const executed = events.filter(
    (event) => EXECUTABLE_ACTIONS.has(event.actionType) && eventStatus(event) === "EXECUTED",
  );
  const unsupportedExecuted = events.find(
    (event) => event.actionType === "navigate_same_origin" && eventStatus(event) === "EXECUTED",
  );
  if (unsupportedExecuted) {
    fail("UNKNOWN_OPERATION", "The source includes an unsupported executed operation.");
  }
  if (executed.length !== definition.steps.length) {
    fail("STEP_COUNT_MISMATCH", "The executed action count does not match the curated definition.");
  }

  let currentPageState: string = definition.surface.entryPoint.expectedInitialPageState;
  const compiled: ArtifactStep[] = [];
  for (let index = 0; index < executed.length; index += 1) {
    const event = executed[index];
    const expected = definition.steps[index];
    if (!event || !expected) fail("STEP_COUNT_MISMATCH", "A compiled step is missing.");
    assertSafeExecutedEvent(event);
    if (!event.semanticTarget || !event.controlOwner || !event.actionRisk) {
      fail("MISSING_SEMANTIC_TARGET", "An executed event lacks required semantic target metadata.");
    }
    if (event.inputRef && !definition.inputs.some((input) => input.name === event.inputRef)) {
      fail("UNDECLARED_INPUT_REFERENCE", "An executed action references an undeclared input.");
    }
    if (
      event.actionType !== expected.sourceActionType ||
      event.inputRef !== (expected.inputRef ?? undefined)
    ) {
      fail(
        "TARGET_RECIPE_MISMATCH",
        "An executed action does not match the curated step contract.",
      );
    }
    const expectedTarget: SemanticTarget = {
      role: expected.target.role,
      accessibleName: expected.target.accessibleName,
      ...(expected.target.label ? { label: expected.target.label } : {}),
      ...(expected.target.trustedControlId ? { testId: expected.target.trustedControlId } : {}),
    };
    if (!sameTarget(event.semanticTarget, expectedTarget)) {
      fail(
        "TARGET_RECIPE_MISMATCH",
        "An executed semantic target differs from the curated definition.",
      );
    }
    if (
      currentPageState !== expected.startingPageState ||
      event.resultingPageState !== expected.resultingPageState ||
      event.controlOwner !== expected.expectedOwnership ||
      event.actionRisk !== expected.expectedRisk
    ) {
      fail(
        "TARGET_RECIPE_MISMATCH",
        "An executed event state or policy classification differs from the definition.",
      );
    }
    const safeRisk = event.actionRisk as Exclude<ActionRisk, "IRREVERSIBLE">;
    compiled.push({
      id: `step-${String(index + 1).padStart(2, "0")}`,
      sourceEventSequence: event.sequence,
      purpose: expected.purpose,
      operation: expected.operation,
      target: createTargetRecipe(
        event.semanticTarget,
        expected.startingPageState,
        event.controlOwner,
        event.actionRisk,
      ),
      inputRef: event.inputRef ?? null,
      expectedStartingPageState: expected.startingPageState,
      expectedResultingPageState: expected.resultingPageState,
      timeoutMs: expected.timeoutMs,
      retry: expected.retry,
      safety: {
        ownership: "AUTOMATION",
        risk: safeRisk,
        classification: safetyClassification(expected.operation, safeRisk),
        policyDecision: "ALLOW",
      },
    });
    currentPageState = event.resultingPageState;
  }
  return compiled;
}

function countEvents(
  trajectory: DiscoveryTrajectory,
): CapabilityArtifact["provenance"]["eventCounts"] {
  return {
    total: trajectory.events.length,
    executedBrowserActions: trajectory.events.filter(
      (event) => EXECUTABLE_ACTIONS.has(event.actionType) && eventStatus(event) === "EXECUTED",
    ).length,
    rejectedBrowserActions: trajectory.events.filter(
      (event) => EXECUTABLE_ACTIONS.has(event.actionType) && eventStatus(event) !== "EXECUTED",
    ).length,
    observations: trajectory.events.filter((event) => event.actionType === "observe_surface")
      .length,
    validations: trajectory.events.filter((event) => event.actionType === "complete_discovery")
      .length,
  };
}

function assertNoForbiddenProjection(value: unknown, pathLabel = "$artifact"): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertNoForbiddenProjection(value[index], `${pathLabel}[${String(index)}]`);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_ARTIFACT_KEYS.has(key)) {
      fail(
        "LITERAL_VALUE_FORBIDDEN",
        `The artifact projection contains forbidden field ${pathLabel}.${key}.`,
      );
    }
    assertNoForbiddenProjection(item, `${pathLabel}.${key}`);
  }
}

export function compileCapabilityArtifact(
  evidence: VerifiedDiscoveryEvidence,
  definition: CapabilityDefinition = PREPARE_SAVINGS_SUBACCOUNT_DEFINITION,
): CapabilityArtifact {
  const { trajectory } = evidence;
  assertSuccessfulSource(trajectory, definition);
  const sourceCounts = countEvents(trajectory);
  if (
    evidence.summary.actionCount !== sourceCounts.executedBrowserActions ||
    evidence.summary.finalPageState !== trajectory.finalObservation?.pageState ||
    evidence.summary.finalPageState !== "ready-for-review"
  ) {
    fail("INVALID_TRAJECTORY", "The successful summary does not agree with the source trajectory.");
  }
  const steps = compileSteps(trajectory, definition);
  const artifact: CapabilityArtifact = {
    schemaVersion: CAPABILITY_ARTIFACT_SCHEMA_VERSION,
    capability: definition.capability,
    lifecycle: { status: "DRAFT", approvalRequired: true },
    compiler: { id: "deterministic-trajectory-compiler", version: CAPABILITY_COMPILER_VERSION },
    provenance: {
      discoveryRunId: trajectory.runId,
      trajectorySchemaVersion: trajectory.schemaVersion,
      trajectorySha256: evidence.trajectorySha256,
      sourceCompletedAt: trajectory.endedAt,
      eventCounts: sourceCounts,
      containsModelTranscript: false,
    },
    inputs: definition.inputs,
    outputs: definition.outputs,
    surface: definition.surface,
    preconditions: definition.preconditions,
    steps,
    executionPolicy: definition.executionPolicy,
    checkpoint: definition.checkpoint,
    postconditions: definition.postconditions,
    outcomes: definition.outcomes,
    safetyPolicy: { sourcePolicyVersion: trajectory.policyVersion, ...definition.safetyPolicy },
    compatibility: definition.compatibility,
  };
  assertNoForbiddenProjection(artifact);
  return artifact;
}

async function writeVersionedArtifact(artifactPath: string, content: string): Promise<boolean> {
  await mkdir(path.dirname(artifactPath), { recursive: true });
  try {
    await writeFile(artifactPath, content, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const existing = await readFile(artifactPath, "utf8");
  if (existing !== content) {
    fail("ARTIFACT_VERSION_CONFLICT", "The versioned artifact path contains different bytes.");
  }
  return false;
}

export async function compileEvidenceRun(
  options: CompileEvidenceRunOptions,
): Promise<CompilationResult> {
  const definition = options.definition ?? PREPARE_SAVINGS_SUBACCOUNT_DEFINITION;
  const evidence = await loadVerifiedDiscoveryEvidence(
    options.evidenceDiscoveryRoot,
    options.runId,
  );
  const artifact = compileCapabilityArtifact(evidence, definition);
  await validateCapabilityArtifact(artifact, options.schemaPath);
  const content = canonicalJson(artifact);
  const artifactPath = path.resolve(
    options.artifactsRoot,
    definition.capability.id,
    definition.capability.version,
    "capability.json",
  );
  const artifactsRoot = path.resolve(options.artifactsRoot);
  const relative = path.relative(artifactsRoot, artifactPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("INTERNAL_ERROR", "The artifact path escapes the configured artifact root.");
  }
  const wroteArtifact = await writeVersionedArtifact(artifactPath, content);
  return {
    artifactPath,
    capabilityVersion: definition.capability.version,
    stepCount: artifact.steps.length,
    sha256: sha256(content),
    wroteArtifact,
  };
}
