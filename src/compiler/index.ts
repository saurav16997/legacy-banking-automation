import type { CapabilityArtifact } from "../domain/index.js";

/** Deterministic artifact compiler boundary. */
export class ArtifactCompiler {
  compile(_events: readonly unknown[]): CapabilityArtifact {
    throw new Error("ArtifactCompiler.compile is not implemented");
  }
}
