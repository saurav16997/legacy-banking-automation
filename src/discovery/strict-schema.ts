import type { FunctionTool, JsonSchemaDefinition } from "@openai/agents";

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$defs",
  "$ref",
  "$schema",
  "additionalProperties",
  "anyOf",
  "const",
  "description",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "items",
  "maxItems",
  "maximum",
  "minItems",
  "minimum",
  "multipleOf",
  "pattern",
  "properties",
  "required",
  "title",
  "type",
]);

type JsonRecord = Record<string, unknown>;

export class StrictSchemaCompatibilityError extends Error {
  constructor(
    readonly schemaName: string,
    readonly jsonPath: string,
    detail: string,
  ) {
    super(`Strict schema "${schemaName}" is incompatible at ${jsonPath}: ${detail}.`);
    this.name = "StrictSchemaCompatibilityError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(schemaName: string, jsonPath: string, detail: string): never {
  throw new StrictSchemaCompatibilityError(schemaName, jsonPath, detail);
}

function objectTypeIncludes(schema: JsonRecord, expected: string): boolean {
  const { type } = schema;
  return type === expected || (Array.isArray(type) && type.includes(expected));
}

function validateObjectShape(schemaName: string, schema: JsonRecord, jsonPath: string): void {
  if (!objectTypeIncludes(schema, "object")) return;
  if (schema.additionalProperties !== false) {
    fail(schemaName, `${jsonPath}.additionalProperties`, "object schemas must set false");
  }
  if (!isRecord(schema.properties)) {
    fail(schemaName, `${jsonPath}.properties`, "object schemas must declare properties");
  }
  if (
    !Array.isArray(schema.required) ||
    !schema.required.every((value) => typeof value === "string")
  ) {
    fail(schemaName, `${jsonPath}.required`, "required must be an array of property names");
  }
  const propertyNames = Object.keys(schema.properties);
  const required = new Set(schema.required);
  for (const propertyName of propertyNames) {
    if (!required.has(propertyName)) {
      fail(
        schemaName,
        `${jsonPath}.properties.${propertyName}`,
        "every property must be required; use a required nullable field when optional",
      );
    }
  }
  for (const requiredName of required) {
    if (!Object.hasOwn(schema.properties, requiredName)) {
      fail(schemaName, `${jsonPath}.required`, `undeclared property "${requiredName}" is required`);
    }
  }
}

function validateNode(schemaName: string, schema: unknown, jsonPath: string): void {
  if (!isRecord(schema)) fail(schemaName, jsonPath, "schema nodes must be objects");
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) {
      fail(schemaName, `${jsonPath}.${keyword}`, `unsupported keyword "${keyword}"`);
    }
  }
  validateObjectShape(schemaName, schema, jsonPath);
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") {
      fail(schemaName, `${jsonPath}.pattern`, "pattern must be a string");
    }
    if (/\(\?(?:[=!]|<[=!])/.test(schema.pattern)) {
      fail(schemaName, `${jsonPath}.pattern`, "regex lookahead and lookbehind are unsupported");
    }
  }

  if (isRecord(schema.properties)) {
    for (const [propertyName, propertySchema] of Object.entries(schema.properties)) {
      validateNode(schemaName, propertySchema, `${jsonPath}.properties.${propertyName}`);
    }
  }
  if (Array.isArray(schema.anyOf)) {
    schema.anyOf.forEach((branch, index) => {
      validateNode(schemaName, branch, `${jsonPath}.anyOf[${String(index)}]`);
    });
  }
  if (isRecord(schema.items)) validateNode(schemaName, schema.items, `${jsonPath}.items`);
  if (isRecord(schema.$defs)) {
    for (const [definitionName, definitionSchema] of Object.entries(schema.$defs)) {
      validateNode(schemaName, definitionSchema, `${jsonPath}.$defs.${definitionName}`);
    }
  }
}

export function assertOpenAIStrictSchema(schemaName: string, schema: unknown): void {
  if (!isRecord(schema)) fail(schemaName, "$", "root schema must be an object");
  if (schema.anyOf !== undefined) {
    fail(schemaName, "$.anyOf", "root schema must not be a union");
  }
  if (schema.type !== "object") {
    fail(schemaName, "$.type", 'root schema must have type "object"');
  }
  validateNode(schemaName, schema, "$");
}

export function assertDiscoveryRequestSchemasCompatible(
  outputType: JsonSchemaDefinition,
  tools: readonly FunctionTool[],
): void {
  if (!outputType.strict) {
    fail(outputType.name, "$.strict", "agent output schema must use strict mode");
  }
  assertOpenAIStrictSchema(outputType.name, outputType.schema);
  for (const discoveryTool of tools) {
    if (!discoveryTool.strict) {
      fail(discoveryTool.name, "$.strict", "tool parameter schema must use strict mode");
    }
    assertOpenAIStrictSchema(discoveryTool.name, discoveryTool.parameters);
  }
}
