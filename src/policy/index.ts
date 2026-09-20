import {
  ActionRiskSchema,
  ControlOwnerSchema,
  type ActionRisk,
  type ControlOwner,
} from "../domain/index.js";

export type PolicyDisposition = "ALLOW" | "DENY" | "REQUIRE_INTERVENTION";

export interface PolicyDecision {
  readonly disposition: PolicyDisposition;
  readonly reason: string;
}

export interface ElementPolicySubject {
  readonly controlOwner: unknown;
  readonly actionRisk: unknown;
}

export interface TrustedControlClassification {
  readonly controlOwner: ControlOwner;
  readonly actionRisk: ActionRisk;
}

export interface ControlMetadataHint {
  readonly declaredOwner: unknown;
  readonly declaredRisk: unknown;
  readonly testId?: string;
}

export interface PolicyEngineOptions {
  readonly allowSensitiveAutomation?: boolean;
  readonly trustControlMetadata?: boolean;
  readonly trustedControlClassifications?: Readonly<Record<string, TrustedControlClassification>>;
}

/** Deterministic, fail-closed policy evaluated before live browser interaction. */
export class PolicyEngine {
  readonly #allowSensitiveAutomation: boolean;
  readonly #trustControlMetadata: boolean;
  readonly #trustedControlClassifications: Readonly<Record<string, TrustedControlClassification>>;

  constructor(options: PolicyEngineOptions = {}) {
    this.#allowSensitiveAutomation = options.allowSensitiveAutomation ?? false;
    this.#trustControlMetadata = options.trustControlMetadata ?? false;
    this.#trustedControlClassifications = options.trustedControlClassifications ?? {};
  }

  classifyControl(hint: ControlMetadataHint): TrustedControlClassification {
    const configured = hint.testId ? this.#trustedControlClassifications[hint.testId] : undefined;
    if (configured) {
      const owner = ControlOwnerSchema.safeParse(configured.controlOwner);
      const risk = ActionRiskSchema.safeParse(configured.actionRisk);
      if (owner.success && risk.success) {
        return { controlOwner: owner.data, actionRisk: risk.data };
      }
      return { controlOwner: "NONE", actionRisk: "IRREVERSIBLE" };
    }

    if (!this.#trustControlMetadata) {
      return { controlOwner: "NONE", actionRisk: "IRREVERSIBLE" };
    }

    const owner = ControlOwnerSchema.safeParse(hint.declaredOwner);
    const risk = ActionRiskSchema.safeParse(hint.declaredRisk);
    return {
      controlOwner: owner.success ? owner.data : "NONE",
      actionRisk: risk.success ? risk.data : "IRREVERSIBLE",
    };
  }

  evaluateElement(subject: ElementPolicySubject): PolicyDecision {
    const owner = ControlOwnerSchema.safeParse(subject.controlOwner);
    const risk = ActionRiskSchema.safeParse(subject.actionRisk);
    if (!owner.success || !risk.success) {
      return { disposition: "DENY", reason: "Unknown control ownership or action risk." };
    }
    if (risk.data === "IRREVERSIBLE") {
      return { disposition: "DENY", reason: "Irreversible actions are outside this capability." };
    }
    if (owner.data === "NONE") {
      return { disposition: "DENY", reason: "This control has no authorized automation owner." };
    }
    if (owner.data === "HUMAN") {
      return {
        disposition: "REQUIRE_INTERVENTION",
        reason: "This control is owned by a human operator.",
      };
    }
    if (risk.data === "SENSITIVE" && !this.#allowSensitiveAutomation) {
      return {
        disposition: "DENY",
        reason: "Sensitive automation is not enabled for this session.",
      };
    }
    return { disposition: "ALLOW", reason: "The automation action is allowed." };
  }

  evaluateNavigation(targetUrl: string, allowedOrigin: string): PolicyDecision {
    try {
      const target = new URL(targetUrl);
      if (target.origin !== allowedOrigin) {
        return { disposition: "DENY", reason: "Navigation to an external origin is blocked." };
      }
      return { disposition: "ALLOW", reason: "Same-origin navigation is allowed." };
    } catch {
      return { disposition: "DENY", reason: "The navigation target is invalid." };
    }
  }
}
