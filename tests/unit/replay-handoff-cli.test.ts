import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  parseHandoffReplayArguments,
  waitForTerminalAcknowledgement,
} from "../../src/cli/replay-prepare-handoff.js";

describe("resumable replay CLI boundary", () => {
  it("uses a task-specific Windows-safe command with an explicit DRAFT override", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["replay:prepare:handoff"]).toBe(
      "npm run build --silent && node dist/src/cli/replay-prepare-handoff.js --allow-draft",
    );
    expect(parseHandoffReplayArguments(["--allow-draft"])).toEqual({
      allowDraft: true,
      help: false,
    });
  });

  it("ignores non-empty stdin and accepts only an empty-line acknowledgement", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const signals = new EventEmitter();
    let written = "";
    output.on("data", (chunk: Buffer) => {
      written += chunk.toString("utf8");
    });
    const waiting = waitForTerminalAcknowledgement({
      expiresAtMs: 1_000,
      now: () => 0,
      input,
      output,
      signalSource: signals,
    });
    input.write("not-an-accepted-code\n");
    input.write("\n");

    await expect(waiting).resolves.toBe("ACKNOWLEDGED");
    expect(written).toContain("Terminal input was ignored");
  });

  it("returns EOF and SIGNAL as explicit abandonment reasons", async () => {
    const eofInput = new PassThrough();
    const eofWaiting = waitForTerminalAcknowledgement({
      expiresAtMs: 1_000,
      now: () => 0,
      input: eofInput,
      output: new PassThrough(),
      signalSource: new EventEmitter(),
    });
    eofInput.end();
    await expect(eofWaiting).resolves.toBe("EOF");

    const signalInput = new PassThrough();
    const signals = new EventEmitter();
    const signalWaiting = waitForTerminalAcknowledgement({
      expiresAtMs: 1_000,
      now: () => 0,
      input: signalInput,
      output: new PassThrough(),
      signalSource: signals,
    });
    signals.emit("SIGINT");
    await expect(signalWaiting).resolves.toBe("SIGNAL");
  });

  it("expires without reading terminal input when the TTL has elapsed", async () => {
    await expect(waitForTerminalAcknowledgement({ expiresAtMs: 99, now: () => 100 })).resolves.toBe(
      "EXPIRED",
    );
  });
});
