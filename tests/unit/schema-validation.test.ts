import { Ajv2020, type AnySchema } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("capability artifact schema", () => {
  it("is the valid canonical v1 schema", async () => {
    const schemaText = await readFile(
      `${projectRoot}schemas/capability-artifact.v1.schema.json`,
      "utf8",
    );
    const schema: unknown = JSON.parse(schemaText);
    const ajv = new Ajv2020({ strict: true });
    addFormatsModule.default(ajv);
    expect(() => ajv.compile(schema as AnySchema)).not.toThrow();
  });
});
