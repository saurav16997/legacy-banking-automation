import type { SurfaceAction } from "../domain/index.js";

export type PolicyDisposition = "ALLOW" | "DENY" | "REQUIRE_INTERVENTION";

/** Deterministic policy decision. */
export interface PolicyDecision {
  readonly disposition: PolicyDisposition;
  readonly reason: string;
}

/** Deterministic policy-engine boundary. */
export class PolicyEngine {
  evaluate(_action: SurfaceAction): PolicyDecision {
    throw new Error("PolicyEngine.evaluate is not implemented");
  }
}
