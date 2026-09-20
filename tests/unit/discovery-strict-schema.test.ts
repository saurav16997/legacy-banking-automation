import { RunContext, tool } from "@openai/agents";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createDiscoverySdkTools,
  DISCOVERY_AGENT_OUTPUT_TYPE,
} from "../../src/discovery/agent-runner.js";
import { NavigateToolInputSchema } from "../../src/discovery/contracts.js";
import type { DiscoveryToolApi } from "../../src/discovery/tools.js";
import {
  assertDiscoveryRequestSchemasCompatible,
  assertOpenAIStrictSchema,
  StrictSchemaCompatibilityError,
} from "../../src/discovery/strict-schema.js";

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

describe("OpenAI strict discovery request schemas", () => {
  it("accepts the output schema and every generated tool parameter schema", () => {
    const tools = createDiscoverySdkTools(fakeToolApi());
    expect(tools.map(({ name }) => name)).toEqual([
      "observe_surface",
      "click_element",
      "fill_element_from_input",
      "select_option_from_input",
      "navigate_same_origin",
      "complete_discovery",
    ]);
    expect(() => {
      assertDiscoveryRequestSchemasCompatible(DISCOVERY_AGENT_OUTPUT_TYPE, tools);
    }).not.toThrow();
    expect(DISCOVERY_AGENT_OUTPUT_TYPE.schema).toMatchObject({
      type: "object",
      required: ["status", "summary"],
      additionalProperties: false,
    });
    expect(DISCOVERY_AGENT_OUTPUT_TYPE.schema).not.toHaveProperty("anyOf");
  });

  it("keeps empty-argument tools as closed objects with an empty required list", () => {
    const tools = createDiscoverySdkTools(fakeToolApi());
    for (const toolName of ["observe_surface", "complete_discovery"]) {
      const emptyTool = tools.find(({ name }) => name === toolName);
      expect(emptyTool?.parameters).toMatchObject({
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      });
    }
  });

  it.each(["fill_element_from_input", "select_option_from_input"])(
    "reproduces and locates the rejected minLength schema shape for %s",
    (toolName) => {
      const rejectedTool = tool({
        name: toolName,
        description: "rejected schema fixture",
        parameters: z.object({ inputRef: z.string().min(1) }).strict(),
        execute: () => Promise.resolve(""),
      });
      expect(() => {
        assertOpenAIStrictSchema(rejectedTool.name, rejectedTool.parameters);
      }).toThrow(
        new StrictSchemaCompatibilityError(
          toolName,
          "$.properties.inputRef.minLength",
          'unsupported keyword "minLength"',
        ),
      );
    },
  );

  it("retains stronger local Zod validation behind the minimal wire schema", async () => {
    let called = false;
    const api = fakeToolApi();
    api.click_element = () => {
      called = true;
      return Promise.resolve({});
    };
    const clickTool = createDiscoverySdkTools(api).find(({ name }) => name === "click_element");
    await expect(
      clickTool?.invoke(
        new RunContext(),
        JSON.stringify({ observationId: "not-a-uuid", elementRef: "not-an-element-ref" }),
      ),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("detects the previously missed navigation lookahead at its exact path", () => {
    const rejectedTool = tool({
      name: "navigate_same_origin",
      description: "previously transmitted navigation schema",
      parameters: NavigateToolInputSchema,
      execute: () => Promise.resolve(""),
    });
    expect(() => {
      assertOpenAIStrictSchema(rejectedTool.name, rejectedTool.parameters);
    }).toThrow(
      new StrictSchemaCompatibilityError(
        "navigate_same_origin",
        "$.properties.path.pattern",
        "regex lookahead and lookbehind are unsupported",
      ),
    );
  });

  it("keeps same-origin path validation local after removing the wire pattern", async () => {
    let called = false;
    const api = fakeToolApi();
    api.navigate_same_origin = () => {
      called = true;
      return Promise.resolve({});
    };
    const navigationTool = createDiscoverySdkTools(api).find(
      ({ name }) => name === "navigate_same_origin",
    );
    expect(navigationTool?.parameters).not.toHaveProperty("properties.path.pattern");
    await expect(
      navigationTool?.invoke(
        new RunContext(),
        JSON.stringify({ path: "https://outside.example/path" }),
      ),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("rejects a top-level union at a safe schema path", () => {
    expect(() => {
      assertOpenAIStrictSchema("agent_output", {
        type: "object",
        anyOf: [
          {
            type: "object",
            properties: { status: { const: "SUCCESS" } },
            required: ["status"],
            additionalProperties: false,
          },
        ],
        properties: {},
        required: [],
        additionalProperties: false,
      });
    }).toThrow(
      new StrictSchemaCompatibilityError(
        "agent_output",
        "$.anyOf",
        "root schema must not be a union",
      ),
    );
  });

  it.each([
    {
      name: "open object",
      schema: { type: "object", properties: {}, required: [] },
      path: "$.additionalProperties",
    },
    {
      name: "optional property",
      schema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: [],
        additionalProperties: false,
      },
      path: "$.properties.summary",
    },
  ])("rejects $name at a safe JSON path", ({ schema, path }) => {
    let error: unknown;
    try {
      assertOpenAIStrictSchema("fixture", schema);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(StrictSchemaCompatibilityError);
    expect(error).toMatchObject({ schemaName: "fixture", jsonPath: path });
  });
});
