import type {
  DiscoveryFailure,
  DiscoveryFailureCategory,
  DiscoveryFailureStage,
} from "./contracts.js";
import { StrictSchemaCompatibilityError } from "./strict-schema.js";

interface ErrorDetails {
  readonly status?: unknown;
  readonly code?: unknown;
  readonly type?: unknown;
  readonly param?: unknown;
  readonly message?: unknown;
  readonly name?: unknown;
  readonly constructor?: { readonly name?: unknown };
}

const MODEL_ERROR_CODES = new Set([
  "invalid_model",
  "model_access_denied",
  "model_not_available",
  "model_not_found",
  "unsupported_model",
]);

const SDK_ERROR_TYPES = new Set([
  "AgentsError",
  "APIConnectionError",
  "APIConnectionTimeoutError",
  "APIError",
  "APIUserAbortError",
  "BadRequestError",
  "InternalServerError",
  "OpenAIError",
  "SystemError",
  "UnprocessableEntityError",
  "UserError",
]);

const INVALID_OUTPUT_TYPES = new Set(["InvalidToolInputError", "ModelBehaviorError", "ZodError"]);

export class DiscoveryAgentOutputError extends Error {
  constructor(
    message: string,
    readonly stage: Extract<
      DiscoveryFailureStage,
      "PARSING_STRUCTURED_OUTPUT" | "BEFORE_FIRST_TOOL_CALL"
    >,
  ) {
    super(message);
    this.name = "DiscoveryAgentOutputError";
  }
}

function errorDetails(error: unknown): ErrorDetails {
  return typeof error === "object" && error !== null ? error : {};
}

function safeToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[a-zA-Z0-9_.:-]{1,100}$/.test(normalized) ? normalized : undefined;
}

const SAFE_API_SCHEMA_PARAM = new RegExp(
  "^(?:text\\.format(?:\\.schema)?|tools(?:\\[[0-5]\\]|\\.[0-5])\\.parameters)" +
    "(?:\\.(?:type|anyOf|allOf|not|if|then|else|required|additionalProperties|" +
    "\\$ref|\\$defs|items|properties\\.(?:status|summary|observationId|elementRef|inputRef|path)" +
    "(?:\\.(?:type|enum|format|pattern|minLength))?))?$",
);

function safeApiParam(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 180) return undefined;
  return SAFE_API_SCHEMA_PARAM.test(value) ? value : undefined;
}

function errorType(error: unknown, details: ErrorDetails): string {
  const constructorName = safeToken(details.constructor?.name);
  if (constructorName && constructorName !== "Object") return constructorName;
  return safeToken(details.name) ?? (error instanceof Error ? "Error" : "UnknownError");
}

function numericStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function looksLikeModelFailure(details: ErrorDetails, status: number | undefined): boolean {
  const code = safeToken(details.code)?.toLowerCase();
  if (code && MODEL_ERROR_CODES.has(code)) return true;
  const parameter = safeToken(details.param)?.toLowerCase();
  const message = typeof details.message === "string" ? details.message.toLowerCase() : "";
  return (
    (status === 400 || status === 403 || status === 404) &&
    (parameter === "model" ||
      (message.includes("model") &&
        /access|available|exist|found|permission|support/.test(message)))
  );
}

function categoryFor(
  error: unknown,
  details: ErrorDetails,
  type: string,
  status: number | undefined,
): DiscoveryFailureCategory {
  if (
    error instanceof StrictSchemaCompatibilityError ||
    safeToken(details.code)?.toLowerCase() === "invalid_json_schema"
  ) {
    return "INVALID_REQUEST_SCHEMA";
  }
  if (error instanceof DiscoveryAgentOutputError || INVALID_OUTPUT_TYPES.has(type)) {
    return "INVALID_AGENT_OUTPUT";
  }
  if (looksLikeModelFailure(details, status)) return "MODEL_UNAVAILABLE";
  if (status === 401 || status === 403) return "AUTHENTICATION_FAILED";
  if (status === 429) return "RATE_LIMITED";
  if (status !== undefined || SDK_ERROR_TYPES.has(type)) return "SDK_ERROR";
  return "INTERNAL_ERROR";
}

function stageFor(
  error: unknown,
  category: DiscoveryFailureCategory,
  type: string,
  status: number | undefined,
): DiscoveryFailureStage {
  if (error instanceof DiscoveryAgentOutputError) return error.stage;
  if (category === "INVALID_AGENT_OUTPUT") return "PARSING_STRUCTURED_OUTPUT";
  if (
    category === "AUTHENTICATION_FAILED" ||
    category === "MODEL_UNAVAILABLE" ||
    category === "RATE_LIMITED"
  ) {
    return "DURING_MODEL_REQUEST";
  }
  if (category === "INVALID_REQUEST_SCHEMA") {
    return error instanceof StrictSchemaCompatibilityError
      ? "BEFORE_MODEL_REQUEST"
      : "DURING_MODEL_REQUEST";
  }
  if (category === "SDK_ERROR") {
    return status !== undefined || /^(API|OpenAI|InternalServer)/.test(type)
      ? "DURING_MODEL_REQUEST"
      : "BEFORE_MODEL_REQUEST";
  }
  return "INTERNAL";
}

export function classifyDiscoveryFailure(error: unknown): DiscoveryFailure {
  const details = errorDetails(error);
  const status = numericStatus(details.status);
  const type = errorType(error, details);
  const category = categoryFor(error, details, type, status);
  const apiCode = safeToken(details.code);
  const apiType = safeToken(details.type);
  const apiParam = safeApiParam(details.param);
  return {
    category,
    stage: stageFor(error, category, type, status),
    errorType: type,
    ...(status === undefined ? {} : { apiStatus: status }),
    ...(apiCode ? { apiCode } : {}),
    ...(apiType ? { apiType } : {}),
    ...(apiParam ? { apiParam } : {}),
  };
}

export function formatDiscoveryTerminalReason(failure: DiscoveryFailure): string {
  const descriptions: Record<DiscoveryFailureCategory, string> = {
    AUTHENTICATION_FAILED: "OpenAI authentication or project access failed",
    MODEL_UNAVAILABLE: "The configured OpenAI model is unsupported or inaccessible",
    RATE_LIMITED: "The OpenAI request was rate limited",
    INVALID_REQUEST_SCHEMA: "A discovery request JSON schema was incompatible",
    SDK_ERROR: "The Agents SDK or OpenAI request failed",
    INVALID_AGENT_OUTPUT: "The discovery agent returned invalid output",
    INTERNAL_ERROR: "Discovery failed because of an internal application error",
  };
  const details = [
    `type ${failure.errorType}`,
    ...(failure.apiStatus === undefined ? [] : [`HTTP ${String(failure.apiStatus)}`]),
    ...(failure.apiType ? [`API type ${failure.apiType}`] : []),
    ...(failure.apiCode ? [`API code ${failure.apiCode}`] : []),
    ...(failure.apiParam ? [`API param ${failure.apiParam}`] : []),
  ];
  return `${failure.category}: ${descriptions[failure.category]} (${details.join(", ")}).`;
}
