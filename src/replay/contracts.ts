import type { SurfaceAdapter } from "../browser/index.js";
import type { CapabilityArtifact, TargetStrategy } from "../compiler/contracts.js";

export type ReplayInputs = Readonly<Record<string, string>>;

export interface ReplayRequest {
  readonly inputs: ReplayInputs;
  readonly allowDraftArtifact?: boolean;
}

export interface ReplayEngineOptions {
  readonly surface: SurfaceAdapter;
  readonly evidence?: ReplayEvidenceSink;
  readonly now?: () => number;
  readonly createRunId?: () => string;
}

export interface ReplayEvidenceContext {
  readonly runId: string;
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly artifactSha256: string;
  readonly startedAt: string;
  readonly draftOverride: boolean;
}

export interface ReplayEvidenceEvent {
  readonly sequence: number;
  readonly timestamp: string;
  readonly type:
    | "RUN_STARTED"
    | "STEP_ATTEMPTED"
    | "STEP_EXECUTED"
    | "STEP_TIMED_OUT"
    | "RECOVERY_APPLIED"
    | "BUSINESS_OUTCOME"
    | "INTERVENTION_REQUIRED"
    | "CHECKPOINT_VALIDATED"
    | "RUN_FAILED"
    | "RUN_SUCCEEDED";
  readonly stepId?: string;
  readonly operation?: string;
  readonly inputRef?: string;
  readonly attempt?: number;
  readonly pageState?: string;
  readonly status?: string;
  readonly code?: string;
  readonly surfaceFingerprint?: string;
  readonly message?: string;
  readonly timeoutScope?: "ATTEMPT" | "GLOBAL";
  readonly effectiveTimeoutMs?: number;
}

export interface ReplayEvidenceSummary {
  readonly runId: string;
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly artifactSha256: string;
  readonly status: ReplayResult["status"];
  readonly terminalCode: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly eventCount: number;
}

export interface ReplayEvidenceSink {
  initialize(context: ReplayEvidenceContext): Promise<void>;
  append(event: ReplayEvidenceEvent): Promise<void>;
  writeScreenshot(name: string, bytes: Uint8Array): Promise<string>;
  finalize(summary: ReplayEvidenceSummary): Promise<void>;
}

export interface ReplaySuccessOutputs {
  readonly preparation_status: "READY_FOR_REVIEW";
  readonly account_created: false;
  readonly review_receipt: Readonly<Record<string, string>>;
}

interface ReplayResultBase {
  readonly runId: string;
  readonly artifactVersion: string;
  readonly evidenceDirectory?: string;
}

export interface ReplaySuccessResult extends ReplayResultBase {
  readonly status: "success";
  readonly outputs: ReplaySuccessOutputs;
}

export interface ReplayBusinessOutcomeResult extends ReplayResultBase {
  readonly status: "business_outcome";
  readonly code: "MEMBER_NOT_FOUND";
}

export interface ReplayInterventionRequiredResult extends ReplayResultBase {
  readonly status: "intervention_required";
  readonly interventionId: string;
  readonly stepId: string;
  readonly reason: string;
}

export type ReplayFailureCode =
  | "INVALID_ARTIFACT"
  | "ARTIFACT_NOT_APPROVED"
  | "INVALID_INPUT"
  | "INITIALIZATION_FAILED"
  | "UNEXPECTED_PAGE_STATE"
  | "TARGET_NOT_FOUND"
  | "TARGET_AMBIGUOUS"
  | "TARGET_UNAVAILABLE"
  | "POLICY_VIOLATION"
  | "STALE_TARGET"
  | "TRANSIENT_TIMEOUT"
  | "GLOBAL_TIMEOUT"
  | "SESSION_LOSS"
  | "CHECKPOINT_FAILED";

export interface ReplayFailureResult extends ReplayResultBase {
  readonly status: "failure";
  readonly code: ReplayFailureCode;
  readonly message: string;
  readonly stepId: string | null;
  readonly expected?: string;
  readonly observed?: string;
  readonly expectedCount?: number;
  readonly observedCount?: number;
  readonly attemptedStrategies?: readonly TargetStrategy[];
  readonly currentUrl?: string;
  readonly surfaceFingerprint?: string;
  readonly evidenceRefs: readonly string[];
}

export type ReplayResult =
  | ReplaySuccessResult
  | ReplayBusinessOutcomeResult
  | ReplayInterventionRequiredResult
  | ReplayFailureResult;

export interface ReplayExecutionContext {
  readonly artifact: CapabilityArtifact;
  readonly request: ReplayRequest;
}
