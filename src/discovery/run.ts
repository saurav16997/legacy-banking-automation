import { randomUUID } from "node:crypto";

import type { SurfaceAdapter } from "../browser/index.js";
import { DiscoveryEvidenceRecorder } from "../evidence/discovery-recorder.js";
import type { DiscoveryAgentRunner } from "./agent-runner.js";
import { AgentTurnLimitError } from "./agent-runner.js";
import {
  DEFAULT_DISCOVERY_LIMITS,
  DiscoveryTrajectorySchema,
  type DiscoveryLimits,
  type DiscoveryFailure,
  type DiscoveryStatus,
  type DiscoveryTrajectory,
} from "./contracts.js";
import {
  classifyDiscoveryFailure,
  DiscoveryAgentOutputError,
  formatDiscoveryTerminalReason,
} from "./failure.js";
import type { InputVault } from "./input-vault.js";
import { DiscoveryStopError, DiscoveryToolController } from "./tools.js";

const SANITIZED_GOAL =
  "Prepare the requested savings subaccount using the named inputs and stop at verified review.";

export interface DiscoveryRunOptions {
  readonly adapter: SurfaceAdapter;
  readonly agentRunner: DiscoveryAgentRunner;
  readonly vault: InputVault;
  readonly model: string;
  readonly evidenceRoot: string;
  readonly limits?: Partial<DiscoveryLimits>;
  readonly runId?: string;
  readonly now?: () => number;
}

export interface DiscoveryRunResult {
  readonly trajectory: DiscoveryTrajectory;
  readonly evidenceDirectory: string;
  readonly actionCount: number;
}

function createRunId(now: number): string {
  const timestamp = new Date(now)
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  return `discovery-${timestamp}-${randomUUID().slice(0, 8)}`;
}

export async function runDiscovery(options: DiscoveryRunOptions): Promise<DiscoveryRunResult> {
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  const runId = options.runId ?? createRunId(startedAtMs);
  const limits: DiscoveryLimits = { ...DEFAULT_DISCOVERY_LIMITS, ...options.limits };
  const evidence = new DiscoveryEvidenceRecorder(options.evidenceRoot, runId);
  const evidenceRedactions = options.vault.redactionValues();
  await evidence.initialize();
  const abortController = new AbortController();
  let controller: DiscoveryToolController | undefined;
  let status: DiscoveryStatus = "FAILED";
  let terminalReason: string | undefined;
  let failure: DiscoveryFailure | undefined;

  try {
    const initialObservation = await options.adapter.start();
    await evidence.recordScreenshot(
      "start",
      await options.adapter.captureScreenshot(evidenceRedactions),
    );
    controller = new DiscoveryToolController({
      adapter: options.adapter,
      vault: options.vault,
      limits,
      startedAtMs,
      initialObservation,
      now,
      captureEvidence: async (label) =>
        evidence.recordScreenshot(
          label,
          await options.adapter.captureScreenshot(evidenceRedactions),
        ),
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        abortController.abort();
        reject(new DiscoveryStopError("TIMED_OUT", "Discovery duration limit reached."));
      }, limits.maxDurationMs);
    });
    let finalOutput;
    try {
      finalOutput = await Promise.race([
        options.agentRunner.run({
          model: options.model,
          sanitizedGoal: SANITIZED_GOAL,
          inputDefinitions: options.vault.definitions(),
          tools: controller,
          maxTurns: limits.maxModelTurns,
          signal: abortController.signal,
        }),
        timeout,
      ]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    if (controller.events.length === 0) {
      throw new DiscoveryAgentOutputError(
        "The discovery agent returned before calling a tool.",
        "BEFORE_FIRST_TOOL_CALL",
      );
    }

    if (finalOutput.status === "SUCCESS" && controller.completionValidation?.passed) {
      status = "SUCCESS";
    } else {
      status = "FAILED";
      terminalReason = controller.completionValidation?.passed
        ? "The agent did not return the expected structured success status."
        : "Deterministic completion validation did not pass.";
    }
  } catch (error) {
    if (error instanceof DiscoveryStopError) {
      status = error.status;
      terminalReason = error.message;
    } else if (error instanceof AgentTurnLimitError) {
      status = "MAX_STEPS";
      terminalReason = error.message;
    } else {
      status = "FAILED";
      failure = classifyDiscoveryFailure(error);
      terminalReason = formatDiscoveryTerminalReason(failure);
    }
  }

  try {
    if (controller) {
      await evidence.recordScreenshot(
        "final",
        await options.adapter.captureScreenshot(evidenceRedactions),
      );
    }
  } catch {
    terminalReason ??= "Final screenshot could not be recorded.";
    if (status === "SUCCESS") status = "FAILED";
  }

  const endedAt = new Date(now()).toISOString();
  const trajectoryCandidate: DiscoveryTrajectory = {
    schemaVersion: "1.0.0",
    runId,
    capability: "prepare_savings_subaccount",
    sanitizedGoal: SANITIZED_GOAL,
    inputs: options.vault.definitions(),
    model: options.model,
    adapterVersion: "playwright-surface/1.0.0",
    policyVersion: "surface-policy/1.0.0",
    startedAt,
    endedAt,
    finalStatus: status,
    events: controller ? [...controller.events] : [],
    ...(controller
      ? { finalObservation: options.vault.sanitize(controller.latestObservation) }
      : {}),
    ...(controller?.completionValidation
      ? { completionValidation: controller.completionValidation }
      : {}),
    ...(failure ? { failure } : {}),
    ...(terminalReason ? { terminalReason: options.vault.sanitize(terminalReason) } : {}),
  };
  try {
    const trajectory = DiscoveryTrajectorySchema.parse(options.vault.sanitize(trajectoryCandidate));
    await evidence.finalize(trajectory, {
      runId,
      status,
      actionCount: controller?.actionCount ?? 0,
      ...(failure ? { failure } : {}),
      ...(controller?.latestObservation.pageState
        ? { finalPageState: controller.latestObservation.pageState }
        : {}),
    });
    return {
      trajectory,
      evidenceDirectory: evidence.directory,
      actionCount: controller?.actionCount ?? 0,
    };
  } finally {
    await options.adapter.close();
    abortController.abort();
  }
}
