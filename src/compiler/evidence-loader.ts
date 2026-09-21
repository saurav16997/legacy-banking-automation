import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  DiscoveryFailureSchema,
  DiscoveryTrajectorySchema,
  type DiscoveryTrajectory,
} from "../discovery/contracts.js";
import { CapabilityCompilerError } from "./contracts.js";
import { sha256 } from "./canonical-json.js";

const RUN_ID_PATTERN = /^discovery-[0-9]{14}-[a-f0-9]{8}$/;

const ManifestEntrySchema = z
  .object({
    path: z.string().min(1),
    mediaType: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

const EvidenceManifestSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    runId: z.string().min(1),
    files: z.array(ManifestEntrySchema).min(1),
  })
  .strict();

const EvidenceSummarySchema = z
  .object({
    runId: z.string().min(1),
    status: z.string().min(1),
    actionCount: z.number().int().nonnegative(),
    finalPageState: z.string().min(1).optional(),
    failure: DiscoveryFailureSchema.optional(),
  })
  .strict();

const KNOWN_ACTION_TYPES = new Set([
  "observe_surface",
  "click_element",
  "fill_element_from_input",
  "select_option_from_input",
  "navigate_same_origin",
  "complete_discovery",
]);

export interface VerifiedDiscoveryEvidence {
  readonly evidenceDirectory: string;
  readonly trajectory: DiscoveryTrajectory;
  readonly trajectoryBytes: Uint8Array;
  readonly trajectorySha256: string;
  readonly summary: z.infer<typeof EvidenceSummarySchema>;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function parseJson(content: Uint8Array, code: "MANIFEST_INVALID" | "INVALID_TRAJECTORY"): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(content));
  } catch {
    throw new CapabilityCompilerError(code, "A required JSON evidence file is invalid.");
  }
}

function validateManifestPath(relativePath: string): void {
  if (
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath) ||
    relativePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new CapabilityCompilerError(
      "SOURCE_PATH_OUTSIDE_EVIDENCE",
      "An evidence manifest path is not a safe relative path.",
    );
  }
}

function inspectRawTrajectory(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CapabilityCompilerError("INVALID_TRAJECTORY", "The trajectory root is invalid.");
  }
  const root = value as Record<string, unknown>;
  if (root.schemaVersion !== "1.0.0") {
    throw new CapabilityCompilerError(
      "UNSUPPORTED_TRAJECTORY_VERSION",
      "The discovery trajectory schema version is unsupported.",
    );
  }
  if (!Array.isArray(root.events)) return;
  for (const event of root.events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const record = event as Record<string, unknown>;
    if (typeof record.actionType === "string" && !KNOWN_ACTION_TYPES.has(record.actionType)) {
      throw new CapabilityCompilerError(
        "UNKNOWN_OPERATION",
        "The trajectory contains an unknown discovery operation.",
      );
    }
    for (const forbidden of ["value", "option", "resolvedValue", "literalValue"]) {
      if (Object.hasOwn(record, forbidden)) {
        throw new CapabilityCompilerError(
          "LITERAL_VALUE_FORBIDDEN",
          "A trajectory event contains a forbidden literal-value field.",
        );
      }
    }
  }
}

