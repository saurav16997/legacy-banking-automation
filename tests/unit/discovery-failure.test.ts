import { describe, expect, it } from "vitest";
import { ModelBehaviorError, UserError } from "@openai/agents";
import { BadRequestError } from "openai";

import {
  classifyDiscoveryFailure,
  DiscoveryAgentOutputError,
  formatDiscoveryTerminalReason,
} from "../../src/discovery/failure.js";
import { StrictSchemaCompatibilityError } from "../../src/discovery/strict-schema.js";

class FakeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly type: string | undefined,
    readonly param?: string,
  ) {
    super("provider detail that must not be persisted");
  }
}

describe("sanitized discovery failure classification", () => {
  it.each([
    {
      error: new FakeApiError(401, "invalid_api_key", "invalid_request_error"),
      category: "AUTHENTICATION_FAILED",
    },
    {
      error: new FakeApiError(404, "model_not_found", "invalid_request_error", "model"),
      category: "MODEL_UNAVAILABLE",
    },
    {
      error: new FakeApiError(429, "rate_limit_exceeded", "requests"),
      category: "RATE_LIMITED",
    },
    {
      error: new FakeApiError(400, "invalid_json_schema", "invalid_request_error"),
      category: "INVALID_REQUEST_SCHEMA",
    },
  ] as const)("classifies $category API failures", ({ error, category }) => {
    const failure = classifyDiscoveryFailure(error);
    expect(failure).toMatchObject({
      category,
      stage: "DURING_MODEL_REQUEST",
      errorType: "FakeApiError",
      apiStatus: error.status,
      apiCode: error.code,
      apiType: error.type,
    });
    expect(formatDiscoveryTerminalReason(failure)).not.toContain(error.message);
  });

  it("classifies SDK compatibility errors before a request", () => {
    const error = new UserError("schema conversion detail");
    expect(classifyDiscoveryFailure(error)).toEqual({
      category: "SDK_ERROR",
      stage: "BEFORE_MODEL_REQUEST",
      errorType: "UserError",
    });
  });

  it("classifies local strict-schema preflight failures before a request", () => {
    const error = new StrictSchemaCompatibilityError(
      "safe_schema_name",
      "$.properties.field",
      "fixture",
    );
    expect(classifyDiscoveryFailure(error)).toEqual({
      category: "INVALID_REQUEST_SCHEMA",
      stage: "BEFORE_MODEL_REQUEST",
      errorType: "StrictSchemaCompatibilityError",
    });
  });

  it("captures only an allowlisted schema-location apiParam", () => {
    const error = new BadRequestError(
      400,
      {
        message: "provider message containing api-key-secret",
        code: "invalid_json_schema",
        type: "invalid_request_error",
        param: "tools[4].parameters.properties.path.pattern",
      },
      undefined,
      new Headers(),
    );
    const failure = classifyDiscoveryFailure(error);
    expect(failure).toMatchObject({
      category: "INVALID_REQUEST_SCHEMA",
      errorType: "BadRequestError",
      apiStatus: 400,
      apiCode: "invalid_json_schema",
      apiType: "invalid_request_error",
      apiParam: "tools[4].parameters.properties.path.pattern",
    });
    expect(formatDiscoveryTerminalReason(failure)).not.toContain("api-key-secret");
  });

  it.each([
    "api-key-secret",
    "tools[4].parameters.properties.path.pattern;api-key-secret",
    "tools[4].parameters.properties.portal_password.pattern",
  ])("drops unsafe apiParam text: %s", (param) => {
    const error = new FakeApiError(400, "invalid_json_schema", "invalid_request_error", param);
    const failure = classifyDiscoveryFailure(error);
    expect(failure).not.toHaveProperty("apiParam");
    expect(formatDiscoveryTerminalReason(failure)).not.toContain(param);
  });

  it("classifies structured-output parsing errors", () => {
    const error = new ModelBehaviorError("invalid output detail");
    expect(classifyDiscoveryFailure(error)).toEqual({
      category: "INVALID_AGENT_OUTPUT",
      stage: "PARSING_STRUCTURED_OUTPUT",
      errorType: "ModelBehaviorError",
    });
  });

  it("classifies an agent return before its first tool call", () => {
    const failure = classifyDiscoveryFailure(
      new DiscoveryAgentOutputError(
        "The discovery agent returned before calling a tool.",
        "BEFORE_FIRST_TOOL_CALL",
      ),
    );
    expect(failure).toEqual({
      category: "INVALID_AGENT_OUTPUT",
      stage: "BEFORE_FIRST_TOOL_CALL",
      errorType: "DiscoveryAgentOutputError",
    });
  });

  it("uses INTERNAL_ERROR for an unexpected application exception", () => {
    expect(classifyDiscoveryFailure(new TypeError("unexpected"))).toEqual({
      category: "INTERNAL_ERROR",
      stage: "INTERNAL",
      errorType: "TypeError",
    });
  });
});
