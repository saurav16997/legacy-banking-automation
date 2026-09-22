import type { SurfaceAdapter } from "../browser/index.js";
import type { CapabilityArtifact, TargetStrategy } from "../compiler/contracts.js";
import type { HandoffResumeRequest, HandoffValidationCode } from "../handoff/index.js";

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
  readonly handoffTtlMs?: number;
  readonly createResumeToken?: () => string;
  readonly createHandoffId?: () => string;
}

export type ReplaySessionState =
  "CREATED" | "RUNNING" | "PAUSED_FOR_HUMAN" | "COMPLETED" | "FAILED" | "CLOSED";

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
    | "HANDOFF_REQUIRED"
    | "RESUME_REQUESTED"
    | "HANDOFF_NOT_COMPLETED"
    | "HANDOFF_COMPLETED"
    | "HANDOFF_EXPIRED"
    | "HANDOFF_ABANDONED"
    | "REPLAY_RESUMED"
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
  readonly handoffId?: string;
  readonly ownership?: "HUMAN";
  readonly completedStepIds?: readonly string[];
  readonly checkpointSha256?: string;
  readonly expectedPageState?: string;
  readonly expiresAt?: string;
  readonly evidenceRef?: string;
}

export interface ReplayHandoffEvidenceRecord {
  readonly handoffId: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly artifactVersion: string;
  readonly artifactSha256: string;
  readonly sessionBindingSha256: string;
  readonly checkpointSha256: string;
  readonly completedStepIds: readonly string[];
  readonly nextStepIndex: number;
  readonly expectedHumanPageState: string;
  readonly expectedPostHumanPageState: string;
  readonly ownership: "HUMAN";
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly screenshotRef?: string;
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
  writeInterimHandoff(record: ReplayHandoffEvidenceRecord): Promise<string>;
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
  readonly code: "INTERVENTION_REQUIRED";
  readonly interventionId: string;
  readonly stepId: string;
  readonly reason: string;
  readonly handoff: {
    readonly handoffId: string;
    readonly resumeToken: string;
    readonly runId: string;
    readonly artifactId: string;
    readonly artifactVersion: string;
    readonly artifactSha256: string;
    readonly checkpointSha256: string;
    readonly completedStepIds: readonly string[];
    readonly expectedHumanPageState: string;
    readonly expectedPostHumanPageState: string;
    readonly expiresAt: string;
  };
}

export interface ReplayHandoffNotCompletedResult extends ReplayResultBase {
  readonly status: "handoff_not_completed";
  readonly code: "HANDOFF_NOT_COMPLETED";
  readonly handoffId: string;
  readonly stepId: string;
  readonly reason: string;
  readonly expiresAt: string;
}

export interface ReplayResumeRejectedResult extends ReplayResultBase {
  readonly status: "resume_rejected";
  readonly code: HandoffValidationCode | "SESSION_NOT_PAUSED";
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
  | "CHECKPOINT_FAILED"
  | "HANDOFF_EXPIRED"
  | "HANDOFF_ABANDONED"
  | "UNEXPECTED_POST_HANDOFF_STATE";

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
  | ReplayHandoffNotCompletedResult
  | ReplayResumeRejectedResult
  | ReplayFailureResult;

export type ReplayAbandonReason = "EOF" | "SIGNAL" | "EXPIRED" | "OPERATOR" | "CALLER_CLOSED";

export type { HandoffResumeRequest };

export interface ReplayExecutionContext {
  readonly artifact: CapabilityArtifact;
  readonly request: ReplayRequest;
}
