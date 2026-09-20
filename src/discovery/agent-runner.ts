import {
  Agent,
  MaxTurnsExceededError,
  ToolCallError,
  run,
  setTracingDisabled,
  tool,
  type FunctionTool,
  type JsonSchemaDefinition,
} from "@openai/agents";

import {
  CompleteDiscoveryInputSchema,
  DiscoveryAgentFinalOutputSchema,
  ElementToolInputSchema,
  InputElementToolInputSchema,
  InputElementToolParameterSchema,
  NavigateToolInputSchema,
  NavigateToolParameterSchema,
  ObserveSurfaceInputSchema,
  type DiscoveryAgentFinalOutput,
  type DiscoveryInputDefinition,
} from "./contracts.js";
import { DiscoveryAgentOutputError } from "./failure.js";
import { assertDiscoveryRequestSchemasCompatible } from "./strict-schema.js";
import { DiscoveryStopError, type DiscoveryToolApi } from "./tools.js";

export const DISCOVERY_INSTRUCTIONS = `You are the sole probabilistic discovery agent for prepare_savings_subaccount.
Work only from the latest SurfaceObservation returned by the tools.
Use only current observationId and elementRef values; never reuse stale references.
Use named task inputs only through inputRef. Never ask for or embed underlying input values.
Never invent selectors, XPath, JavaScript, or URLs. Navigation accepts only same-origin paths.
Never automate HUMAN-owned controls. Never interact with NONE-owned or IRREVERSIBLE controls.
Stop at the ready-for-review page and never click Open Account.
If a tool returns HANDOFF_REQUIRED, stop. If a tool returns BLOCKED, do not bypass policy.
Call complete_discovery only after reaching the requested review outcome.
Success is determined by local validation, not by your reasoning or final claim.`;

export interface DiscoveryAgentRunRequest {
  readonly model: string;
  readonly sanitizedGoal: string;
  readonly inputDefinitions: readonly DiscoveryInputDefinition[];
  readonly tools: DiscoveryToolApi;
  readonly maxTurns: number;
  readonly signal: AbortSignal;
}

export interface DiscoveryAgentRunner {
  run(request: DiscoveryAgentRunRequest): Promise<DiscoveryAgentFinalOutput>;
}

export class AgentTurnLimitError extends Error {
  constructor() {
    super("Maximum model turns reached.");
    this.name = "AgentTurnLimitError";
  }
}

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

export const DISCOVERY_AGENT_OUTPUT_TYPE: JsonSchemaDefinition = {
  type: "json_schema",
  name: "discovery_agent_final_output",
  strict: true,
  schema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["SUCCESS", "HANDOFF_REQUIRED", "BLOCKED", "FAILED"],
      },
      summary: { type: "string" },
    },
    required: ["status", "summary"],
    additionalProperties: false,
  },
};

export function createDiscoverySdkTools(api: DiscoveryToolApi): FunctionTool[] {
  return [
    tool({
      name: "observe_surface",
      description: "Return a fresh sanitized observation of the current browser surface.",
      parameters: ObserveSurfaceInputSchema,
      errorFunction: null,
      execute: async () => serialize(await api.observe_surface()),
    }),
    tool({
      name: "click_element",
      description: "Click one element from the latest observation using its ephemeral reference.",
      parameters: ElementToolInputSchema,
      errorFunction: null,
      execute: async (input: unknown) =>
        serialize(await api.click_element(ElementToolInputSchema.parse(input))),
    }),
    tool({
      name: "fill_element_from_input",
      description: "Fill an element using a named input reference resolved only by local code.",
      parameters: InputElementToolParameterSchema,
      errorFunction: null,
      execute: async (input: unknown) =>
        serialize(await api.fill_element_from_input(InputElementToolInputSchema.parse(input))),
    }),
    tool({
      name: "select_option_from_input",
      description: "Select an option using a named input reference resolved only by local code.",
      parameters: InputElementToolParameterSchema,
      errorFunction: null,
      execute: async (input: unknown) =>
        serialize(await api.select_option_from_input(InputElementToolInputSchema.parse(input))),
    }),
    tool({
      name: "navigate_same_origin",
      description: "Navigate to an allowed same-origin absolute path.",
      parameters: NavigateToolParameterSchema,
      errorFunction: null,
      execute: async (input: unknown) =>
        serialize(await api.navigate_same_origin(NavigateToolInputSchema.parse(input))),
    }),
    tool({
      name: "complete_discovery",
      description: "Request deterministic local validation of the current review state.",
      parameters: CompleteDiscoveryInputSchema,
      errorFunction: null,
      execute: async () => serialize(await api.complete_discovery()),
    }),
  ];
}

export class OpenAIAgentsDiscoveryRunner implements DiscoveryAgentRunner {
  async run(request: DiscoveryAgentRunRequest): Promise<DiscoveryAgentFinalOutput> {
    setTracingDisabled(true);
    const sdkTools = createDiscoverySdkTools(request.tools);
    assertDiscoveryRequestSchemasCompatible(DISCOVERY_AGENT_OUTPUT_TYPE, sdkTools);
    const agent = new Agent({
      name: "Savings subaccount discovery agent",
      model: request.model,
      instructions: DISCOVERY_INSTRUCTIONS,
      tools: sdkTools,
      outputType: DISCOVERY_AGENT_OUTPUT_TYPE,
    });
    const prompt = [
      request.sanitizedGoal,
      "Available named inputs (definitions only; values are held by the local vault):",
      JSON.stringify(request.inputDefinitions),
      "Begin by observing the surface.",
    ].join("\n");
    try {
      const result = await run(agent, prompt, {
        maxTurns: request.maxTurns,
        signal: request.signal,
      });
      if (!result.finalOutput) {
        throw new DiscoveryAgentOutputError(
          "The discovery agent returned no structured output.",
          "PARSING_STRUCTURED_OUTPUT",
        );
      }
      return DiscoveryAgentFinalOutputSchema.parse(result.finalOutput);
    } catch (error) {
      if (error instanceof MaxTurnsExceededError) throw new AgentTurnLimitError();
      if (error instanceof ToolCallError && error.error instanceof DiscoveryStopError) {
        throw error.error;
      }
      throw error;
    }
  }
}
