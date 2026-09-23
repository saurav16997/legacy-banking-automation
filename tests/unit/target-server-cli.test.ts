import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTargetApp,
  formatTargetServerStartupMessage,
  parseTargetServerArguments,
} from "../../target_app/server.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("target server CLI", () => {
  it("provides explicit normal and handoff scripts", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["target:start"]).toBe(
      "tsx target_app/server.ts --scenario=normal",
    );
    expect(packageJson.scripts?.["target:start:handoff"]).toBe(
      "tsx target_app/server.ts --scenario=identity_verification_on_review",
    );
  });

  it.each(["normal", "identity_verification_on_review", "ambiguous_continue_control"] as const)(
    "parses the %s scenario",
    (scenario) => {
      expect(parseTargetServerArguments([`--scenario=${scenario}`])).toEqual({ scenario });
      expect(parseTargetServerArguments(["--scenario", scenario])).toEqual({ scenario });
    },
  );

  it("reports the selected scenario in the startup message", () => {
    expect(formatTargetServerStartupMessage(3000, "normal")).toBe(
      "Synthetic credit-union portal listening at http://localhost:3000 (scenario: normal)",
    );
  });

  it("rejects invalid scenarios, options, missing values, and duplicates", () => {
    expect(() => parseTargetServerArguments(["--scenario=unexpected"])).toThrow(
      "Unknown target scenario.",
    );
    expect(() => parseTargetServerArguments(["--scenario"])).toThrow(
      "--scenario requires a value.",
    );
    expect(() => parseTargetServerArguments(["--unknown"])).toThrow(
      "Unknown target server option: --unknown",
    );
    expect(() => parseTargetServerArguments(["--scenario=normal", "--scenario=normal"])).toThrow(
      "--scenario may be specified only once.",
    );
  });

  it("lets an explicit scenario override the environment while preserving the environment fallback", () => {
    vi.stubEnv("TARGET_SCENARIO", "identity_verification_on_review");

    expect(createTargetApp({ scenario: "normal" }).scenario).toBe("normal");
    expect(createTargetApp().scenario).toBe("identity_verification_on_review");
  });
});
