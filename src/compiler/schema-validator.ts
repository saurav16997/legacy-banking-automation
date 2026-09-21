import { readFile } from "node:fs/promises";

import { Ajv2020, type AnySchema, type ErrorObject } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import type { CapabilityArtifact } from "./contracts.js";
import { CapabilityCompilerError } from "./contracts.js";

function safeValidationLocation(error: ErrorObject | undefined): string {
  if (!error) return "$";
  const path = error.instancePath || "$";
  return `${path}:${error.keyword}`;
}

export async function validateCapabilityArtifact(
  artifact: CapabilityArtifact,
  schemaPath: string,
): Promise<void> {
  let schema: unknown;
  try {
    schema = JSON.parse(await readFile(schemaPath, "utf8"));
  } catch {
    throw new CapabilityCompilerError(
      "ARTIFACT_SCHEMA_INVALID",
      "The canonical capability schema could not be loaded.",
    );
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormatsModule.default(ajv);
  let validate;
  try {
    validate = ajv.compile(schema as AnySchema);
  } catch {
    throw new CapabilityCompilerError(
      "ARTIFACT_SCHEMA_INVALID",
      "The canonical capability schema is invalid.",
    );
  }
  if (!validate(artifact)) {
    throw new CapabilityCompilerError(
      "ARTIFACT_SCHEMA_INVALID",
      `The compiled artifact failed schema validation at ${safeValidationLocation(validate.errors?.[0])}.`,
    );
  }
}
