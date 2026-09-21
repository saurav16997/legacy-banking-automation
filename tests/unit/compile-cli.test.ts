import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { runCompilePrepareCli } from "../../src/cli/compile-prepare.js";
import {
  FIXTURE_RUN_ID,
  writeDiscoveryEvidenceFixture,
} from "../fixtures/discovery/prepare-savings-success.js";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("compile:prepare CLI", () => {
  it("compiles an offline fixture without using fetch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "compile-cli-"));
    await writeDiscoveryEvidenceFixture(path.join(root, "evidence", "discovery"));
    await mkdir(path.join(root, "schemas"), { recursive: true });
    await copyFile(
      path.join(projectRoot, "schemas", "capability-artifact.v1.schema.json"),
      path.join(root, "schemas", "capability-artifact.v1.schema.json"),
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network forbidden"));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCompilePrepareCli([FIXTURE_RUN_ID], {
      cwd: root,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(exitCode).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stderr).toEqual([]);
    const output = stdout[0];
    if (!output) throw new Error("CLI output is missing.");
    expect(JSON.parse(output)).toMatchObject({
      status: "SUCCESS",
      capabilityVersion: "1.0.0",
      stepCount: 12,
    });
    fetchSpy.mockRestore();
  });

  it("returns a safe error code without provider or input text", async () => {
    const stderr: string[] = [];
    const exitCode = await runCompilePrepareCli(["not-a-run-id"], {
      cwd: projectRoot,
      stdout: () => undefined,
      stderr: (line) => stderr.push(line),
    });
    expect(exitCode).toBe(1);
    const errorOutput = stderr[0];
    if (!errorOutput) throw new Error("CLI error output is missing.");
    expect(JSON.parse(errorOutput)).toEqual({ status: "FAILED", code: "INVALID_RUN_ID" });
  });
});
