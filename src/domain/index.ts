import { z } from "zod";

export const ControlOwnerSchema = z.enum(["AUTOMATION", "HUMAN", "NONE"]);
export type ControlOwner = z.infer<typeof ControlOwnerSchema>;

export const ActionRiskSchema = z.enum(["SAFE", "SENSITIVE", "IRREVERSIBLE"]);
export type ActionRisk = z.infer<typeof ActionRiskSchema>;

export const SemanticRoleSchema = z.enum([
  "button",
  "link",
  "textbox",
  "combobox",
  "checkbox",
  "radio",
]);
export type SemanticRole = z.infer<typeof SemanticRoleSchema>;

export const SemanticTargetSchema = z.object({
  role: SemanticRoleSchema,
  accessibleName: z.string(),
  label: z.string().min(1).optional(),
  testId: z.string().min(1).optional(),
});
export type SemanticTarget = z.infer<typeof SemanticTargetSchema>;

export const SelectOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  selected: z.boolean(),
  disabled: z.boolean(),
});
export type SelectOption = z.infer<typeof SelectOptionSchema>;

export const ObservedElementSchema = z.object({
  elementRef: z.string().regex(/^element-\d{3,}$/),
  semanticTarget: SemanticTargetSchema,
  elementType: z.enum(["button", "link", "input", "select", "textarea"]),
  currentValue: z.string().optional(),
  availableOptions: z.array(SelectOptionSchema),
  disabled: z.boolean(),
  controlOwner: ControlOwnerSchema,
  actionRisk: ActionRiskSchema,
  sensitive: z.boolean(),
});
export type ObservedElement = z.infer<typeof ObservedElementSchema>;

export const SurfaceObservationSchema = z.object({
  observationId: z.uuid(),
  url: z.url(),
  title: z.string(),
  primaryHeading: z.string().optional(),
  pageState: z.string().min(1).optional(),
  visibleText: z.string(),
  elements: z.array(ObservedElementSchema),
  timestamp: z.iso.datetime(),
});
export type SurfaceObservation = z.infer<typeof SurfaceObservationSchema>;

const ElementCommandFields = {
  observationId: z.uuid(),
  elementRef: z.string().regex(/^element-\d{3,}$/),
};

export const SurfaceCommandSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("click"), ...ElementCommandFields }),
  z.object({ operation: z.literal("fill"), ...ElementCommandFields, value: z.string() }),
  z.object({ operation: z.literal("selectOption"), ...ElementCommandFields, option: z.string() }),
  z.object({ operation: z.literal("navigate"), url: z.string().min(1) }),
]);
export type SurfaceCommand = z.infer<typeof SurfaceCommandSchema>;

export const SurfaceActionStatusSchema = z.enum([
  "EXECUTED",
  "BLOCKED",
  "HANDOFF_REQUIRED",
  "STALE_OBSERVATION",
  "AMBIGUOUS_TARGET",
  "FAILED",
]);
export type SurfaceActionStatus = z.infer<typeof SurfaceActionStatusSchema>;

export const SurfaceActionResultSchema = z.object({
  status: SurfaceActionStatusSchema,
  message: z.string(),
  observation: SurfaceObservationSchema.optional(),
});
export type SurfaceActionResult = z.infer<typeof SurfaceActionResultSchema>;
