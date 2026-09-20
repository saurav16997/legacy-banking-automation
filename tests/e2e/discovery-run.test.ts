import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PlaywrightSurface } from "../../src/browser/index.js";
import type { SurfaceObservation } from "../../src/domain/index.js";
import type {
  DiscoveryAgentRunRequest,
  DiscoveryAgentRunner,
} from "../../src/discovery/agent-runner.js";
import { createCanonicalInputVault } from "../../src/discovery/input-vault.js";
import { runDiscovery } from "../../src/discovery/run.js";
import { demoCredentials } from "../../target_app/fixtures/index.js";
import { createTargetApp } from "../../target_app/server.js";

interface ToolResultEnvelope {
  readonly status: string;
  readonly observation?: SurfaceObservation;
}

function toolResult(value: unknown): ToolResultEnvelope {
  if (!value || typeof value !== "object" || !("status" in value)) {
    throw new Error("Scripted discovery tool returned an invalid result.");
  }
  return value as ToolResultEnvelope;
}

function elementRef(observation: SurfaceObservation, accessibleName: string): string {
  const match = observation.elements.find(
    (element) => element.semanticTarget.accessibleName === accessibleName,
  );
  if (!match) throw new Error(`Missing scripted target: ${accessibleName}`);
  return match.elementRef;
}

async function updatedObservation(value: Promise<unknown>): Promise<SurfaceObservation> {
  const result = toolResult(await value);
  expect(result.status).toBe("EXECUTED");
  if (!result.observation) throw new Error("Tool result omitted its observation.");
  return result.observation;
}

class ScriptedSavingsDiscoveryRunner implements DiscoveryAgentRunner {
  async run(request: DiscoveryAgentRunRequest) {
    let observation = await updatedObservation(request.tools.observe_surface());
    const fill = async (name: string, inputRef: string): Promise<void> => {
      observation = await updatedObservation(
        request.tools.fill_element_from_input({
          observationId: observation.observationId,
          elementRef: elementRef(observation, name),
          inputRef,
        }),
      );
    };
    const click = async (name: string): Promise<void> => {
      observation = await updatedObservation(
        request.tools.click_element({
          observationId: observation.observationId,
          elementRef: elementRef(observation, name),
        }),
      );
    };
    const select = async (name: string, inputRef: string): Promise<void> => {
      observation = await updatedObservation(
        request.tools.select_option_from_input({
          observationId: observation.observationId,
          elementRef: elementRef(observation, name),
          inputRef,
        }),
      );
    };

    await fill("Operator username", "operator_username");
    await fill("Password", "portal_password");
    await click("Log in");
    observation = await updatedObservation(
      request.tools.navigate_same_origin({ path: "/members/search" }),
    );
    await fill("Member ID", "member_id");
    await click("Search");
    await click("Add savings subaccount");
    await select("Product", "product_name");
    await fill("Account nickname", "account_nickname");
    await fill("Initial deposit", "initial_deposit");
    await select("Funding account", "funding_account");
    await click("Continue to review");
    const completion = toolResult(await request.tools.complete_discovery());
    expect(completion.status).toBe("VALIDATED");
    return { status: "SUCCESS" as const, summary: "Locally validated review state." };
  }
}

describe("scripted offline discovery through the real surface adapter", () => {
  const target = createTargetApp();
  let server: Server;
  let baseUrl: string;
  let evidenceRoot: string;

  beforeAll(async () => {
    server = target.app.listen(0);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
    evidenceRoot = await mkdtemp(path.join(tmpdir(), "legacy-banking-evidence-"));
  });

  afterAll(async () => {
    await rm(evidenceRoot, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });

  it("completes the normal workflow and writes sanitized ordered evidence", async () => {
    const result = await runDiscovery({
      adapter: new PlaywrightSurface({
        baseUrl,
        headless: true,
        allowSensitiveAutomation: true,
        trustControlMetadata: true,
        timeoutMs: 3_000,
      }),
      agentRunner: new ScriptedSavingsDiscoveryRunner(),
      vault: createCanonicalInputVault(demoCredentials.password),
      model: "scripted-offline-test-runner",
      evidenceRoot,
      runId: "scripted-normal-workflow",
      limits: { maxDurationMs: 60_000 },
    });

    expect(result.trajectory.finalStatus).toBe("SUCCESS");
    expect(result.trajectory.completionValidation?.passed).toBe(true);
    expect(result.trajectory.finalObservation?.pageState).toBe("ready-for-review");
    expect(
      result.trajectory.events.some(
        (event) =>
          event.semanticTarget?.accessibleName === "Open Account" &&
          event.sanitizedResult.status === "EXECUTED",
      ),
    ).toBe(false);

    const filenames = await readdir(result.evidenceDirectory);
    expect(filenames).toEqual(
      expect.arrayContaining(["trajectory.json", "manifest.json", "summary.json"]),
    );
    const screenshots = filenames.filter((filename) => filename.endsWith(".png")).sort();
    expect(screenshots.length).toBeGreaterThan(2);
    expect(screenshots[0]).toMatch(/^001-/);
    let trajectoryContent = "";
    for (const filename of filenames.filter((name) => name.endsWith(".json"))) {
      const content = await readFile(path.join(result.evidenceDirectory, filename), "utf8");
      if (filename === "trajectory.json") trajectoryContent = content;
      expect(content).not.toContain(demoCredentials.password);
      expect(content).not.toContain(demoCredentials.username);
      expect(content).not.toContain("M-10042");
      expect(content).not.toContain("Growth Savings");
      expect(content).not.toContain("Vacation Fund");
      expect(content).not.toContain("250.00");
      expect(content).not.toContain("Morgan Redwood");
      expect(content).not.toContain("1842");
    }
    expect(trajectoryContent).toContain("[REDACTED:member_name]");
    expect(trajectoryContent).toContain("[REDACTED:funding_account_suffix]");
  });
});
