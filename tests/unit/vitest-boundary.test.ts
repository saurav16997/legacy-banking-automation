import vitestConfig from "../../vitest.config.js";
import { describe, expect, it } from "vitest";

describe("Vitest source boundary", () => {
  it("includes only TypeScript source tests and excludes generated output", () => {
    expect(vitestConfig.test?.include).toEqual(["tests/**/*.test.ts"]);
    expect(vitestConfig.test?.exclude).toEqual(["dist/**", "node_modules/**"]);
  });
});
