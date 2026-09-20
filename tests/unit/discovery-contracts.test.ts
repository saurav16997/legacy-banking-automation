import { describe, expect, it } from "vitest";

import { readDiscoveryRuntimeConfig, RuntimeConfigurationError } from "../../src/cli/index.js";
import {
  ElementToolInputSchema,
  InputElementToolInputSchema,
  NavigateToolInputSchema,
  ObserveSurfaceInputSchema,
} from "../../src/discovery/contracts.js";
import {
  createCanonicalInputVault,
  UnknownInputReferenceError,
} from "../../src/discovery/input-vault.js";

describe("discovery contracts and input vault", () => {
  it("accepts only the supported strict tool fields", () => {
    const element = { observationId: crypto.randomUUID(), elementRef: "element-001" };
    expect(ElementToolInputSchema.safeParse(element).success).toBe(true);
    expect(ElementToolInputSchema.safeParse({ ...element, selector: "#secret" }).success).toBe(
      false,
    );
    expect(
      InputElementToolInputSchema.safeParse({ ...element, inputRef: "member_id" }).success,
    ).toBe(true);
    expect(InputElementToolInputSchema.safeParse({ ...element, value: "M-10042" }).success).toBe(
      false,
    );
    expect(NavigateToolInputSchema.safeParse({ path: "/dashboard" }).success).toBe(true);
    expect(NavigateToolInputSchema.safeParse({ path: "https://example.com" }).success).toBe(false);
    expect(ObserveSurfaceInputSchema.safeParse({ selector: "body" }).success).toBe(false);
  });

  it("fails closed for unknown references and redacts inputs and protected display values", () => {
    const vault = createCanonicalInputVault("vault-only-password");
    expect(() => vault.resolve("unknown_input")).toThrow(UnknownInputReferenceError);
    const sanitized = vault.sanitize({
      message:
        "password=vault-only-password member=M-10042 name=Morgan Redwood amount=250.00 account=ending 1842",
    });
    const json = JSON.stringify(sanitized);
    expect(json).not.toContain("vault-only-password");
    expect(json).not.toContain("M-10042");
    expect(json).not.toContain("250.00");
    expect(json).not.toContain("Morgan Redwood");
    expect(json).not.toContain("1842");
    expect(json).toContain("[REDACTED:portal_password]");
    expect(json).toContain("[REDACTED:member_name]");
    expect(json).toContain("[REDACTED:funding_account_suffix]");
    expect(JSON.stringify(vault.sanitize("demo.operator"))).toContain("[INPUT:operator_username]");
  });

  it("reports missing runtime variable names without values", () => {
    const environment = {
      OPENAI_API_KEY: "top-secret-api-key",
      OPENAI_MODEL: "",
      TARGET_BASE_URL: "http://localhost:3000",
      PORTAL_PASSWORD: "top-secret-password",
    };
    let error: unknown;
    try {
      readDiscoveryRuntimeConfig(environment, ["--task", "prepare_savings_subaccount"]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RuntimeConfigurationError);
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("OPENAI_MODEL");
    expect(message).not.toContain("top-secret-api-key");
    expect(message).not.toContain("top-secret-password");
  });
});
