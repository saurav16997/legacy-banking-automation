export * from "./discovery-recorder.js";

/** Stable reference to redacted run evidence. */
export interface EvidenceReference {
  readonly evidenceId: string;
  readonly mediaType: string;
  readonly relativePath: string;
}

/** Deterministic evidence-store boundary. */
export class EvidenceStore {
  put(_content: Uint8Array, _mediaType: string): Promise<EvidenceReference> {
    throw new Error("EvidenceStore.put is not implemented");
  }
}
