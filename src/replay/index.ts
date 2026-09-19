import type { CapabilityArtifact } from "../domain/index.js";

/** Zero-model-call deterministic replay boundary. */
export class ReplayEngine {
  replay(_artifact: CapabilityArtifact): Promise<unknown> {
    throw new Error("ReplayEngine.replay is not implemented");
  }
}
