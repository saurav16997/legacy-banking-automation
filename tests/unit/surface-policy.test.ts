import { describe, expect, it } from "vitest";

import { SurfaceCommandSchema } from "../../src/domain/index.js";
import { PolicyEngine } from "../../src/policy/index.js";

describe("surface policy", () => {
  it("applies the ownership and risk matrix", () => {
    const defaultPolicy = new PolicyEngine();
    const sensitivePolicy = new PolicyEngine({ allowSensitiveAutomation: true });

    expect(
      defaultPolicy.evaluateElement({ controlOwner: "AUTOMATION", actionRisk: "SAFE" }).disposition,
    ).toBe("ALLOW");
    expect(
      defaultPolicy.evaluateElement({ controlOwner: "AUTOMATION", actionRisk: "SENSITIVE" })
        .disposition,
    ).toBe("DENY");
    expect(
      sensitivePolicy.evaluateElement({ controlOwner: "AUTOMATION", actionRisk: "SENSITIVE" })
        .disposition,
    ).toBe("ALLOW");
    expect(
      sensitivePolicy.evaluateElement({ controlOwner: "HUMAN", actionRisk: "SENSITIVE" })
        .disposition,
    ).toBe("REQUIRE_INTERVENTION");
    expect(
      sensitivePolicy.evaluateElement({ controlOwner: "NONE", actionRisk: "SAFE" }).disposition,
    ).toBe("DENY");
    expect(
      sensitivePolicy.evaluateElement({ controlOwner: "AUTOMATION", actionRisk: "IRREVERSIBLE" })
        .disposition,
    ).toBe("DENY");
  });

  it("fails closed for unknown metadata and external origins", () => {
    const policy = new PolicyEngine({ allowSensitiveAutomation: true });
    expect(policy.evaluateElement({ controlOwner: "ROBOT", actionRisk: "SAFE" }).disposition).toBe(
      "DENY",
    );
    expect(
      policy.evaluateElement({ controlOwner: "AUTOMATION", actionRisk: "MYSTERY" }).disposition,
    ).toBe("DENY");
    expect(
      policy.evaluateNavigation("http://localhost:3000/login", "http://localhost:3000").disposition,
    ).toBe("ALLOW");
    expect(
      policy.evaluateNavigation("https://example.com", "http://localhost:3000").disposition,
    ).toBe("DENY");
  });

  it("requires explicit trust and lets configured classifications take precedence", () => {
    const untrusted = new PolicyEngine();
    expect(
      untrusted.classifyControl({
        declaredOwner: "AUTOMATION",
        declaredRisk: "SAFE",
      }),
    ).toEqual({ controlOwner: "NONE", actionRisk: "IRREVERSIBLE" });

    const trustedMetadata = new PolicyEngine({ trustControlMetadata: true });
    expect(trustedMetadata.classifyControl({ declaredOwner: null, declaredRisk: null })).toEqual({
      controlOwner: "NONE",
      actionRisk: "IRREVERSIBLE",
    });
    expect(
      trustedMetadata.classifyControl({ declaredOwner: "ROBOT", declaredRisk: "MYSTERY" }),
    ).toEqual({ controlOwner: "NONE", actionRisk: "IRREVERSIBLE" });
    expect(
      trustedMetadata.classifyControl({
        declaredOwner: "AUTOMATION",
        declaredRisk: "SAFE",
      }),
    ).toEqual({ controlOwner: "AUTOMATION", actionRisk: "SAFE" });

    const configured = new PolicyEngine({
      trustedControlClassifications: {
        "approved-control": { controlOwner: "AUTOMATION", actionRisk: "SAFE" },
      },
    });
    expect(
      configured.classifyControl({
        declaredOwner: "NONE",
        declaredRisk: "IRREVERSIBLE",
        testId: "approved-control",
      }),
    ).toEqual({ controlOwner: "AUTOMATION", actionRisk: "SAFE" });
  });

  it("exposes only the closed command vocabulary", () => {
    expect(
      SurfaceCommandSchema.safeParse({ operation: "evaluate", script: "document.body" }).success,
    ).toBe(false);
    expect(
      SurfaceCommandSchema.safeParse({ operation: "click", selector: "#submit" }).success,
    ).toBe(false);
    expect(
      SurfaceCommandSchema.safeParse({
        operation: "click",
        observationId: crypto.randomUUID(),
        elementRef: "element-001",
      }).success,
    ).toBe(true);
  });
});
