import type { ActionRisk, ControlOwner, SemanticRole } from "../domain/index.js";

export const CAPABILITY_ARTIFACT_SCHEMA_VERSION = "1.0.0" as const;
export const CAPABILITY_COMPILER_VERSION = "1.0.0" as const;

export type Sensitivity = "NONE" | "CREDENTIAL" | "PII" | "FINANCIAL" | "SECRET";
export type InputValueType = "STRING" | "USD_DECIMAL_STRING";
export type ArtifactOperation = "CLICK" | "FILL" | "SELECT_OPTION";
export type ControlKind = "BUTTON" | "LINK" | "TEXT_FIELD" | "SELECT";
export type ResultCategory = "SUCCESS" | "BUSINESS_OUTCOME" | "FAILURE";

export interface CapabilityIdentity {
  readonly id: "prepare_savings_subaccount";
  readonly title: string;
  readonly description: string;
  readonly version: string;
}

export interface CapabilityLifecycle {
  readonly status: "DRAFT";
  readonly approvalRequired: true;
}

export interface CompilerIdentity {
  readonly id: "deterministic-trajectory-compiler";
  readonly version: string;
}

export interface SourceEventCounts {
  readonly total: number;
  readonly executedBrowserActions: number;
  readonly rejectedBrowserActions: number;
  readonly observations: number;
  readonly validations: number;
}

export interface SourceProvenance {
  readonly discoveryRunId: string;
  readonly trajectorySchemaVersion: string;
  readonly trajectorySha256: string;
  readonly sourceCompletedAt: string;
  readonly eventCounts: SourceEventCounts;
  readonly containsModelTranscript: false;
}

export interface InputContractField {
  readonly name: string;
  readonly type: InputValueType;
  readonly required: true;
  readonly sensitivity: Sensitivity;
  readonly description: string;
  readonly format: string | null;
  readonly pattern: string | null;
  readonly currency: "USD" | null;
}

export type OutputSource =
  | { readonly kind: "PAGE_STATE"; readonly pageState: string }
  | { readonly kind: "CHECKPOINT_RESULT"; readonly checkId: string }
  | { readonly kind: "VALIDATED_INPUT"; readonly inputRef: string }
  | { readonly kind: "OBSERVED_FIELD"; readonly field: string };

export interface ReviewReceiptField {
  readonly name: string;
  readonly type: InputValueType;
  readonly sensitivity: Sensitivity;
  readonly source: OutputSource;
}

export interface OutputContract {
  readonly resultCategories: readonly ResultCategory[];
  readonly success: {
    readonly category: "SUCCESS";
    readonly status: {
      readonly value: "READY_FOR_REVIEW";
      readonly source: OutputSource;
      readonly sensitivity: "NONE";
    };
    readonly accountCreated: {
      readonly value: false;
      readonly source: OutputSource;
      readonly sensitivity: "NONE";
    };
    readonly reviewReceipt: {
      readonly fields: readonly ReviewReceiptField[];
    };
  };
  readonly businessOutcome: {
    readonly category: "BUSINESS_OUTCOME";
    readonly codeType: "ENUM";
  };
  readonly failure: {
    readonly category: "FAILURE";
    readonly codeType: "ENUM";
  };
}

export interface SurfaceContract {
  readonly kind: "LEGACY_WEB";
  readonly entryPoint: {
    readonly path: "/login";
    readonly expectedInitialPageState: "operator-login";
  };
}

export type TargetStrategy =
  | {
      readonly kind: "TRUSTED_CONTROL_ID";
      readonly pageState: string;
      readonly controlId: string;
      readonly expectedMatches: 1;
    }
  | {
      readonly kind: "EXACT_LABEL";
      readonly pageState: string;
      readonly label: string;
      readonly exact: true;
      readonly expectedMatches: 1;
    }
  | {
      readonly kind: "EXACT_ROLE_AND_ACCESSIBLE_NAME";
      readonly pageState: string;
      readonly role: SemanticRole;
      readonly accessibleName: string;
      readonly exact: true;
      readonly expectedMatches: 1;
    };

