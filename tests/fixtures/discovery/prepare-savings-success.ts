import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DiscoveryTrajectorySchema,
  type DiscoveryEvent,
  type DiscoveryTrajectory,
} from "../../../src/discovery/contracts.js";
import type { SemanticTarget } from "../../../src/domain/index.js";
import { sha256 } from "../../../src/compiler/canonical-json.js";

export const FIXTURE_RUN_ID = "discovery-20260920160150-78f495af";

const timestamp = (sequence: number): string =>
  `2026-09-20T16:01:${String(sequence).padStart(2, "0")}.000Z`;

function actionEvent(
  sequence: number,
  actionType: "click_element" | "fill_element_from_input" | "select_option_from_input",
  target: SemanticTarget,
  resultingPageState: string,
  inputRef: string | undefined,
  risk: "SAFE" | "SENSITIVE",
): DiscoveryEvent {
  return {
    sequence,
    timestamp: timestamp(sequence),
    observationId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    actionType,
    elementRef: `element-${String(sequence).padStart(3, "0")}`,
    semanticTarget: target,
    controlOwner: "AUTOMATION",
    actionRisk: risk,
    ...(inputRef ? { inputRef } : {}),
    sanitizedResult: { status: "EXECUTED", message: "Sanitized action completed." },
    resultingPageState,
    durationMs: 10,
  };
}

const completionChecks = [
  "page_state",
  "review_heading",
  "member",
  "product",
  "nickname",
  "deposit",
  "funding_account",
  "account_not_created",
  "open_account_policy",
  "open_account_not_executed",
  "forbidden_owners_not_executed",
].map((name) => ({ name, passed: true, message: "Sanitized deterministic check passed." }));

export function successfulTrajectoryFixture(): DiscoveryTrajectory {
  const events: DiscoveryEvent[] = [
    {
      sequence: 1,
      timestamp: timestamp(1),
      actionType: "observe_surface",
      sanitizedResult: { status: "EXECUTED" },
      resultingPageState: "operator-login",
      durationMs: 10,
    },
    actionEvent(
      2,
      "fill_element_from_input",
      { role: "textbox", accessibleName: "Operator username", label: "Operator username" },
      "operator-login",
      "operator_username",
      "SAFE",
    ),
    {
      sequence: 3,
      timestamp: timestamp(3),
      observationId: "00000000-0000-4000-8000-000000000003",
      actionType: "fill_element_from_input",
      elementRef: "element-003",
      inputRef: "portal_password",
      sanitizedResult: { status: "STALE_OBSERVATION", message: "Sanitized stale observation." },
      resultingPageState: "operator-login",
      durationMs: 10,
    },
    actionEvent(
      4,
      "fill_element_from_input",
      { role: "textbox", accessibleName: "Password", label: "Password" },
      "operator-login",
      "portal_password",
      "SENSITIVE",
    ),
    actionEvent(
      5,
      "click_element",
      { role: "button", accessibleName: "Log in" },
      "employee-dashboard",
      undefined,
      "SAFE",
    ),
    actionEvent(
      6,
      "click_element",
      {
        role: "link",
        accessibleName: "Member Search\nLocate a member and view account services.",
      },
      "member-search",
      undefined,
      "SAFE",
    ),
    actionEvent(
      7,
      "fill_element_from_input",
      { role: "textbox", accessibleName: "Member ID", label: "Member ID" },
      "member-search",
      "member_id",
      "SENSITIVE",
    ),
    actionEvent(
      8,
      "click_element",
      { role: "button", accessibleName: "Search" },
      "member-profile",
      undefined,
      "SAFE",
    ),
    actionEvent(
      9,
      "click_element",
      { role: "link", accessibleName: "Add savings subaccount" },
      "savings-application",
      undefined,
      "SAFE",
    ),
    actionEvent(
      10,
      "select_option_from_input",
      { role: "combobox", accessibleName: "Product", label: "Product" },
      "savings-application",
      "product_name",
      "SAFE",
    ),
    actionEvent(
      11,
      "fill_element_from_input",
      { role: "textbox", accessibleName: "Account nickname", label: "Account nickname" },
      "savings-application",
      "account_nickname",
      "SAFE",
    ),
    actionEvent(
      12,
      "fill_element_from_input",
      { role: "textbox", accessibleName: "Initial deposit", label: "Initial deposit" },
      "savings-application",
      "initial_deposit",
      "SENSITIVE",
    ),
    actionEvent(
      13,
      "select_option_from_input",
      { role: "combobox", accessibleName: "Funding account", label: "Funding account" },
      "savings-application",
      "funding_account",
      "SENSITIVE",
    ),
    actionEvent(
      14,
      "click_element",
      { role: "button", accessibleName: "Continue to review" },
      "ready-for-review",
      undefined,
      "SAFE",
    ),
    {
      sequence: 15,
      timestamp: timestamp(15),
      actionType: "complete_discovery",
      sanitizedResult: {
        status: "VALIDATED",
        validation: { passed: true, checks: completionChecks },
      },
      resultingPageState: "ready-for-review",
      durationMs: 10,
    },
  ];
  return DiscoveryTrajectorySchema.parse({
    schemaVersion: "1.0.0",
    runId: FIXTURE_RUN_ID,
    capability: "prepare_savings_subaccount",
    sanitizedGoal: "Prepare the requested savings subaccount and stop at review.",
    inputs: [
      { name: "operator_username", description: "Sanitized input.", sensitive: false },
      { name: "portal_password", description: "Sanitized input.", sensitive: true },
      { name: "member_id", description: "Sanitized input.", sensitive: true },
      { name: "product_name", description: "Sanitized input.", sensitive: false },
      { name: "account_nickname", description: "Sanitized input.", sensitive: false },
      { name: "initial_deposit", description: "Sanitized input.", sensitive: true },
      { name: "funding_account", description: "Sanitized input.", sensitive: true },
    ],
    model: "sanitized-model-id",
    adapterVersion: "1.0.0",
    policyVersion: "1.0.0",
    startedAt: timestamp(0),
    endedAt: timestamp(16),
    finalStatus: "SUCCESS",
    events,
    finalObservation: {
      observationId: "00000000-0000-4000-8000-000000000016",
      url: "http://127.0.0.1/review",
      title: "Review",
      primaryHeading: "Review Savings Subaccount",
      pageState: "ready-for-review",
      visibleText: "[REDACTED:review] No account has been created.",
      elements: [
        {
          elementRef: "element-200",
          semanticTarget: { role: "button", accessibleName: "Open Account" },
          elementType: "button",
          availableOptions: [],
          disabled: false,
          controlOwner: "NONE",
          actionRisk: "IRREVERSIBLE",
          sensitive: false,
        },
      ],
      timestamp: timestamp(16),
    },
    completionValidation: { passed: true, checks: completionChecks },
    terminalReason: "Deterministic completion validation passed.",
  });
}

