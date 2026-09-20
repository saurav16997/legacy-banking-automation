import OpenAI from "openai";
import { setDefaultOpenAIClient, type JsonSchemaDefinition } from "@openai/agents";
import { describe, expect, it, vi } from "vitest";

import {
  createDiscoverySdkTools,
  DISCOVERY_AGENT_OUTPUT_TYPE,
  OpenAIAgentsDiscoveryRunner,
} from "../../src/discovery/agent-runner.js";
import { assertOpenAIStrictSchema } from "../../src/discovery/strict-schema.js";
import type { DiscoveryToolApi } from "../../src/discovery/tools.js";

interface SerializedFunctionTool {
  readonly type: "function";
  readonly name: string;
  readonly strict: boolean;
  readonly parameters: unknown;
}

interface SerializedResponsesRequest {
  readonly text?: { readonly format?: JsonSchemaDefinition };
  readonly tools?: readonly SerializedFunctionTool[];
}

function fakeToolApi(): DiscoveryToolApi {
  return {
    observe_surface: () => Promise.resolve({}),
    click_element: () => Promise.resolve({}),
    fill_element_from_input: () => Promise.resolve({}),
    select_option_from_input: () => Promise.resolve({}),
    navigate_same_origin: () => Promise.resolve({}),
    complete_discovery: () => Promise.resolve({}),
  };
}

describe("serialized discovery request", () => {
  it("captures and validates the real Responses request without network access", async () => {
    let capturedBody: SerializedResponsesRequest | undefined;
    let transportCalls = 0;
    const globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Network access is forbidden in this test.");
    });
    const captureFetch: typeof fetch = async (input, init) => {
      transportCalls += 1;
      const body =
        typeof init?.body === "string"
          ? init.body
          : input instanceof Request
            ? await input.clone().text()
            : undefined;
      if (!body) throw new Error("The offline transport received no request body.");
      capturedBody = JSON.parse(body) as SerializedResponsesRequest;
      throw new Error("OFFLINE_CAPTURE_STOP");
    };
    const offlineClient = new OpenAI({
      apiKey: "offline-test-key",
      maxRetries: 0,
      fetch: captureFetch,
    });
    setDefaultOpenAIClient(
      offlineClient as unknown as Parameters<typeof setDefaultOpenAIClient>[0],
    );

    const api = fakeToolApi();
    let runnerError: unknown;
    try {
      await new OpenAIAgentsDiscoveryRunner().run({
        model: "offline-capture-model",
        sanitizedGoal: "Capture schemas without network access.",
        inputDefinitions: [],
        tools: api,
        maxTurns: 1,
        signal: new AbortController().signal,
      });
    } catch (error) {
      runnerError = error;
    } finally {
      globalFetch.mockRestore();
    }

    expect(runnerError).toBeInstanceOf(Error);
    expect(transportCalls).toBe(1);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(capturedBody).toBeDefined();

    const outputFormat = capturedBody?.text?.format;
    expect(outputFormat).toEqual(DISCOVERY_AGENT_OUTPUT_TYPE);
    if (!outputFormat) throw new Error("Missing captured output format.");
    assertOpenAIStrictSchema(outputFormat.name, outputFormat.schema);

    const transmittedTools = capturedBody?.tools ?? [];
    const sdkTools = createDiscoverySdkTools(api);
    expect(transmittedTools.map(({ name }) => name)).toEqual(sdkTools.map(({ name }) => name));
    expect(transmittedTools.map(({ parameters }) => parameters)).toEqual(
      sdkTools.map(({ parameters }) => parameters),
    );
    for (const transmittedTool of transmittedTools) {
      expect(transmittedTool.type).toBe("function");
      expect(transmittedTool.strict).toBe(true);
      assertOpenAIStrictSchema(transmittedTool.name, transmittedTool.parameters);
    }
  });
});
