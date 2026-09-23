import express, { type Express } from "express";
import session, { MemoryStore } from "express-session";
import { type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FixtureStore } from "./fixtures/index.js";
import { createPortalRouter, type TargetScenario } from "./routes/index.js";

export interface TargetAppOptions {
  scenario?: TargetScenario;
  enableTestControls?: boolean;
}

export interface TargetApp {
  app: Express;
  fixtures: FixtureStore;
  scenario: TargetScenario;
  sessionStore: MemoryStore;
}

export interface TargetServerArguments {
  readonly scenario?: TargetScenario;
}

const targetScenarios: readonly TargetScenario[] = [
  "normal",
  "identity_verification_on_review",
  "ambiguous_continue_control",
];

function isTargetScenario(value: string | undefined): value is TargetScenario {
  return value !== undefined && targetScenarios.includes(value as TargetScenario);
}

function readScenario(value: string | undefined): TargetScenario {
  return isTargetScenario(value) ? value : "normal";
}

function parseTargetScenario(value: string | undefined): TargetScenario {
  if (!value) throw new Error("--scenario requires a value.");
  if (!isTargetScenario(value)) {
    throw new Error(`Unknown target scenario. Expected one of: ${targetScenarios.join(", ")}.`);
  }
  return value;
}

export function parseTargetServerArguments(arguments_: readonly string[]): TargetServerArguments {
  let scenario: TargetScenario | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    let value: string | undefined;
    if (argument === "--scenario") {
      value = arguments_[index + 1];
      if (value?.startsWith("--")) value = undefined;
      index += 1;
    } else if (argument?.startsWith("--scenario=")) {
      value = argument.slice("--scenario=".length);
    } else {
      throw new Error(`Unknown target server option: ${argument ?? ""}`);
    }
    if (scenario) throw new Error("--scenario may be specified only once.");
    scenario = parseTargetScenario(value);
  }
  return scenario ? { scenario } : {};
}

export function createTargetApp(options: TargetAppOptions = {}): TargetApp {
  const app = express();
  const fixtures = new FixtureStore();
  const sessionStore = new MemoryStore();
  const scenario = options.scenario ?? readScenario(process.env.TARGET_SCENARIO);
  const targetAppDirectory = path.dirname(fileURLToPath(import.meta.url));

  app.disable("x-powered-by");
  app.set("view engine", "ejs");
  app.set("views", path.join(targetAppDirectory, "views"));
  app.use(express.urlencoded({ extended: false }));
  app.use("/static", express.static(path.join(targetAppDirectory, "public")));
  app.use(
    session({
      name: "legacy_portal_session",
      secret: "synthetic-local-portal-session-secret",
      resave: false,
      saveUninitialized: false,
      store: sessionStore,
      cookie: { httpOnly: true, sameSite: "lax" },
    }),
  );
  app.use(
    createPortalRouter({
      fixtures,
      sessionStore,
      scenario,
      enableTestControls: options.enableTestControls ?? process.env.ENABLE_TEST_CONTROLS === "true",
    }),
  );
  return { app, fixtures, scenario, sessionStore };
}

export const app: Express = createTargetApp().app;

export function formatTargetServerStartupMessage(port: number, scenario: TargetScenario): string {
  return `Synthetic credit-union portal listening at http://localhost:${String(port)} (scenario: ${scenario})`;
}

export function startTargetServer(
  port = Number(process.env.PORT ?? 3000),
  options: TargetAppOptions = {},
): Server {
  const target = createTargetApp(options);
  return target.app.listen(port, () => {
    console.log(formatTargetServerStartupMessage(port, target.scenario));
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const cli = parseTargetServerArguments(process.argv.slice(2));
    startTargetServer(Number(process.env.PORT ?? 3000), cli);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid target server arguments.");
    process.exitCode = 1;
  }
}
