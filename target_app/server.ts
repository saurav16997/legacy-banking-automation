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
  sessionStore: MemoryStore;
}

function readScenario(value: string | undefined): TargetScenario {
  return value === "identity_verification_on_review" ? value : "normal";
}

export function createTargetApp(options: TargetAppOptions = {}): TargetApp {
  const app = express();
  const fixtures = new FixtureStore();
  const sessionStore = new MemoryStore();
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
      scenario: options.scenario ?? readScenario(process.env.TARGET_SCENARIO),
      enableTestControls: options.enableTestControls ?? process.env.ENABLE_TEST_CONTROLS === "true",
    }),
  );
  return { app, fixtures, sessionStore };
}

export const app: Express = createTargetApp().app;

export function startTargetServer(port = Number(process.env.PORT ?? 3000)): Server {
  return app.listen(port, () => {
    console.log(`Synthetic credit-union portal listening at http://localhost:${String(port)}`);
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  startTargetServer();
}
