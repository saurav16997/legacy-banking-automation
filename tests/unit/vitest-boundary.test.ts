import { readFile } from "node:fs/promises";
import vitestConfig from "../../vitest.config.js";
import { describe, expect, it } from "vitest";

describe("Vitest source boundary", () => {
  it("includes only TypeScript source tests and excludes generated output", () => {
    expect(vitestConfig.test?.include).toEqual(["tests/**/*.test.ts"]);
    expect(vitestConfig.test?.exclude).toEqual(["dist/**", "node_modules/**"]);
  });

  it("keeps the documented formatter runnable while explicitly excluding unsupported EJS", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    const prettierIgnore = await readFile(".prettierignore", "utf8");

    expect(packageJson.scripts?.format).toBe("prettier --write .");
    const ignoredPaths = prettierIgnore.split(/\r?\n/u);
    expect(ignoredPaths).toContain("target_app/views/**/*.ejs");
    expect(ignoredPaths).toContain("artifacts/prepare_savings_subaccount/1.0.0/capability.json");
  });
});
