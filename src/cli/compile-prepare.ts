import path from "node:path";
import { pathToFileURL } from "node:url";

import { compileEvidenceRun } from "../compiler/compiler.js";
import { CapabilityCompilerError } from "../compiler/contracts.js";

export interface CompileCliIo {
  readonly cwd: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export async function runCompilePrepareCli(
  args: readonly string[],
  io: CompileCliIo,
): Promise<number> {
  if (args.length !== 1) {
    io.stderr(JSON.stringify({ status: "FAILED", code: "INVALID_ARGUMENTS" }));
    return 2;
  }
  const runId = args[0];
  if (!runId) {
    io.stderr(JSON.stringify({ status: "FAILED", code: "INVALID_ARGUMENTS" }));
    return 2;
  }
  try {
    const result = await compileEvidenceRun({
      evidenceDiscoveryRoot: path.join(io.cwd, "evidence", "discovery"),
      artifactsRoot: path.join(io.cwd, "artifacts"),
      schemaPath: path.join(io.cwd, "schemas", "capability-artifact.v1.schema.json"),
      runId,
    });
    io.stdout(
      JSON.stringify({
        status: "SUCCESS",
        capabilityVersion: result.capabilityVersion,
        stepCount: result.stepCount,
        sha256: result.sha256,
        artifactPath: path.relative(io.cwd, result.artifactPath).replaceAll("\\", "/"),
        wroteArtifact: result.wroteArtifact,
      }),
    );
    return 0;
  } catch (error) {
    const code = error instanceof CapabilityCompilerError ? error.code : "INTERNAL_ERROR";
    io.stderr(JSON.stringify({ status: "FAILED", code }));
    return 1;
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isMain) {
  process.exitCode = await runCompilePrepareCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: (line) => {
      console.log(line);
    },
    stderr: (line) => {
      console.error(line);
    },
  });
}
