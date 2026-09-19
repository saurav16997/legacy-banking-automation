import { z } from "zod";

/** The only valid owners of the shared browser surface. */
export const ControlOwnerSchema = z.enum(["AUTOMATION", "HUMAN", "NONE"]);
export type ControlOwner = z.infer<typeof ControlOwnerSchema>;

/** Closed action vocabulary proposed through bounded discovery tools. */
export const SurfaceActionSchema = z.object({
  operation: z.enum(["navigate", "click", "fill", "select", "wait", "extract", "assert"]),
  target: z.string().min(1),
  value: z.string().optional(),
});
export type SurfaceAction = z.infer<typeof SurfaceActionSchema>;

/** Sanitized observation exposed across the surface boundary. */
export const SurfaceObservationSchema = z.object({
  url: z.url(),
  title: z.string(),
  visibleText: z.string(),
  interactiveTargets: z.array(z.string()),
});
export type SurfaceObservation = z.infer<typeof SurfaceObservationSchema>;

/** Minimal artifact envelope; the JSON Schema is authoritative. */
export const CapabilityArtifactSchema = z.object({
  schema_version: z.literal("1.0.0"),
  artifact_id: z.string().min(3),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  steps: z.array(z.record(z.string(), z.unknown())),
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;
