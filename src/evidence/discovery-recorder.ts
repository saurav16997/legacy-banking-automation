import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DiscoveryFailure, DiscoveryTrajectory } from "../discovery/contracts.js";

interface ManifestEntry {
  readonly path: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface DiscoveryEvidenceSummary {
  readonly runId: string;
  readonly status: string;
  readonly actionCount: number;
  readonly finalPageState?: string;
  readonly failure?: DiscoveryFailure;
}

export class DiscoveryEvidenceRecorder {
  readonly #directory: string;
  readonly #files: ManifestEntry[] = [];
  #screenshotSequence = 0;

  constructor(rootDirectory: string, runId: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid discovery run ID.");
    this.#directory = path.resolve(rootDirectory, "discovery", runId);
  }

  get directory(): string {
    return this.#directory;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
  }

  async recordScreenshot(label: string, content: Uint8Array): Promise<string> {
    this.#screenshotSequence += 1;
    const safeLabel = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const filename = `${String(this.#screenshotSequence).padStart(3, "0")}-${safeLabel || "surface"}.png`;
    await this.#write(filename, content, "image/png");
    return filename;
  }

  async finalize(
    trajectory: DiscoveryTrajectory,
    summary: DiscoveryEvidenceSummary,
  ): Promise<void> {
    await this.#writeJson("trajectory.json", trajectory);
    await this.#writeJson("summary.json", summary);
    const manifest = {
      schemaVersion: "1.0.0",
      runId: trajectory.runId,
      files: this.#files,
    };
    await writeFile(
      path.join(this.#directory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  }

  async #writeJson(filename: string, value: unknown): Promise<void> {
    const content = new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
    await this.#write(filename, content, "application/json");
  }

  async #write(filename: string, content: Uint8Array, mediaType: string): Promise<void> {
    await writeFile(path.join(this.#directory, filename), content);
    this.#files.push({
      path: filename,
      mediaType,
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: content.byteLength,
    });
  }
}
