import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";

import { PlaywrightSurface } from "../browser/index.js";
import {
  createCanonicalInputVault,
  OpenAIAgentsDiscoveryRunner,
  runDiscovery,
} from "../discovery/index.js";

export interface DiscoveryRuntimeConfig {
  readonly model: string;
  readonly targetBaseUrl: string;
  readonly portalPassword: string;
  readonly headed: boolean;
}

export interface DiscoveryCliArguments {
  readonly task?: string;
  readonly headed: boolean;
  readonly help: boolean;
}

export const DISCOVERY_HELP = `Usage: npm run discover -- --task=prepare_savings_subaccount [--headed]

Options:
  --task <task>  Discovery task (supported: prepare_savings_subaccount)
  --headed       Show the browser window
  --help         Show this help message
`;

export class RuntimeConfigurationError extends Error {
  constructor(readonly missingVariables: readonly string[]) {
    super(`Missing required environment variables: ${missingVariables.join(", ")}`);
    this.name = "RuntimeConfigurationError";
  }
}

export function loadDiscoveryEnvironment(
  environment: NodeJS.ProcessEnv,
  environmentFile = path.resolve(process.cwd(), ".env"),
): NodeJS.ProcessEnv {
  loadDotenv({ path: environmentFile, processEnv: environment, override: false, quiet: true });
  return environment;
}

export function parseDiscoveryArguments(arguments_: readonly string[]): DiscoveryCliArguments {
  let task: string | undefined;
  let headed = false;
  let help = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--headed") {
      headed = true;
    } else if (argument === "--help") {
      help = true;
    } else if (argument === "--task") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--task requires a value.");
      }
      if (task !== undefined) throw new Error("--task may only be specified once.");
      task = value;
      index += 1;
    } else if (argument?.startsWith("--task=")) {
      const value = argument.slice("--task=".length);
      if (!value) throw new Error("--task requires a value.");
      if (task !== undefined) throw new Error("--task may only be specified once.");
      task = value;
    } else if (argument?.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      throw new Error(`Unexpected argument: ${argument ?? ""}`);
    }
  }

  if (!help && task !== "prepare_savings_subaccount") {
    const detail = task ? `Unsupported task: ${task}.` : "--task is required.";
    throw new Error(`${detail} Supported task: prepare_savings_subaccount.`);
  }

  return { ...(task === undefined ? {} : { task }), headed, help };
}

export function readDiscoveryRuntimeConfig(
  environment: NodeJS.ProcessEnv,
  arguments_: readonly string[],
): DiscoveryRuntimeConfig {
  const cli = parseDiscoveryArguments(arguments_);
  const apiKey = environment.OPENAI_API_KEY?.trim();
  const model = environment.OPENAI_MODEL?.trim();
  const targetBaseUrl = environment.TARGET_BASE_URL?.trim();
  const portalPassword = environment.PORTAL_PASSWORD;
  const missing = [
    ...(!apiKey ? ["OPENAI_API_KEY"] : []),
    ...(!model ? ["OPENAI_MODEL"] : []),
    ...(!targetBaseUrl ? ["TARGET_BASE_URL"] : []),
    ...(!portalPassword ? ["PORTAL_PASSWORD"] : []),
  ];
  if (!apiKey || !model || !targetBaseUrl || !portalPassword) {
    throw new RuntimeConfigurationError(missing);
  }
  return {
    model,
    targetBaseUrl,
    portalPassword,
    headed: cli.headed,
  };
}

export async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const cli = parseDiscoveryArguments(arguments_);
  if (cli.help) {
    process.stdout.write(DISCOVERY_HELP);
    return;
  }
  loadDiscoveryEnvironment(process.env);
  const config = readDiscoveryRuntimeConfig(process.env, arguments_);
  const adapter = new PlaywrightSurface({
    baseUrl: config.targetBaseUrl,
    headless: !config.headed,
    allowSensitiveAutomation: true,
    trustControlMetadata: true,
  });
  const result = await runDiscovery({
    adapter,
    agentRunner: new OpenAIAgentsDiscoveryRunner(),
    vault: createCanonicalInputVault(config.portalPassword),
    model: config.model,
    evidenceRoot: path.resolve(process.cwd(), "evidence"),
  });
  const summary = {
    runId: result.trajectory.runId,
    status: result.trajectory.finalStatus,
    actionCount: result.actionCount,
    finalPageState: result.trajectory.finalObservation?.pageState,
    failure: result.trajectory.failure,
    evidenceDirectory: result.evidenceDirectory,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Discovery failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
