import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { parseReplayArguments, readReplayInputs } from "../../src/cli/replay-prepare.js";

describe("replay CLI", () => {
  it("provides generic and task-specific Windows-safe scripts", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["replay:prepare"]).toBe(
      "npm run build --silent && node dist/src/cli/replay-prepare.js",
    );
    expect(packageJson.scripts?.["replay:prepare:demo"]).toBe(
      "npm run build --silent && node dist/src/cli/replay-prepare.js --allow-draft",
    );
    expect(packageJson.scripts?.["replay:prepare:demo:headed"]).toBe(
      "npm run build --silent && node dist/src/cli/replay-prepare.js --allow-draft --headed",
    );
  });

  it("parses supported direct flags and rejects unknown options", () => {
    expect(parseReplayArguments(["--allow-draft", "--headed"])).toEqual({
      allowDraft: true,
      headed: true,
      help: false,
    });
    expect(() => parseReplayArguments(["--unknown"])).toThrow("Unknown replay option: --unknown");
  });

  it("requires only the target URL and password while naming every optional replay override", () => {
    const inputs = readReplayInputs({
      TARGET_BASE_URL: "http://127.0.0.1:3000",
      PORTAL_PASSWORD: "synthetic-password",
      REPLAY_OPERATOR_USERNAME: "synthetic-operator",
      REPLAY_MEMBER_ID: "M-20017",
      REPLAY_PRODUCT_NAME: "Synthetic Product",
      REPLAY_ACCOUNT_NICKNAME: "Synthetic Nickname",
      REPLAY_INITIAL_DEPOSIT: "10.00",
      REPLAY_FUNDING_ACCOUNT: "Synthetic Funding Account",
    });

    expect(inputs).toEqual({
      operator_username: "synthetic-operator",
      portal_password: "synthetic-password",
      member_id: "M-20017",
      product_name: "Synthetic Product",
      account_nickname: "Synthetic Nickname",
      initial_deposit: "10.00",
      funding_account: "Synthetic Funding Account",
    });
  });
});
