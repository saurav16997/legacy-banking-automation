/** Structured run-result variants shared by deterministic callers. */
export type RunResult =
  | { readonly status: "success"; readonly outputs: Readonly<Record<string, unknown>> }
  | { readonly status: "business_outcome"; readonly code: string }
  | { readonly status: "intervention_required"; readonly interventionId: string }
  | { readonly status: "failure"; readonly code: string; readonly message: string };

/** Deterministic outcome-classification boundary. */
export class OutcomeDetector {
  detect(_observation: unknown): RunResult | undefined {
    throw new Error("OutcomeDetector.detect is not implemented");
  }
}