export async function loadVerifiedDiscoveryEvidence(
  evidenceDiscoveryRoot: string,
  runId: string,
): Promise<VerifiedDiscoveryEvidence> {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new CapabilityCompilerError("INVALID_RUN_ID", "The discovery run ID is invalid.");
  }

  let root: string;
  try {
    root = await realpath(evidenceDiscoveryRoot);
  } catch {
    throw new CapabilityCompilerError(
      "EVIDENCE_NOT_FOUND",
      "The discovery evidence root does not exist.",
    );
  }
  const unresolvedDirectory = path.resolve(root, runId);
  if (!isInside(root, unresolvedDirectory)) {
    throw new CapabilityCompilerError(
      "SOURCE_PATH_OUTSIDE_EVIDENCE",
      "The discovery run path escapes the evidence root.",
    );
  }

  let evidenceDirectory: string;
  try {
    evidenceDirectory = await realpath(unresolvedDirectory);
    if (!(await stat(evidenceDirectory)).isDirectory()) throw new Error("not-directory");
  } catch {
    throw new CapabilityCompilerError("EVIDENCE_NOT_FOUND", "The discovery run was not found.");
  }
  if (!isInside(root, evidenceDirectory)) {
    throw new CapabilityCompilerError(
      "SOURCE_PATH_OUTSIDE_EVIDENCE",
      "The discovery run resolves outside the evidence root.",
    );
  }

  let manifestBytes: Uint8Array;
  try {
    manifestBytes = await readFile(path.join(evidenceDirectory, "manifest.json"));
  } catch {
    throw new CapabilityCompilerError("MANIFEST_INVALID", "The evidence manifest is missing.");
  }
  const manifestResult = EvidenceManifestSchema.safeParse(
    parseJson(manifestBytes, "MANIFEST_INVALID"),
  );
  if (!manifestResult.success || manifestResult.data.runId !== runId) {
    throw new CapabilityCompilerError("MANIFEST_INVALID", "The evidence manifest is invalid.");
  }
  const manifest = manifestResult.data;
  const listedPaths = new Set<string>();
  const contents = new Map<string, Uint8Array>();

  for (const entry of manifest.files) {
    validateManifestPath(entry.path);
    if (listedPaths.has(entry.path)) {
      throw new CapabilityCompilerError(
        "MANIFEST_INVALID",
        "The evidence manifest contains a duplicate path.",
      );
    }
    listedPaths.add(entry.path);
    const unresolvedFile = path.resolve(evidenceDirectory, entry.path);
    if (!isInside(evidenceDirectory, unresolvedFile)) {
      throw new CapabilityCompilerError(
        "SOURCE_PATH_OUTSIDE_EVIDENCE",
        "An evidence file path escapes the run directory.",
      );
    }
    let resolvedFile: string;
    let content: Uint8Array;
    try {
      resolvedFile = await realpath(unresolvedFile);
      if (!isInside(evidenceDirectory, resolvedFile)) throw new Error("outside");
      content = await readFile(resolvedFile);
    } catch {
      throw new CapabilityCompilerError(
        "MANIFEST_INTEGRITY_FAILED",
        "A manifest-listed evidence file is missing or unsafe.",
      );
    }
    if (content.byteLength !== entry.bytes || sha256(content) !== entry.sha256) {
      throw new CapabilityCompilerError(
        "MANIFEST_INTEGRITY_FAILED",
        "An evidence file does not match its manifest digest or size.",
      );
    }
    contents.set(entry.path, content);
  }

  const actualFiles = (await readdir(evidenceDirectory)).sort();
  const expectedFiles = [...listedPaths, "manifest.json"].sort();
  if (
    actualFiles.length !== expectedFiles.length ||
    actualFiles.some((filename, index) => filename !== expectedFiles[index])
  ) {
    throw new CapabilityCompilerError(
      "MANIFEST_INTEGRITY_FAILED",
      "The evidence directory contains missing or unlisted files.",
    );
  }

  const trajectoryBytes = contents.get("trajectory.json");
  const summaryBytes = contents.get("summary.json");
  const trajectoryEntry = manifest.files.find((entry) => entry.path === "trajectory.json");
  if (!trajectoryBytes || !summaryBytes || !trajectoryEntry) {
    throw new CapabilityCompilerError(
      "MANIFEST_INVALID",
      "The manifest must include trajectory.json and summary.json.",
    );
  }
  if (trajectoryEntry.mediaType !== "application/json") {
    throw new CapabilityCompilerError(
      "MANIFEST_INVALID",
      "The trajectory manifest media type is invalid.",
    );
  }

  const rawTrajectory = parseJson(trajectoryBytes, "INVALID_TRAJECTORY");
  inspectRawTrajectory(rawTrajectory);
  const trajectoryResult = DiscoveryTrajectorySchema.safeParse(rawTrajectory);
  if (!trajectoryResult.success) {
    throw new CapabilityCompilerError(
      "INVALID_TRAJECTORY",
      "The discovery trajectory does not satisfy its schema.",
    );
  }
  const summaryResult = EvidenceSummarySchema.safeParse(
    parseJson(summaryBytes, "INVALID_TRAJECTORY"),
  );
  if (!summaryResult.success) {
    throw new CapabilityCompilerError("INVALID_TRAJECTORY", "The discovery summary is invalid.");
  }
  const trajectory = trajectoryResult.data;
  const summary = summaryResult.data;
  if (
    trajectory.runId !== runId ||
    summary.runId !== runId ||
    summary.status !== trajectory.finalStatus
  ) {
    throw new CapabilityCompilerError(
      "INVALID_TRAJECTORY",
      "The evidence run identifiers or statuses do not agree.",
    );
  }
  const trajectorySha256 = sha256(trajectoryBytes);
  if (trajectorySha256 !== trajectoryEntry.sha256) {
    throw new CapabilityCompilerError(
      "TRAJECTORY_DIGEST_MISMATCH",
      "The source trajectory digest does not match the verified manifest.",
    );
  }
  return {
    evidenceDirectory,
    trajectory,
    trajectoryBytes,
    trajectorySha256,
    summary,
  };
}
