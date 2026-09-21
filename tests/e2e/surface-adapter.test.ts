import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  PlaywrightSurface,
  type PlaywrightSurfaceOptions,
  type SurfaceAdapter,
} from "../../src/browser/index.js";
import type {
  ObservedElement,
  SurfaceActionResult,
  SurfaceCommand,
  SurfaceObservation,
} from "../../src/domain/index.js";
import { createTargetApp } from "../../target_app/server.js";

function serverUrl(server: Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

function element(
  observation: SurfaceObservation,
  accessibleName: string,
  role?: ObservedElement["semanticTarget"]["role"],
): ObservedElement {
  const match = observation.elements.find(
    (candidate) =>
      candidate.semanticTarget.accessibleName === accessibleName &&
      (role === undefined || candidate.semanticTarget.role === role),
  );
  if (!match) throw new Error(`Missing observed element: ${accessibleName}`);
  return match;
}

async function execute(
  surface: SurfaceAdapter,
  command: SurfaceCommand,
): Promise<SurfaceObservation> {
  const result = await surface.execute(command);
  expect(result.status, result.message).toBe("EXECUTED");
  if (!result.observation) throw new Error("Executed action did not return an observation");
  return result.observation;
}

async function fill(
  surface: SurfaceAdapter,
  observation: SurfaceObservation,
  name: string,
  value: string,
): Promise<SurfaceObservation> {
  const target = element(observation, name);
  return execute(surface, {
    operation: "fill",
    observationId: observation.observationId,
    elementRef: target.elementRef,
    value,
  });
}

async function click(
  surface: SurfaceAdapter,
  observation: SurfaceObservation,
  name: string,
  role?: ObservedElement["semanticTarget"]["role"],
): Promise<SurfaceObservation> {
  const target = element(observation, name, role);
  return execute(surface, {
    operation: "click",
    observationId: observation.observationId,
    elementRef: target.elementRef,
  });
}

async function select(
  surface: SurfaceAdapter,
  observation: SurfaceObservation,
  name: string,
  option: string,
): Promise<SurfaceObservation> {
  const target = element(observation, name);
  return execute(surface, {
    operation: "selectOption",
    observationId: observation.observationId,
    elementRef: target.elementRef,
    option,
  });
}

async function reachReview(surface: SurfaceAdapter, baseUrl: string): Promise<SurfaceObservation> {
  let observation = await surface.start();
  observation = await fill(surface, observation, "Operator username", "demo.operator");
  observation = await fill(surface, observation, "Password", "creditunion-demo");
  observation = await click(surface, observation, "Log in", "button");
  observation = await execute(surface, { operation: "navigate", url: `${baseUrl}/members/search` });
  observation = await fill(surface, observation, "Member ID", "M-10042");
  observation = await click(surface, observation, "Search", "button");
  observation = await click(surface, observation, "Add savings subaccount", "link");
  observation = await select(surface, observation, "Product", "Growth Savings");
  observation = await fill(surface, observation, "Account nickname", "Vacation Fund");
  observation = await fill(surface, observation, "Initial deposit", "250.00");
  observation = await select(surface, observation, "Funding account", "CHK-1842");
  return click(surface, observation, "Continue to review", "button");
}

describe("controlled Playwright surface adapter", () => {
  const target = createTargetApp();
  const targetServer = target.app.listen(0);
  const surfaces: PlaywrightSurface[] = [];
  let baseUrl: string;

  beforeAll(() => {
    baseUrl = serverUrl(targetServer);
  });

  afterEach(async () => {
    await Promise.all(surfaces.splice(0).map(async (surface) => surface.close()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      targetServer.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });

  function createSurface(
    url = baseUrl,
    overrides: Partial<PlaywrightSurfaceOptions> = {},
  ): PlaywrightSurface {
    const surface = new PlaywrightSurface({
      baseUrl: url,
      headless: true,
      allowSensitiveAutomation: true,
      trustControlMetadata: true,
      timeoutMs: 3_000,
      ...overrides,
    });
    surfaces.push(surface);
    return surface;
  }

  it("observes semantic login controls and always redacts passwords", async () => {
    const surface = createSurface();
    let observation = await surface.start();
    expect(observation.pageState).toBe("operator-login");
    expect(element(observation, "Operator username").semanticTarget.role).toBe("textbox");
    const password = element(observation, "Password");
    expect(password.actionRisk).toBe("SENSITIVE");
    expect(password.currentValue).toBe("[REDACTED]");
    expect(element(observation, "Log in").controlOwner).toBe("AUTOMATION");

    observation = await fill(surface, observation, "Password", "creditunion-demo");
    expect(element(observation, "Password").currentValue).toBe("[REDACTED]");
    expect(JSON.stringify(observation)).not.toContain("creditunion-demo");
  });

  it("executes safe fill, click, select and same-origin navigation through references", async () => {
    const surface = createSurface();
    const review = await reachReview(surface, baseUrl);
    expect(review.pageState).toBe("ready-for-review");
    expect(review.primaryHeading).toBe("Review Savings Subaccount");
  });

  it("rejects stale references and mismatched observation IDs", async () => {
    const surface = createSurface();
    const first = await surface.start();
    const oldUsername = element(first, "Operator username");
    const second = await fill(surface, first, "Operator username", "demo.operator");

    const staleReference = await surface.execute({
      operation: "fill",
      observationId: second.observationId,
      elementRef: oldUsername.elementRef,
      value: "ignored",
    });
    expect(staleReference.status).toBe("STALE_OBSERVATION");

    const currentUsername = element(second, "Operator username");
    const mismatchedObservation = await surface.execute({
      operation: "fill",
      observationId: crypto.randomUUID(),
      elementRef: currentUsername.elementRef,
      value: "ignored",
    });
    expect(mismatchedObservation.status).toBe("STALE_OBSERVATION");
  });

  it("allows same-origin navigation and blocks external navigation", async () => {
    const surface = createSurface();
    await surface.start();
    const sameOrigin = await surface.execute({ operation: "navigate", url: "/login" });
    expect(sameOrigin.status).toBe("EXECUTED");
    const external = await surface.execute({ operation: "navigate", url: "https://example.com" });
    expect(external.status).toBe("BLOCKED");
    expect(external.observation?.url).toBe(`${baseUrl}/login`);
  });

  it("does not expose raw browser primitives or arbitrary execution methods", () => {
    const surface = createSurface();
    const publicMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(surface));
    expect(publicMethods).toEqual(expect.arrayContaining(["start", "observe", "execute", "close"]));
    expect(publicMethods).not.toEqual(
      expect.arrayContaining(["page", "browser", "context", "locator", "evaluate", "script"]),
    );
    expect("page" in surface).toBe(false);
    expect("browser" in surface).toBe(false);
  });

  it("blocks unclassified controls and applies trusted configuration before page hints", async () => {
    const classificationApp = express();
    classificationApp.get("/login", (_request, response) => {
      response.type("html").send(`
        <h1>Classification test</h1>
        <button>Unannotated</button>
        <button data-control-owner="ROBOT" data-action-risk="MYSTERY">Invalid metadata</button>
        <button data-control-owner="AUTOMATION" data-action-risk="SAFE">Annotated safe</button>
        <button data-testid="trusted-override" data-control-owner="NONE" data-action-risk="IRREVERSIBLE">Configured safe</button>
      `);
    });
    const classificationServer = classificationApp.listen(0);
    const url = serverUrl(classificationServer);
    const classificationSurfaces: PlaywrightSurface[] = [];
    try {
      const surface = createSurface(url);
      classificationSurfaces.push(surface);
      const observation = await surface.start();
      const unannotated = element(observation, "Unannotated", "button");
      expect(unannotated.controlOwner).toBe("NONE");
      expect(unannotated.actionRisk).toBe("IRREVERSIBLE");
      expect(
        (
          await surface.execute({
            operation: "click",
            observationId: observation.observationId,
            elementRef: unannotated.elementRef,
          })
        ).status,
      ).toBe("BLOCKED");

      const invalid = element(observation, "Invalid metadata", "button");
      expect(invalid.controlOwner).toBe("NONE");
      expect(
        (
          await surface.execute({
            operation: "click",
            observationId: observation.observationId,
            elementRef: invalid.elementRef,
          })
        ).status,
      ).toBe("BLOCKED");

      const annotated = element(observation, "Annotated safe", "button");
      expect(
        (
          await surface.execute({
            operation: "click",
            observationId: observation.observationId,
            elementRef: annotated.elementRef,
          })
        ).status,
      ).toBe("EXECUTED");

      const untrustedSurface = createSurface(url, { trustControlMetadata: false });
      classificationSurfaces.push(untrustedSurface);
      const untrustedObservation = await untrustedSurface.start();
      const ignoredHint = element(untrustedObservation, "Annotated safe", "button");
      expect(ignoredHint.controlOwner).toBe("NONE");
      expect(
        (
          await untrustedSurface.execute({
            operation: "click",
            observationId: untrustedObservation.observationId,
            elementRef: ignoredHint.elementRef,
          })
        ).status,
      ).toBe("BLOCKED");

      const configuredSurface = createSurface(url, {
        trustControlMetadata: false,
        trustedControlClassifications: {
          "trusted-override": { controlOwner: "AUTOMATION", actionRisk: "SAFE" },
        },
      });
      classificationSurfaces.push(configuredSurface);
      const configuredObservation = await configuredSurface.start();
      const configured = element(configuredObservation, "Configured safe", "button");
      expect(configured.controlOwner).toBe("AUTOMATION");
      expect(configured.actionRisk).toBe("SAFE");
      expect(
        (
          await configuredSurface.execute({
            operation: "click",
            observationId: configuredObservation.observationId,
            elementRef: configured.elementRef,
          })
        ).status,
      ).toBe("EXECUTED");
    } finally {
      await Promise.all(classificationSurfaces.map(async (surface) => surface.close()));
      await new Promise<void>((resolve, reject) => {
        classificationServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it("observes and blocks Open Account without mutating fixtures", async () => {
    const surface = createSurface();
    const review = await reachReview(surface, baseUrl);
    const openAccount = element(review, "Open Account", "button");
    expect(openAccount.controlOwner).toBe("NONE");
    expect(openAccount.actionRisk).toBe("IRREVERSIBLE");
    const accountCount = target.fixtures.findMember("M-10042")?.accounts.length;

    const result = await surface.execute({
      operation: "click",
      observationId: review.observationId,
      elementRef: openAccount.elementRef,
    });
    expect(result.status).toBe("BLOCKED");
    expect(target.fixtures.findMember("M-10042")?.accounts.length).toBe(accountCount);
  });

  it("fails closed when a semantic target is ambiguous", async () => {
    const ambiguousApp = express();
    ambiguousApp.get("/login", (_request, response) => {
      response
        .type("html")
        .send(
          '<h1>Ambiguous</h1><button data-control-owner="AUTOMATION" data-action-risk="SAFE">Continue</button><button data-control-owner="AUTOMATION" data-action-risk="SAFE">Continue</button>',
        );
    });
    const ambiguousServer = ambiguousApp.listen(0);
    const surface = createSurface(serverUrl(ambiguousServer));
    try {
      const observation = await surface.start();
      const targetElement = element(observation, "Continue", "button");
      const result = await surface.execute({
        operation: "click",
        observationId: observation.observationId,
        elementRef: targetElement.elementRef,
      });
      expect(result.status).toBe("AMBIGUOUS_TARGET");
    } finally {
      await surface.close();
      await new Promise<void>((resolve, reject) => {
        ambiguousServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it("applies the caller timeout to the real Playwright action and settles as TIMED_OUT", async () => {
    const timeoutApp = express();
    timeoutApp.get("/login", (_request, response) => {
      response.type("html").send(`
        <main data-page-state="timeout-test">
          <h1>Timeout test</h1>
          <button disabled data-control-owner="AUTOMATION" data-action-risk="SAFE">Delayed action</button>
        </main>
      `);
    });
    const timeoutServer = timeoutApp.listen(0);
    const surface = createSurface(serverUrl(timeoutServer), { timeoutMs: 1_000 });
    try {
      const observation = await surface.start();
      const target = element(observation, "Delayed action", "button");
      const result = await surface.execute(
        {
          operation: "click",
          observationId: observation.observationId,
          elementRef: target.elementRef,
        },
        { timeoutMs: 25 },
      );

      expect(result).toMatchObject({ status: "TIMED_OUT" });
    } finally {
      await surface.close();
      await new Promise<void>((resolve, reject) => {
        timeoutServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it("closes browser resources cleanly and idempotently", async () => {
    const surface = createSurface();
    await surface.start();
    await surface.close();
    await surface.close();
    const result = await surface.execute({ operation: "navigate", url: "/login" });
    expect(result.status).toBe("FAILED");
    await expect(surface.observe()).rejects.toThrow("browser session is not open");
  });
});

describe("human-owned identity verification", () => {
  const target = createTargetApp({ scenario: "identity_verification_on_review" });
  const server = target.app.listen(0);
  let baseUrl: string;

  beforeAll(() => {
    baseUrl = serverUrl(server);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });

  it("requires handoff without closing or changing the browser session", async () => {
    const surface = new PlaywrightSurface({
      baseUrl,
      headless: true,
      allowSensitiveAutomation: true,
      trustControlMetadata: true,
      timeoutMs: 3_000,
    });
    try {
      const interrupted = await reachReview(surface, baseUrl);
      expect(interrupted.pageState).toBe("human-verification-required");
      const verification = element(interrupted, "Synthetic verification code");
      const verifyButton = element(interrupted, "Verify and continue", "button");
      expect(verification.controlOwner).toBe("HUMAN");
      expect(verifyButton.controlOwner).toBe("HUMAN");

      const result: SurfaceActionResult = await surface.execute({
        operation: "fill",
        observationId: interrupted.observationId,
        elementRef: verification.elementRef,
        value: "739241",
      });
      expect(result.status).toBe("HANDOFF_REQUIRED");
      expect(result.observation?.observationId).toBe(interrupted.observationId);
      const stillOpen = await surface.observe();
      expect(stillOpen.pageState).toBe("human-verification-required");
      expect(stillOpen.url).toBe(interrupted.url);
    } finally {
      await surface.close();
    }
  });
});
