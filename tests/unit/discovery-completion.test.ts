import { describe, expect, it } from "vitest";

import { validatePrepareSavingsCompletion } from "../../src/discovery/completion-validator.js";
import { createCanonicalInputVault } from "../../src/discovery/input-vault.js";
import { makeObservation } from "../helpers/fake-surface.js";

describe("prepare_savings_subaccount completion validation", () => {
  const vault = createCanonicalInputVault("not-serialized");

  it("rejects premature completion", () => {
    const result = validatePrepareSavingsCompletion(makeObservation(), [], vault);
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.name === "page_state")?.passed).toBe(false);
  });

  it("accepts only the complete review state with the blocked final action", () => {
    const observation = makeObservation({
      url: "http://127.0.0.1:3000/members/M-10042/savings/review",
      primaryHeading: "Review Savings Subaccount",
      pageState: "ready-for-review",
      visibleText:
        "Review Savings Subaccount Morgan Redwood (M-10042) Growth Savings Vacation Fund $250.00 Everyday Checking — checking ending 1842 No account has been created.",
      elements: [
        {
          elementRef: "element-901",
          semanticTarget: { role: "button", accessibleName: "Open Account" },
          elementType: "button",
          availableOptions: [],
          disabled: false,
          controlOwner: "NONE",
          actionRisk: "IRREVERSIBLE",
          sensitive: false,
        },
      ],
    });
    const result = validatePrepareSavingsCompletion(observation, [], vault);
    expect(result.passed, JSON.stringify(result.checks)).toBe(true);
  });
});
