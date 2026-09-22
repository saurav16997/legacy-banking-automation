import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const EXPECTED_ARTIFACT_SHA256 = "6b69efff71733dd1da104a822cb2da75a0372d9e55582aa0a372233cedf61c83";
const examplesRoot = path.resolve("evidence/examples");

interface ManifestFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly source: string;
}

interface EvidenceManifest {
  readonly artifact: {
    readonly id: string;
    readonly version: string;
    readonly sha256: string;
  };
  readonly sources: Record<string, unknown>;
  readonly files: ManifestFile[];
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path.join(directory, entry.name), relativePath)));
    } else {
      files.push(relativePath);
    }
  }
  return files.sort();
}

describe("curated submission evidence", () => {
  it("keeps the curated capability byte-identical to the canonical artifact", async () => {
    const canonical = await readFile(
      path.resolve("artifacts/prepare_savings_subaccount/1.0.0/capability.json"),
    );
    const curated = await readFile(path.join(examplesRoot, "capability.json"));

    expect(curated.equals(canonical)).toBe(true);
    expect(sha256(curated)).toBe(EXPECTED_ARTIFACT_SHA256);
  });

  it("verifies every manifest entry and rejects unlisted example files", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(examplesRoot, "manifest.json"), "utf8"),
    ) as EvidenceManifest;

    expect(manifest.artifact).toEqual({
      id: "prepare_savings_subaccount",
      version: "1.0.0",
      sha256: EXPECTED_ARTIFACT_SHA256,
    });
    expect(Object.keys(manifest.sources).sort()).toEqual([
      "artifact",
      "discovery",
      "replayBusinessOutcome",
      "replayHandoff",
      "replaySuccess",
    ]);

    const listedPaths = manifest.files.map((entry) => entry.path).sort();
    const actualPaths = (await listFiles(examplesRoot)).filter(
      (relativePath) => relativePath !== "manifest.json",
    );
    expect(listedPaths).toEqual(actualPaths);

    for (const entry of manifest.files) {
      expect(entry.path).not.toMatch(/(?:^|\/)\.\.(?:\/|$)|\\/u);
      expect(manifest.sources).toHaveProperty(entry.source);
      const content = await readFile(path.join(examplesRoot, ...entry.path.split("/")));
      expect(content.byteLength, entry.path).toBe(entry.bytes);
      expect(sha256(content), entry.path).toBe(entry.sha256);
    }
  });

  it("keeps curated text evidence free of resolved or browser-private data", async () => {
    const textPaths = (await listFiles(examplesRoot)).filter(
      (relativePath) => relativePath.endsWith(".json") || relativePath.endsWith(".jsonl"),
    );
    const combined = (
      await Promise.all(
        textPaths.map((relativePath) =>
          readFile(path.join(examplesRoot, ...relativePath.split("/")), "utf8"),
        ),
      )
    ).join("\n");

    expect(combined).not.toMatch(/(?<![A-Z0-9])M-\d{5}(?!\d)/u);
    expect(combined).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/u);
    expect(combined).not.toMatch(/<(?:!doctype|html|body|form)\b/iu);
    expect(combined).not.toMatch(
      /"(?:authorization|resumeToken|rawToken|verificationCode|resolvedValue|literalValue|inputValue|selector|cssSelector|xpath|providerMessage|messages|responseBody)"\s*:/iu,
    );
  });
});
