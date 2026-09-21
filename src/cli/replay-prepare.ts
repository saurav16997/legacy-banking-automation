import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { config as loadDotenv } from "dotenv";

import { PlaywrightSurface } from "../browser/index.js";
import type { CapabilityArtifact } from "../compiler/contracts.js";
import { validateCapabilityArtifact } from "../compiler/schema-validator.js";
import { FileReplayEvidenceSink, ReplayEngine, type ReplayInputs } from "../replay/index.js";

interface ReplayCliArguments {
  readonly allowDraft: boolean;
  readonly headed: boolean;
  readonly artifactPath?: string;
  readonly help: boolean;
}

export const REPLAY_HELP = `Usage: npm run replay:prepare -- --allow-draft [--headed] [--artifact <path>]

Options:
  --allow-draft      Explicitly authorize local demo replay of a DRAFT artifact
  --headed           Show the browser window
  --artifact <path>  Override the default versioned capability artifact
  --help             Show this help message
`;

export function parseReplayArguments(arguments_: readonly string[]): ReplayCliArguments {
  let allowDraft = false;
  let headed = false;
  let help = false;
  let artifactPath: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--allow-draft") allowDraft = true;
    else if (argument === "--headed") headed = true;
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
      throw new Error(`Unknown replay option: ${argument ?? ""}`);
    }
  }
  return {
    allowDraft,
    headed,
    help,
    ...(artifactPath ? { artifactPath } : {}),
  };
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function readReplayInputs(environment: NodeJS.ProcessEnv): ReplayInputs {
  return {
    operator_username: environment.REPLAY_OPERATOR_USERNAME ?? "demo.operator",
    portal_password: requiredEnvironment(environment, "PORTAL_PASSWORD"),
    member_id: environment.REPLAY_MEMBER_ID ?? "M-20017",
    product_name: environment.REPLAY_PRODUCT_NAME ?? "Growth Savings",
    account_nickname: environment.REPLAY_ACCOUNT_NICKNAME ?? "Emergency Fund",
    initial_deposit: environment.REPLAY_INITIAL_DEPOSIT ?? "125.00",
    funding_account:
      environment.REPLAY_FUNDING_ACCOUNT ?? "Essential Checking \u2014 checking ending 9021",
  };
}

export async function runReplayPrepareCli(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<number> {
  const cli = parseReplayArguments(arguments_);
  if (cli.help) {
    process.stdout.write(REPLAY_HELP);
    return 0;
  }
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
    headless: !cli.headed,
    allowSensitiveAutomation: true,
    trustControlMetadata: true,
  });
  const evidence = new FileReplayEvidenceSink(path.join(cwd, "evidence", "replay"));
  try {
    const result = await new ReplayEngine({ surface, evidence }).replay(artifact, {
      inputs: readReplayInputs(environment),
      allowDraftArtifact: cli.allowDraft,
    });
    const summary = {
      runId: result.runId,
      status: result.status,
      ...(result.status === "failure" || result.status === "business_outcome"
        ? { code: result.code }
        : {}),
      ...(result.status === "intervention_required"
        ? { interventionId: result.interventionId }
        : {}),
      artifactVersion: result.artifactVersion,
      evidenceDirectory: evidence.directory
        ? path.relative(cwd, evidence.directory).replaceAll("\\", "/")
        : undefined,
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return result.status === "failure" ? 1 : 0;
  } finally {
    await surface.close();
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isMain) {
  runReplayPrepareCli(process.argv.slice(2), process.env, process.cwd())
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Replay failed.";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