export interface TargetRecipe {
  readonly requiredPageState: string;
  readonly controlKind: ControlKind;
  readonly strategies: readonly TargetStrategy[];
  readonly expectedOwnership: ControlOwner;
  readonly expectedRisk: ActionRisk;
  readonly ambiguityPolicy: "FAIL_CLOSED";
  readonly robustness: {
    readonly tier: "HIGH" | "MEDIUM";
    readonly signalCodes: readonly (
      "TRUSTED_CONTROL_ID" | "PAGE_STATE" | "LABEL" | "SEMANTIC_ROLE" | "ACCESSIBLE_NAME"
    )[];
    readonly rationaleCode: "CURATED_EXACT_SEMANTIC_IDENTITY";
  };
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoffMs: number;
  readonly retryOn: readonly ("STALE_TARGET" | "TRANSIENT_TIMEOUT")[];
  readonly idempotentOnly: true;
}

export interface ArtifactStep {
  readonly id: string;
  readonly sourceEventSequence: number;
  readonly purpose: string;
  readonly operation: ArtifactOperation;
  readonly target: TargetRecipe;
  readonly inputRef: string | null;
  readonly expectedStartingPageState: string;
  readonly expectedResultingPageState: string;
  readonly timeoutMs: number;
  readonly retry: RetryPolicy;
  readonly safety: {
    readonly ownership: "AUTOMATION";
    readonly risk: Exclude<ActionRisk, "IRREVERSIBLE">;
    readonly classification: "READ_ONLY" | "REVERSIBLE_INPUT" | "SENSITIVE_INPUT";
    readonly policyDecision: "ALLOW";
  };
}

export type CapabilityCondition =
  | {
      readonly id: string;
      readonly kind: "PAGE_STATE_EQUALS";
      readonly pageState: string;
    }
  | {
      readonly id: string;
      readonly kind: "HEADING_EQUALS";
      readonly heading: string;
    }
  | {
      readonly id: string;
      readonly kind: "REVIEW_FIELD_MATCHES_INPUT";
      readonly field: string;
      readonly inputRef: string;
    }
  | {
      readonly id: string;
      readonly kind: "TEXT_CONTAINS";
      readonly text: string;
    }
  | {
      readonly id: string;
      readonly kind: "CONTROL_PRESENT";
      readonly target: TargetRecipe;
    }
  | {
      readonly id: string;
      readonly kind: "NO_EXECUTED_TARGET";
      readonly role: SemanticRole;
      readonly accessibleName: string;
    }
  | {
      readonly id: string;
      readonly kind: "NO_EXECUTED_OWNERS";
      readonly owners: readonly ("HUMAN" | "NONE")[];
    };

export interface CapabilityCheckpoint {
  readonly id: "ready-for-review";
  readonly mode: "ALL";
  readonly conditions: readonly CapabilityCondition[];
  readonly successStatus: "READY_FOR_REVIEW";
}

export interface BusinessOutcomeDefinition {
  readonly code: "MEMBER_NOT_FOUND";
  readonly category: "BUSINESS_OUTCOME";
  readonly terminal: true;
  readonly detector: {
    readonly mode: "ALL";
    readonly conditions: readonly [
      { readonly kind: "PAGE_STATE_EQUALS"; readonly pageState: "member-search" },
      {
        readonly kind: "TEXT_TEMPLATE_PRESENT";
        readonly template: "No member was found for ID {member_id}.";
        readonly bindings: { readonly member_id: "member_id" };
      },
    ];
  };
}

export interface OutcomeModel {
  readonly businessOutcomes: readonly BusinessOutcomeDefinition[];
  readonly recoverableConditions: readonly {
    readonly code: "STALE_TARGET" | "TRANSIENT_TIMEOUT";
    readonly maxOccurrences: number;
    readonly terminal: false;
  }[];
  readonly failureCodes: readonly (
    | "UNEXPECTED_PAGE_STATE"
    | "TARGET_AMBIGUOUS"
    | "POLICY_VIOLATION"
    | "TIMEOUT"
    | "SESSION_LOSS"
    | "CHECKPOINT_FAILED"
  )[];
}

export interface SafetyPolicyContract {
  readonly sourcePolicyVersion: string;
  readonly allowedOwners: readonly ["AUTOMATION"];
  readonly forbiddenOwners: readonly ["HUMAN", "NONE"];
  readonly allowedRisks: readonly ["SAFE", "SENSITIVE"];
  readonly forbiddenRisks: readonly ["IRREVERSIBLE"];
  readonly forbiddenTargets: readonly {
    readonly role: "button";
    readonly accessibleName: "Open Account";
    readonly exact: true;
  }[];
  readonly externalNavigation: "FORBIDDEN";
  readonly ambiguity: "FAIL_CLOSED";
}

