import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import { config as loadDotenv } from "dotenv";

import { PlaywrightSurface } from "../browser/index.js";
import type { CapabilityArtifact } from "../compiler/contracts.js";
import { validateCapabilityArtifact } from "../compiler/schema-validator.js";
import {
  FileReplayEvidenceSink,
  ReplayEngine,
  type ReplayInterventionRequiredResult,
  type ReplayResult,
} from "../replay/index.js";
import { readReplayInputs } from "./replay-prepare.js";

export type TerminalAcknowledgement = "ACKNOWLEDGED" | "EOF" | "SIGNAL" | "EXPIRED";

interface SignalSource {
  once(event: "SIGINT", listener: () => void): unknown;
  removeListener(event: "SIGINT", listener: () => void): unknown;
}

export interface TerminalWaitOptions {
  readonly expiresAtMs: number;
  readonly now?: () => number;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly signalSource?: SignalSource;
}

interface HandoffCliArguments {
  readonly allowDraft: boolean;
  readonly artifactPath?: string;
  readonly help: boolean;
}

export const HANDOFF_REPLAY_HELP = `Usage: npm run replay:prepare:handoff

The task-specific command runs headed deterministic replay with an explicit local DRAFT override.
Complete identity verification only in the open browser, then press Enter in this terminal.
`;

export function parseHandoffReplayArguments(arguments_: readonly string[]): HandoffCliArguments {
  let allowDraft = false;
  let help = false;
  let artifactPath: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--allow-draft") allowDraft = true;
    else if (argument === "--help") help = true;
    else if (argument === "--artifact") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--artifact requires a path.");
      artifactPath = value;
      index += 1;
    } else if (argument?.startsWith("--artifact=")) {
      artifactPath = argument.slice("--artifact=".length);
      if (!artifactPath) throw new Error("--artifact requires a path.");
    } else {
      throw new Error(`Unknown handoff replay option: ${argument ?? ""}`);
    }
  }
  return { allowDraft, help, ...(artifactPath ? { artifactPath } : {}) };
}

export function waitForTerminalAcknowledgement(
  options: TerminalWaitOptions,
): Promise<TerminalAcknowledgement> {
  const now = options.now ?? Date.now;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const signalSource = options.signalSource ?? process;
  const remainingMs = options.expiresAtMs - now();
  if (remainingMs <= 0) return Promise.resolve("EXPIRED");

  return new Promise((resolve) => {
    const readline = createInterface({ input, crlfDelay: Infinity });
    let settled = false;
    const finish = (result: TerminalAcknowledgement): void => {
      if (settled) return;
      settled = true;
      clearTimeout(expiration);
      signalSource.removeListener("SIGINT", onSignal);
      readline.close();
      resolve(result);
    };
    const onSignal = (): void => {
      finish("SIGNAL");
    };
    const expiration = setTimeout(() => {
      finish("EXPIRED");
    }, remainingMs);
    expiration.unref();
    signalSource.once("SIGINT", onSignal);
    readline.on("line", (line) => {
      if (line.length === 0) finish("ACKNOWLEDGED");
      else {
        output.write(
          "Terminal input was ignored. Complete verification in the browser, then press Enter on an empty line.\n",
        );
      }
    });
    readline.on("close", () => {
      finish("EOF");
    });
  });
}

function resumeRequest(result: ReplayInterventionRequiredResult) {
  return {
    handoffId: result.handoff.handoffId,
    resumeToken: result.handoff.resumeToken,
    runId: result.handoff.runId,
    artifactId: result.handoff.artifactId,
    artifactVersion: result.handoff.artifactVersion,
    artifactSha256: result.handoff.artifactSha256,
    checkpointSha256: result.handoff.checkpointSha256,
    completedStepIds: result.handoff.completedStepIds,
  } as const;
}

export async function driveHandoffLifecycle(
  engine: ReplayEngine,
  intervention: ReplayInterventionRequiredResult,
  waitForAcknowledgement: (expiresAtMs: number) => Promise<TerminalAcknowledgement>,
  write: (message: string) => void,
): Promise<ReplayResult> {
  const request = resumeRequest(intervention);
  const expiresAtMs = Date.parse(intervention.handoff.expiresAt);
  for (;;) {
    const acknowledgement = await waitForAcknowledgement(expiresAtMs);
    if (acknowledgement !== "ACKNOWLEDGED") {
      const reason =
        acknowledgement === "EXPIRED" ? "EXPIRED" : acknowledgement === "SIGNAL" ? "SIGNAL" : "EOF";
      return (await engine.abandon(reason)) ?? intervention;
    }
    const result = await engine.resume(request);
    if (result.status !== "handoff_not_completed") return result;
    write(
      "Verification is still required in the open browser. Complete it there, then press Enter on an empty line.\n",
    );
  }
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export async function runReplayPrepareHandoffCli(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<number> {
  const cli = parseHandoffReplayArguments(arguments_);
  if (cli.help) {
    process.stdout.write(HANDOFF_REPLAY_HELP);
    return 0;
  }
  if (!cli.allowDraft) throw new Error("The local DRAFT replay requires --allow-draft.");
  loadDotenv({
    path: path.join(cwd, ".env"),
    processEnv: environment,
    override: false,
    quiet: true,
  });
  const baseUrl = requiredEnvironment(environment, "TARGET_BASE_URL");
  const artifactPath = path.resolve(
    cwd,
    cli.artifactPath ?? "artifacts/prepare_savings_subaccount/1.0.0/capability.json",
  );
  const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as CapabilityArtifact;
  await validateCapabilityArtifact(
    artifact,
    path.join(cwd, "schemas", "capability-artifact.v1.schema.json"),
  );
  const surface = new PlaywrightSurface({
    baseUrl,
    headless: false,
    allowSensitiveAutomation: true,
    trustControlMetadata: true,
  });
  const evidence = new FileReplayEvidenceSink(path.join(cwd, "evidence", "replay"));
  const engine = new ReplayEngine({ surface, evidence });
  try {
    let result = await engine.replay(artifact, {
      inputs: readReplayInputs(environment),
      allowDraftArtifact: true,
    });
    if (result.status === "intervention_required") {
      process.stdout.write(
        `Human verification is required in the open browser for run ${result.runId}. ` +
          `Complete it there, then press Enter on an empty line. The handoff expires at ${result.handoff.expiresAt}.\n`,
      );
      result = await driveHandoffLifecycle(
        engine,
        result,
        async (expiresAtMs) => waitForTerminalAcknowledgement({ expiresAtMs }),
        (message) => process.stdout.write(message),
      );
    }
    const summary = {
      runId: result.runId,
      status: result.status,
      ...(result.status === "failure" ||
      result.status === "business_outcome" ||
      result.status === "resume_rejected" ||
      result.status === "handoff_not_completed"
        ? { code: result.code }
        : {}),
      artifactVersion: result.artifactVersion,
      evidenceDirectory: evidence.directory
        ? path.relative(cwd, evidence.directory).replaceAll("\\", "/")
        : undefined,
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return result.status === "success" || result.status === "business_outcome" ? 0 : 1;
  } finally {
    await engine.close();
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isMain) {
  runReplayPrepareHandoffCli(process.argv.slice(2), process.env, process.cwd())
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Handoff replay failed.";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
