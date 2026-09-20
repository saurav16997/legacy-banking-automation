import { z } from "zod";

import { SemanticTargetSchema, SurfaceObservationSchema } from "../domain/index.js";

export const DiscoveryStatusSchema = z.enum([
  "SUCCESS",
  "HANDOFF_REQUIRED",
  "BLOCKED",
  "MAX_STEPS",
  "TIMED_OUT",
  "FAILED",
]);
export type DiscoveryStatus = z.infer<typeof DiscoveryStatusSchema>;

export const DiscoveryInputDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  sensitive: z.boolean(),
});
export type DiscoveryInputDefinition = z.infer<typeof DiscoveryInputDefinitionSchema>;

export const CompletionCheckSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  message: z.string(),
});
export type CompletionCheck = z.infer<typeof CompletionCheckSchema>;

export const CompletionValidationSchema = z.object({
  passed: z.boolean(),
  checks: z.array(CompletionCheckSchema),
});
export type CompletionValidation = z.infer<typeof CompletionValidationSchema>;

export const DiscoveryFailureCategorySchema = z.enum([
  "AUTHENTICATION_FAILED",
  "MODEL_UNAVAILABLE",
  "RATE_LIMITED",
  "INVALID_REQUEST_SCHEMA",
  "SDK_ERROR",
  "INVALID_AGENT_OUTPUT",
  "INTERNAL_ERROR",
]);
export type DiscoveryFailureCategory = z.infer<typeof DiscoveryFailureCategorySchema>;

export const DiscoveryFailureStageSchema = z.enum([
  "BEFORE_MODEL_REQUEST",
  "DURING_MODEL_REQUEST",
  "PARSING_STRUCTURED_OUTPUT",
  "BEFORE_FIRST_TOOL_CALL",
  "INTERNAL",
]);
export type DiscoveryFailureStage = z.infer<typeof DiscoveryFailureStageSchema>;

export const DiscoveryFailureSchema = z.object({
  category: DiscoveryFailureCategorySchema,
  stage: DiscoveryFailureStageSchema,
  errorType: z.string().min(1),
  apiStatus: z.number().int().min(100).max(599).optional(),
  apiCode: z.string().min(1).optional(),
  apiType: z.string().min(1).optional(),
  apiParam: z.string().min(1).optional(),
});
export type DiscoveryFailure = z.infer<typeof DiscoveryFailureSchema>;

export const DiscoveryEventSchema = z.object({
  sequence: z.number().int().positive(),
  timestamp: z.iso.datetime(),
  observationId: z.string().optional(),
  actionType: z.enum([
    "observe_surface",
    "click_element",
    "fill_element_from_input",
    "select_option_from_input",
    "navigate_same_origin",
    "complete_discovery",
  ]),
  elementRef: z.string().optional(),
  semanticTarget: SemanticTargetSchema.optional(),
  controlOwner: z.enum(["AUTOMATION", "HUMAN", "NONE"]).optional(),
  actionRisk: z.enum(["SAFE", "SENSITIVE", "IRREVERSIBLE"]).optional(),
  inputRef: z.string().optional(),
  sanitizedResult: z.record(z.string(), z.unknown()),
  resultingPageState: z.string().optional(),
  durationMs: z.number().nonnegative(),
  evidenceRef: z.string().optional(),
});
export type DiscoveryEvent = z.infer<typeof DiscoveryEventSchema>;

export const DiscoveryTrajectorySchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  runId: z.string().min(1),
  capability: z.literal("prepare_savings_subaccount"),
  sanitizedGoal: z.string(),
  inputs: z.array(DiscoveryInputDefinitionSchema),
  model: z.string(),
  adapterVersion: z.string(),
  policyVersion: z.string(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  finalStatus: DiscoveryStatusSchema,
  events: z.array(DiscoveryEventSchema),
  finalObservation: SurfaceObservationSchema.optional(),
  completionValidation: CompletionValidationSchema.optional(),
  failure: DiscoveryFailureSchema.optional(),
  terminalReason: z.string().optional(),
});
export type DiscoveryTrajectory = z.infer<typeof DiscoveryTrajectorySchema>;

export const DiscoveryAgentFinalOutputSchema = z
  .object({
    status: z.enum(["SUCCESS", "HANDOFF_REQUIRED", "BLOCKED", "FAILED"]),
    summary: z.string(),
  })
  .strict();
export type DiscoveryAgentFinalOutput = z.infer<typeof DiscoveryAgentFinalOutputSchema>;

export const ObserveSurfaceInputSchema = z.object({}).strict();
export const ElementToolInputSchema = z
  .object({
    observationId: z.uuid(),
    elementRef: z.string().regex(/^element-\d{3,}$/),
  })
  .strict();
export const InputElementToolInputSchema = ElementToolInputSchema.extend({
  inputRef: z.string().min(1),
}).strict();
export const InputElementToolParameterSchema = ElementToolInputSchema.extend({
  inputRef: z.string(),
}).strict();
export const NavigateToolInputSchema = z.object({ path: z.string().regex(/^\/(?!\/)/) }).strict();
export const NavigateToolParameterSchema = z.object({ path: z.string() }).strict();
export const CompleteDiscoveryInputSchema = z.object({}).strict();

export type ElementToolInput = z.infer<typeof ElementToolInputSchema>;
export type InputElementToolInput = z.infer<typeof InputElementToolInputSchema>;
export type NavigateToolInput = z.infer<typeof NavigateToolInputSchema>;

export interface DiscoveryLimits {
  readonly maxModelTurns: number;
  readonly maxBrowserActions: number;
  readonly maxDurationMs: number;
  readonly maxRepeatedActions: number;
}

export const DEFAULT_DISCOVERY_LIMITS: DiscoveryLimits = {
  maxModelTurns: 24,
  maxBrowserActions: 30,
  maxDurationMs: 180_000,
  maxRepeatedActions: 2,
};