export interface CompatibilityMetadata {
  readonly applicationFamily: string;
  readonly tenantScope: readonly string[];
  readonly applicationVariants: readonly string[];
  readonly semanticSurfaceContract: "1.0.0";
  readonly adapterKinds: readonly ("LEGACY_WEB" | "DESKTOP_ACCESSIBILITY")[];
}

export interface CapabilityArtifact {
  readonly schemaVersion: typeof CAPABILITY_ARTIFACT_SCHEMA_VERSION;
  readonly capability: CapabilityIdentity;
  readonly lifecycle: CapabilityLifecycle;
  readonly compiler: CompilerIdentity;
  readonly provenance: SourceProvenance;
  readonly inputs: readonly InputContractField[];
  readonly outputs: OutputContract;
  readonly surface: SurfaceContract;
  readonly preconditions: readonly CapabilityCondition[];
  readonly steps: readonly ArtifactStep[];
  readonly executionPolicy: {
    readonly maxTotalRuntimeMs: number;
    readonly defaultStepTimeoutMs: number;
    readonly maxStepAttempts: number;
  };
  readonly checkpoint: CapabilityCheckpoint;
  readonly postconditions: readonly CapabilityCondition[];
  readonly outcomes: OutcomeModel;
  readonly safetyPolicy: SafetyPolicyContract;
  readonly compatibility: CompatibilityMetadata;
}

export interface ExpectedTargetIdentity {
  readonly role: SemanticRole;
  readonly accessibleName: string;
  readonly label: string | null;
  readonly trustedControlId: string | null;
}

export interface CapabilityDefinitionStep {
  readonly purpose: string;
  readonly sourceActionType:
    "click_element" | "fill_element_from_input" | "select_option_from_input";
  readonly operation: ArtifactOperation;
  readonly target: ExpectedTargetIdentity;
  readonly inputRef: string | null;
  readonly startingPageState: string;
  readonly resultingPageState: string;
  readonly timeoutMs: number;
  readonly retry: RetryPolicy;
  readonly expectedOwnership: ControlOwner;
  readonly expectedRisk: ActionRisk;
}

export interface CapabilityDefinition {
  readonly definitionVersion: "1.0.0";
  readonly capability: CapabilityIdentity;
  readonly inputs: readonly InputContractField[];
  readonly outputs: OutputContract;
  readonly surface: SurfaceContract;
  readonly preconditions: readonly CapabilityCondition[];
  readonly steps: readonly CapabilityDefinitionStep[];
  readonly executionPolicy: CapabilityArtifact["executionPolicy"];
  readonly checkpoint: CapabilityCheckpoint;
  readonly postconditions: readonly CapabilityCondition[];
  readonly outcomes: OutcomeModel;
  readonly safetyPolicy: Omit<SafetyPolicyContract, "sourcePolicyVersion">;
  readonly compatibility: CompatibilityMetadata;
}

export type CapabilityCompilerErrorCode =
  | "INVALID_RUN_ID"
  | "SOURCE_PATH_OUTSIDE_EVIDENCE"
  | "EVIDENCE_NOT_FOUND"
  | "MANIFEST_INVALID"
  | "MANIFEST_INTEGRITY_FAILED"
  | "TRAJECTORY_DIGEST_MISMATCH"
  | "INVALID_TRAJECTORY"
  | "UNSUPPORTED_TRAJECTORY_VERSION"
  | "CAPABILITY_MISMATCH"
  | "TRAJECTORY_NOT_SUCCESSFUL"
  | "COMPLETION_VALIDATION_FAILED"
  | "INPUT_CONTRACT_MISMATCH"
  | "UNSAFE_EXECUTED_ACTION"
  | "OPEN_ACCOUNT_EXECUTED"
  | "UNKNOWN_OPERATION"
  | "UNDECLARED_INPUT_REFERENCE"
  | "LITERAL_VALUE_FORBIDDEN"
  | "MISSING_SEMANTIC_TARGET"
  | "TARGET_RECIPE_MISMATCH"
  | "INSUFFICIENT_TARGET_RECIPE"
  | "STEP_COUNT_MISMATCH"
  | "ARTIFACT_SCHEMA_INVALID"
  | "ARTIFACT_VERSION_CONFLICT"
  | "INTERNAL_ERROR";

export class CapabilityCompilerError extends Error {
  constructor(
    readonly code: CapabilityCompilerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CapabilityCompilerError";
  }
}

export interface CompilationResult {
  readonly artifactPath: string;
  readonly capabilityVersion: string;
  readonly stepCount: number;
  readonly sha256: string;
  readonly wroteArtifact: boolean;
}
