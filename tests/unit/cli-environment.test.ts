import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadDiscoveryEnvironment,
  parseDiscoveryArguments,
  readDiscoveryRuntimeConfig,
  RuntimeConfigurationError,
} from "../../src/cli/index.js";

const temporaryDirectories: string[] = [];

async function fakeEnvironmentFile(contents: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "legacy-banking-env-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, ".env");
  await writeFile(file, contents, "utf8");
  return file;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("discovery environment loading", () => {
  it("loads values from an environment file and parses the supported CLI arguments", async () => {
    const file = await fakeEnvironmentFile(
      [
        "OPENAI_API_KEY=fake-file-api-key",
        "OPENAI_MODEL=fake-file-model",
        "TARGET_BASE_URL=http://localhost:3000",
        "PORTAL_PASSWORD=fake-file-password",
      ].join("\n"),
    );
    const environment: NodeJS.ProcessEnv = {};

    loadDiscoveryEnvironment(environment, file);
    const config = readDiscoveryRuntimeConfig(environment, [
      "--task",
      "prepare_savings_subaccount",
      "--headed",
    ]);

    expect(environment).toMatchObject({
      OPENAI_API_KEY: "fake-file-api-key",
      OPENAI_MODEL: "fake-file-model",
      TARGET_BASE_URL: "http://localhost:3000",
      PORTAL_PASSWORD: "fake-file-password",
    });
    expect(config).toMatchObject({
      model: "fake-file-model",
      targetBaseUrl: "http://localhost:3000",
      portalPassword: "fake-file-password",
      headed: true,
    });
  });

  it("preserves values already present in the process environment", async () => {
    const file = await fakeEnvironmentFile("OPENAI_MODEL=file-model\n");
    const environment: NodeJS.ProcessEnv = { OPENAI_MODEL: "process-model" };

    loadDiscoveryEnvironment(environment, file);

    expect(environment.OPENAI_MODEL).toBe("process-model");
  });

  it("fails safely with missing names and no secret values in the error", async () => {
    const file = await fakeEnvironmentFile(
      "OPENAI_API_KEY=fake-secret-api-key\nPORTAL_PASSWORD=fake-secret-password\n",
    );
    const environment: NodeJS.ProcessEnv = {};
    loadDiscoveryEnvironment(environment, file);

    let error: unknown;
    try {
      readDiscoveryRuntimeConfig(environment, ["--task", "prepare_savings_subaccount"]);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(RuntimeConfigurationError);
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("OPENAI_MODEL");
    expect(message).toContain("TARGET_BASE_URL");
    expect(message).not.toContain("fake-secret-api-key");
    expect(message).not.toContain("fake-secret-password");
  });
});

describe("discovery CLI argument parsing", () => {
  it.each([
    ["equals syntax", ["--task=prepare_savings_subaccount", "--headed"]],
    ["separate syntax", ["--task", "prepare_savings_subaccount", "--headed"]],
  ])("accepts the supported task with %s", (_description, arguments_) => {
    expect(parseDiscoveryArguments(arguments_)).toEqual({
      task: "prepare_savings_subaccount",
      headed: true,
      help: false,
    });
  });

  it("preserves an omitted headed flag", () => {
    expect(parseDiscoveryArguments(["--task=prepare_savings_subaccount"]).headed).toBe(false);
  });

  it("rejects unknown tasks clearly", () => {
    expect(() => parseDiscoveryArguments(["--task=transfer_funds"])).toThrow(
      "Unsupported task: transfer_funds. Supported task: prepare_savings_subaccount.",
    );
  });

  it("rejects unknown flags clearly", () => {
    expect(() =>
      parseDiscoveryArguments(["--task=prepare_savings_subaccount", "--silent"]),
    ).toThrow("Unknown option: --silent");
  });

  it("accepts help without requiring a task", () => {
    expect(parseDiscoveryArguments(["--help"])).toEqual({
      task: undefined,
      headed: false,
      help: true,
    });
  });
});
