import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("deterministic replay dependency boundary", () => {
  it("does not import the Agents SDK or discovery runtime", async () => {
    const sources = await Promise.all(
      ["index.ts", "contracts.ts", "evidence.ts"].map(async (file) =>
        readFile(path.resolve("src", "replay", file), "utf8"),
      ),
    );
    const replaySource = sources.join("\n");

    expect(replaySource).not.toContain("@openai/agents");
    expect(replaySource).not.toMatch(/from ["'][^"']*discovery/);
  });
});
