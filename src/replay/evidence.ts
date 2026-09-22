import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalStringify } from "../compiler/canonical-json.js";
import type {
  ReplayEvidenceContext,
  ReplayEvidenceEvent,
  ReplayEvidenceSink,
  ReplayEvidenceSummary,
  ReplayHandoffEvidenceRecord,
} from "./contracts.js";

export class NullReplayEvidenceSink implements ReplayEvidenceSink {
  initialize(_context: ReplayEvidenceContext): Promise<void> {
    return Promise.resolve();
  }

  append(_event: ReplayEvidenceEvent): Promise<void> {
    return Promise.resolve();
  }

  writeScreenshot(name: string, _bytes: Uint8Array): Promise<string> {
    return Promise.resolve(`memory://${name}`);
  }

  writeInterimHandoff(_record: ReplayHandoffEvidenceRecord): Promise<string> {
    return Promise.resolve("memory://handoff.json");
  }

  finalize(_summary: ReplayEvidenceSummary): Promise<void> {
    return Promise.resolve();
  }
}

export class FileReplayEvidenceSink implements ReplayEvidenceSink {
  readonly #root: string;
  #directory: string | undefined;
  #eventsPath: string | undefined;
  #finalized = false;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  get directory(): string | undefined {
    return this.#directory;
  }

  async initialize(context: ReplayEvidenceContext): Promise<void> {
    if (!/^replay-[0-9]{14}-[a-f0-9]{8}$/.test(context.runId)) {
      throw new Error("Replay evidence received an invalid run ID.");
    }
    const directory = path.resolve(this.#root, context.runId);
    if (path.dirname(directory) !== this.#root) {
      throw new Error("Replay evidence path escaped its configured root.");
    }
    await mkdir(path.join(directory, "screenshots"), { recursive: true });
    this.#directory = directory;
    this.#finalized = false;
    this.#eventsPath = path.join(directory, "events.jsonl");
    await writeFile(this.#eventsPath, "", { encoding: "utf8", flag: "wx" });
    await writeFile(path.join(directory, "context.json"), `${canonicalStringify(context)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  }

  async append(event: ReplayEvidenceEvent): Promise<void> {
    if (!this.#eventsPath) throw new Error("Replay evidence has not been initialized.");
    if (this.#finalized) throw new Error("Replay evidence has already been finalized.");
    await appendFile(this.#eventsPath, `${canonicalStringify(event)}\n`, "utf8");
  }

  async writeScreenshot(name: string, bytes: Uint8Array): Promise<string> {
    if (!this.#directory) throw new Error("Replay evidence has not been initialized.");
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "-");
    const relativePath = path.posix.join("screenshots", `${safeName}.png`);
    const absolutePath = path.join(this.#directory, ...relativePath.split("/"));
    await writeFile(absolutePath, bytes, { flag: "wx" });
    return relativePath;
  }

  async writeInterimHandoff(record: ReplayHandoffEvidenceRecord): Promise<string> {
    if (!this.#directory) throw new Error("Replay evidence has not been initialized.");
    if (this.#finalized) throw new Error("Replay evidence has already been finalized.");
    const relativePath = "handoff.json";
    await writeFile(path.join(this.#directory, relativePath), `${canonicalStringify(record)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return relativePath;
  }

  async finalize(summary: ReplayEvidenceSummary): Promise<void> {
    if (!this.#directory) throw new Error("Replay evidence has not been initialized.");
    if (this.#finalized) throw new Error("Replay evidence has already been finalized.");
    await writeFile(
      path.join(this.#directory, "summary.json"),
      `${canonicalStringify(summary)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    this.#finalized = true;
  }
}