export type TrajectoryMutator = (trajectory: DiscoveryTrajectory) => void;

export async function writeDiscoveryEvidenceFixture(
  evidenceDiscoveryRoot: string,
  mutate?: TrajectoryMutator,
): Promise<string> {
  const trajectory = structuredClone(successfulTrajectoryFixture());
  mutate?.(trajectory);
  const runDirectory = path.join(evidenceDiscoveryRoot, trajectory.runId);
  await mkdir(runDirectory, { recursive: true });
  const trajectoryText = `${JSON.stringify(trajectory, null, 2)}\n`;
  const executedCount = trajectory.events.filter(
    (event) =>
      ["click_element", "fill_element_from_input", "select_option_from_input"].includes(
        event.actionType,
      ) && event.sanitizedResult.status === "EXECUTED",
  ).length;
  const summaryText = `${JSON.stringify(
    {
      runId: trajectory.runId,
      status: trajectory.finalStatus,
      actionCount: executedCount,
      finalPageState: trajectory.finalObservation?.pageState ?? "unknown",
    },
    null,
    2,
  )}\n`;
  const files = [
    {
      path: "summary.json",
      mediaType: "application/json",
      content: summaryText,
    },
    {
      path: "trajectory.json",
      mediaType: "application/json",
      content: trajectoryText,
    },
  ];
  for (const file of files) {
    await writeFile(path.join(runDirectory, file.path), file.content, "utf8");
  }
  const manifest = {
    schemaVersion: "1.0.0",
    runId: trajectory.runId,
    files: files.map(({ path: filePath, mediaType, content }) => ({
      path: filePath,
      mediaType,
      sha256: sha256(content),
      bytes: Buffer.byteLength(content),
    })),
  };
  await writeFile(
    path.join(runDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return runDirectory;
}
